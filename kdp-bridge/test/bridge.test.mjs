import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
import {connectClient} from './client.mjs';
import {route,openable,bridgeOrigin,isPdfPath} from '../extension/policy.js';
test('local PDF staging extension check accepts a normal PDF pathname',()=>{
  assert.equal(isPdfPath('/Users/jorgen/Desktop/Corinthians_Joel_6x9_Images_Aligned_REVIEW.pdf'),true);
  assert.equal(isPdfPath('/Users/jorgen/Downloads/Hardcover.PDF'),true);
  for (const pathname of ['/Users/jorgen/Desktop/book.pdf.exe','/Users/jorgen/Desktop/book','',null,{}]) {
    assert.equal(isPdfPath(pathname),false);
  }
});
test('publishing routes and sanitized identity',()=>{
  const path='https://kdp.amazon.com/en_US/title-setup/paperback/AB123/content';
  assert.equal(route(path+'?secret=opaque').path,path);
  assert.equal(route(path).edition_id,'AB123');
  assert.ok(openable(path));
  const printContent='https://kdp.amazon.com/en_US/print-setup/hardcover/MDYZRKK4ZHV/content';
  const printDetails='https://kdp.amazon.com/en_US/print-setup/hardcover/MDYZRKK4ZHV/details';
  const printPricing='https://kdp.amazon.com/en_US/print-setup/hardcover/MDYZRKK4ZHV/pricing';
  for (const [url, stage] of [[printContent,'content'],[printDetails,'details'],[printPricing,'pricing']]) {
    assert.deepEqual(route(url),{edition:'hardcover',edition_id:'MDYZRKK4ZHV',stage,path:url});
    assert.equal(openable(url),true);
  }
  assert.equal(openable(printContent+'?token=private'),false);
  assert.equal(openable(printContent.replace('MDYZRKK4ZHV','new')),false);
  assert.equal(route('https://evil.example/en_US/print-setup/hardcover/MDYZRKK4ZHV/content'),null);
  assert.equal(route('https://kdp.amazon.com/en_US/print-setup/hardcover/MDYZRKK4ZHV/publish'),null);
  for(const url of [path+'?x=y','https://kdp.amazon.com/en_US/account','https://cc.amazon.com/?auth=test',path.replace('AB123','new'),path.replace('kdp.amazon.com','other.example')]) assert.ok(!openable(url));
  assert.throws(()=>bridgeOrigin('http://example.org'));
});
test('OAuth discovery, MCP calls, enrollment, single-browser ownership and disconnection',async t=>{
  const reservation=net.createServer().listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const origin='http://127.0.0.1:'+port,key=randomBytes(48).toString('base64url');
  const proc=spawn(process.execPath,['server.mjs'],{env:{...process.env,KDP_OWNER_KEY:key,PUBLIC_ORIGIN:origin,RENDER_EXTERNAL_URL:'',PORT:String(port)},stdio:['ignore','pipe','inherit']});
  t.after(()=>proc.kill());await once(proc.stdout,'data');
  const denied=await fetch(origin+'/mcp');assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate'),/resource_metadata/);
  const client=await connectClient(origin,key);t.after(()=>client.close());
  const defs=await client.listTools();
  const names=new Set(defs.tools.map(tool=>tool.name));
  for (const name of ['kdp_receive_file','kdp_import_signed_chatgpt_pdf','kdp_upload_file','kdp_upload_status','kdp_publish_approved']) {
    assert.ok(names.has(name), 'Missing registered tool '+name);
  }
  const call=(name,args={})=>client.callTool({name,arguments:args});
  assert.equal(JSON.parse((await call('kdp_bridge_status')).content[0].text).paired,false);
  assert.equal((await call('kdp_click',{})).isError,true);
  const socket=()=>new WebSocket(origin.replace('http:','ws:')+'/browser',{origin:'chrome-extension://'+'b'.repeat(32)});
  const receive=async ws=>JSON.parse((await once(ws,'message'))[0]);
  const ws=socket();t.after(()=>ws.terminate());await once(ws,'open');
  ws.send(JSON.stringify({type:'enroll'}));
  const challenge=await receive(ws);assert.equal(challenge.type,'challenge');
  const issued=receive(ws);
  const r=await fetch(origin+'/device/approve',{method:'POST',headers:{Authorization:'Bearer '+key},body:JSON.stringify({code:challenge.code})});assert.equal(r.status,200);
  const {device,proof}=await issued;
  ws.send(JSON.stringify({type:'pair',device,proof}));assert.equal((await receive(ws)).type,'paired');
  const other=socket();await once(other,'open');other.send(JSON.stringify({type:'pair',device,proof}));assert.equal((await once(other,'close'))[0],1008);
  const command=receive(ws);const pending=call('kdp_list_tabs');const msg=await command;assert.equal(msg.op,'tabs');
  ws.send(JSON.stringify({type:'result',id:msg.id,ok:true,value:[]}));assert.deepEqual(JSON.parse((await pending).content[0].text),[]);
  ws.close();await once(ws,'close');assert.equal((await call('kdp_list_tabs')).isError,true);
});
