import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('browser retains the acknowledged chunks when the publishing document reopens',async t=>{
  const chrome=process.env.CHROME_BIN || (process.platform==='darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  const module=await readFile(new URL('../extension/files.js',import.meta.url));
  const profile=await mkdtemp(join(tmpdir(),'kdp-receipt-test-'));
  let finish;
  const done=new Promise(resolve=>{finish=resolve});
  const server=http.createServer((req,res)=>{
    if(req.url==='/files.js') {
      res.writeHead(200,{'Content-Type':'text/javascript'});res.end(module);return;
    }
    if(req.url.startsWith('/result?')) {finish(new URL(req.url,'http://local').searchParams.get('state'));res.end();return;}
    const initial=req.url==='/';
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end('<script type="module">'+`
      import {beginTransfer,appendTransfer,transferParts,transferState,discardTransfer} from '/files.js';
      const manifest={id:'first',edition:'paperback',edition_id:'BOOK',tab_id:1,kind:'cover',
        expected_path:'content',name:'proof.pdf',size:3,sha256:'f'.repeat(64),received:0,next_index:0,expires:Date.now()+60000};
      try {
        if (${initial}) {
          await beginTransfer(manifest);await appendTransfer('first',0,new Uint8Array([1,2]));
          location.replace('/reopened');
        } else {
          const restored=await beginTransfer({...manifest,id:'second'});
          if(restored.id!=='first'||restored.received!==2||restored.next_index!==1)throw Error('Lost checkpoint');
          await appendTransfer(restored.id,1,new Uint8Array([3]));
          const bytes=Array.from(new Uint8Array(await new Blob(await transferParts(restored.id)).arrayBuffer()));
          await discardTransfer(restored.id);
          if(await transferState() || bytes.join(',')!=='1,2,3')throw Error('Incorrect bytes or cleanup');
          await fetch('/result?state=ok');
        }
      } catch(e) {await fetch('/result?state='+encodeURIComponent(e.message));}
    `+'</script>');
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  const child=spawn(chrome,['--headless','--disable-background-networking','--disable-extensions',
    '--no-first-run','--user-data-dir='+profile,'http://127.0.0.1:'+server.address().port+'/'],{stdio:'ignore'});
  child.once('error',e=>finish(e.code || e.message));
  const exit=once(child,'close').catch(()=>{});
  const timer=setTimeout(()=>finish('timed out'),25000);
  try {
    const state=await done;
    if(state==='ENOENT')return t.skip('Set CHROME_BIN to run the storage regression');
    assert.equal(state,'ok');
  } finally {
    clearTimeout(timer);child.kill();await exit;
    server.closeAllConnections();server.close();
    await rm(profile,{recursive:true,force:true,maxRetries:3});
  }
});
