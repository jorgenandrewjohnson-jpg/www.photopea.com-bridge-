// One-use, owner-authorized PDF ingress for a client that already possesses
// approved export bytes. No remote fetching, public URLs or persistent files.
// The PDF is streamed to the paired Brave extension in bounded chunks.
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';

const CHUNK = 24 * 1024;
const TTL = 20 * 60 * 1000;
const LIMIT = 250 * 1024 * 1024;

function sameSecret(a,b) {
  if (typeof a!=='string' || typeof b!=='string') return false;
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length && timingSafeEqual(x,y);
}
export function createTransferIngress({origin,dispatch}) {
  const sessions=new Map();
  async function prepare(a) {
    if(a.action!=='begin' || !Number.isSafeInteger(a.size) ||
       a.size<=0 || a.size>LIMIT) throw Error('A valid begin transfer is required');
    for(const [id,session] of sessions) if(Date.now()>session.expires) sessions.delete(id);
    if(sessions.size>=3) throw Error('Too many unfinished PDF transfers');
    const result=await dispatch('receive_file',a);
    const id=randomUUID(),token=randomBytes(32).toString('base64url');
    sessions.set(id,{token,transfer_id:result.transfer_id,size:a.size,expires:Date.now()+TTL});
    return {...result,
      upload_url:origin+'/file-transfer/'+id,
      header_name:'X-KDP-Transfer-Token',upload_token:token,
      method:'POST',content_type:'application/pdf',expires_in_seconds:Math.floor(TTL/1000)};
  }
  async function handle(req,res,url) {
    const id=url.pathname.slice('/file-transfer/'.length);
    const session=sessions.get(id);
    if(req.method!=='POST' || !session || Date.now()>session.expires ||
       !sameSecret(req.headers['x-kdp-transfer-token'],session.token)) {
      res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({error:'unavailable_or_unauthorized'}));return;
    }
    // Single-use: an uncertain partially received PDF must never be replayed.
    sessions.delete(id);
    let index=0,total=0,carry=Buffer.alloc(0);
    const errorReply=()=>{
      if(!res.headersSent){
        res.writeHead(422,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify({error:'transfer_failed_or_unverified'}));
      }
    };
    try {
      if(!/^application\/pdf(?:\s*;|$)/i.test(req.headers['content-type']||''))
        throw Error('Content-Type must be application/pdf');
      const length=req.headers['content-length'];
      if(length && Number(length)!==session.size)
        throw Error('Incorrect Content-Length');
      for await (const chunk of req) {
        if(total+chunk.length>session.size) throw Error('Oversized PDF stream');
        total+=chunk.length;
        carry=Buffer.concat([carry,chunk]);
        while(carry.length>=CHUNK){
          await dispatch('receive_file',{
            action:'append',transfer_id:session.transfer_id,index:index++,
            data_base64:carry.subarray(0,CHUNK).toString('base64')
          });
          carry=carry.subarray(CHUNK);
        }
      }
      if(total!==session.size) throw Error('Incomplete PDF');
      if(carry.length) await dispatch('receive_file',{
        action:'append',transfer_id:session.transfer_id,index:index++,
        data_base64:carry.toString('base64')
      });
      const result=await dispatch('receive_file',{
        action:'commit',transfer_id:session.transfer_id
      });
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({status:'staged_in_brave_not_uploaded',...result}));
    } catch {
      await dispatch('receive_file',{
        action:'abort',transfer_id:session.transfer_id
      }).catch(()=>{});
      errorReply();
    }
  }
  // Transfer an approved ChatGPT-file snapshot via a short-lived, signed
  // OpenAI file URL. This runs entirely inside the authenticated MCP session;
  // no Mac helper, open proxy, public Drive share, or Render storage is used.
  async function pull(a) {
    if(a.action!=='append' || a.index!==0 ||
       typeof a.data_base64!=='string' ||
       !a.data_base64.startsWith('oaisignedurl1:'))
      throw Error('Invalid signed PDF import request');
    const match=[...sessions.entries()].find(([,s])=>s.transfer_id===a.transfer_id);
    if(!match || Date.now()>match[1].expires)
      throw Error('PDF receipt has expired or was not prepared');
    const [sessionId,session]=match;
    const text=a.data_base64.slice('oaisignedurl1:'.length);
    if(text.length<50 || text.length>2400)
      throw Error('Invalid signed source length');
    let url;
    try {url=new URL(text);} catch {throw Error('Invalid signed source URL');}
    // A strict host/path allowlist prevents the bridge from serving as an
    // arbitrary URL fetcher or reaching private networks.
    if(url.protocol!=='https:' ||
       url.hostname!=='sdmntprnorthcentralus.oaiusercontent.com' ||
       url.port || url.username || url.password ||
       !/^\/files\/[a-f0-9-]{36}\/raw$/.test(url.pathname) ||
       !url.search)
      throw Error('Signed source is outside the approved file host');
    sessions.delete(sessionId); // One use, including on failure.
    const aborter=new AbortController();
    const timer=setTimeout(()=>aborter.abort(),180000);
    let index=0,total=0,carry=Buffer.alloc(0);
    try {
      const response=await fetch(url,{redirect:'error',signal:aborter.signal,cache:'no-store'});
      if(!response.ok || !response.body)
        throw Error('Approved source could not be retrieved');
      const declared=response.headers.get('content-length');
      if(declared && Number(declared)!==session.size)
        throw Error('Source byte length does not match the approved PDF');
      for await(const chunk of response.body) {
        if(total+chunk.length>session.size)
          throw Error('Source PDF exceeds approved size');
        total+=chunk.length;
        carry=Buffer.concat([carry,Buffer.from(chunk)]);
        while(carry.length>=CHUNK) {
          await dispatch('receive_file',{
            action:'append',transfer_id:session.transfer_id,
            index:index++,data_base64:carry.subarray(0,CHUNK).toString('base64')
          });
          carry=carry.subarray(CHUNK);
        }
      }
      if(total!==session.size) throw Error('Source PDF was incomplete');
      if(carry.length) await dispatch('receive_file',{
        action:'append',transfer_id:session.transfer_id,
        index:index++,data_base64:carry.toString('base64')
      });
      const result=await dispatch('receive_file',{
        action:'commit',transfer_id:session.transfer_id
      });
      return {status:'staged_in_brave_not_uploaded',...result};
    } catch(error) {
      await dispatch('receive_file',{
        action:'abort',transfer_id:session.transfer_id
      }).catch(()=>{});
      throw Error('Signed PDF import failed: '+String(error.message||error).slice(0,140));
    } finally {clearTimeout(timer);}
  }
  return {prepare,handle,pull};
}
