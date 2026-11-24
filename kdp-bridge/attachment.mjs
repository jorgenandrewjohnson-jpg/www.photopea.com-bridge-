import {createHash} from 'node:crypto';
import {mkdtemp,open,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Writable} from 'node:stream';
import {REMOTE_CHUNK_BYTES,REMOTE_MAX_BYTES,STREAM_CHUNK_BYTES,validateRemoteManifest} from './extension/remote-policy.js';

export function attachmentSource(value) {
  const url=new URL(value);
  if (url.protocol!=='https:' || url.username || url.password || url.port || url.hash ||
      !url.hostname.endsWith('.oaiusercontent.com') || !url.search)
    throw Error('A temporary signed OpenAI attachment download URL is required');
  return url;
}

export function createAttachmentReceiver(browser,fetchFile=fetch) {
  let busy=false;
  return async function stageAttachment({file,name,tab_id,edition,edition_id,kind}) {
    if (busy) throw Error('Another attachment is in progress');
    const url=attachmentSource(file.download_url);
    const page=(await browser.call('tabs',{})).find(tab=>tab.tab_id===tab_id);
    const manifest={tab_id,edition,edition_id,kind,name:name || file.file_name};
    // Reject an unsupported format or a different edition before reading private bytes.
    validateRemoteManifest({...manifest,size:1,sha256:'0'.repeat(64)},page);
    if (busy) throw Error('Another attachment is in progress');
    busy=true;
    let directory,handle;
    try {
      directory=await mkdtemp(join(tmpdir(),'kdp-attachment-'));
      const path=join(directory,'incoming');
      handle=await open(path,'wx+',0o600);
      // Anonymous temporary storage is reclaimed by the OS even on process termination.
      await unlink(path);
      const response=await fetchFile(url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(300000)});
      if (!response.ok || !response.body) throw Error('Attachment unavailable or expired');
      const declared=response.headers.get('content-length');
      if (declared!==null && Number(declared)>REMOTE_MAX_BYTES) throw Error('Attachment exceeds 250 MiB');
      const digest=createHash('sha256');
      let size=0;
      const writer=new Writable({write(chunk,_encoding,done){
        size+=chunk.length;
        if(size>REMOTE_MAX_BYTES) return done(Error('Attachment exceeds 250 MiB'));
        digest.update(chunk);
        handle.writeFile(chunk).then(()=>done(),done);
      }});
      await pipeline(response.body,writer);
      if (!size || (declared!==null && Number(declared)!==size)) throw Error('Incomplete attachment');
      const sha256=digest.digest('hex');
      const ticket=await browser.call('receive_file',{action:'begin',...manifest,size,sha256});
      const transfer=ticket.transfer_id;
      const chunk=ticket.stream_chunk_bytes===STREAM_CHUNK_BYTES?STREAM_CHUNK_BYTES:REMOTE_CHUNK_BYTES;
      const block=Buffer.alloc(chunk);
      let index=ticket.next_index || 0;
      for(let offset=ticket.received || 0;offset<size;) {
        const {bytesRead}=await handle.read(block,0,Math.min(chunk,size-offset),offset);
        if (!bytesRead) throw Error('Temporary attachment incomplete');
        await browser.call('receive_file',{action:'append',transfer_id:transfer,index:index++,
          data_base64:block.subarray(0,bytesRead).toString('base64')});
        offset+=bytesRead;
      }
      const receipt=await browser.call('receive_file',{action:'commit',transfer_id:transfer});
      if(receipt.sha256!==sha256 || receipt.size!==size || receipt.edition_id!==edition_id ||
         receipt.edition!==edition || receipt.kind!==kind || receipt.filename!==manifest.name || !receipt.file_id)
        throw Error('Staging receipt mismatch. Inspect staged files before retrying');
      return receipt;
    } finally {
      try {
        // The edition-bound partial remains resumable until Brave expires it.
        await handle?.close();
        if(directory) await rm(directory,{recursive:true,force:true});
      } finally { busy=false; }
    }
  };
}
