import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createTransferIngress} from '../http-transfer.mjs';

const begin={action:'begin',tab_id:1,edition:'hardcover',
  edition_id:'MDYZRKK4ZHV',kind:'manuscript',
  name:'book.pdf',size:0,sha256:'a'.repeat(64)};

function response() {
  return {headersSent:false,status:0,body:'',
    writeHead(status){this.status=status;this.headersSent=true;},
    end(text){this.body=text||'';}
  };
}
test('private PDF stream is routed through bounded browser chunks and committed once',async()=>{
  const buffer=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(25000,65)]);
  const calls=[];
  const service=createTransferIngress({
    origin:'https://private.example',
    dispatch:async(op,a)=>{
      calls.push({op,...a});
      if(a.action==='begin')return {transfer_id:'8ed92086-ed07-42ee-9501-6f7190732117'};
      if(a.action==='commit')return {file_id:'efb2b2a8-3265-4367-92d5-7e31239e5ee8'};
      return {received:true};
    }
  });
  const ticket=await service.prepare({...begin,size:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')});
  assert.match(ticket.upload_url,/^https:\/\/private\.example\/file-transfer\//);
  assert.ok(ticket.upload_token.length>30);
  const request=Readable.from([buffer.subarray(0,13000),buffer.subarray(13000)]);
  request.method='POST';
  request.headers={'content-type':'application/pdf',
    'content-length':String(buffer.length),
    'x-kdp-transfer-token':ticket.upload_token};
  const res=response();
  await service.handle(request,res,new URL(ticket.upload_url));
  assert.equal(res.status,200);
  assert.equal(JSON.parse(res.body).status,'staged_in_brave_not_uploaded');
  const appended=calls.filter(x=>x.action==='append');
  assert.equal(appended.length,2);
  assert.deepEqual(Buffer.concat(appended.map(x=>Buffer.from(x.data_base64,'base64'))),buffer);
  assert.deepEqual(appended.map(x=>x.index),[0,1]);
  assert.equal(calls.filter(x=>x.action==='commit').length,1);
  const retry=Readable.from([buffer]);retry.method='POST';retry.headers=request.headers;
  const rejected=response();
  await service.handle(retry,rejected,new URL(ticket.upload_url));
  assert.equal(rejected.status,401);
});
test('invalid or missing transfer token cannot submit a PDF',async()=>{
  let appended=false;
  const s=createTransferIngress({origin:'https://private.example',dispatch:async(_,a)=>{
    if(a.action==='begin')return {transfer_id:'4d8d62f2-2305-410a-80e7-95a21510638f'};
    appended=true;return {};
  }});
  const t=await s.prepare({...begin,size:10});
  const req=Readable.from([Buffer.alloc(10)]);req.method='POST';
  req.headers={'content-type':'application/pdf','x-kdp-transfer-token':'wrong'};
  const res=response();
  await s.handle(req,res,new URL(t.upload_url));
  assert.equal(res.status,401);assert.equal(appended,false);
});

test('an interrupted stream resumes from the last browser acknowledgement after ingress restart',async()=>{
  const bytes=Buffer.alloc(73000,65);bytes.write('%PDF-1.7');
  const list=[];
  const manifest={...begin,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  let simulateDrop=true;
  const restart=()=>createTransferIngress({origin:'https://private.example',dispatch:async(_,a)=>{
    if(a.action==='begin')return {transfer_id:'stub',next_index:list.length,received:list.reduce((n,b)=>n+b.length,0)};
    if(a.action==='append'){
      if(a.index===1 && simulateDrop) {simulateDrop=false;throw Error('simulated network drop');}
      assert.equal(a.index,list.length);
      list.push(Buffer.from(a.data_base64,'base64'));return {};
    }
    assert.equal(a.action,'commit');return {file_id:'verified'};
  }});
  for(const expected of [422,200]) {
    const server=restart();
    const ticket=await server.prepare(manifest);
    const req=Readable.from([bytes]); req.method='POST';
    req.headers={'x-kdp-transfer-token':ticket.upload_token,'content-type':'application/pdf'};
    const res=response();
    await server.handle(req,res,new URL(ticket.upload_url));
    assert.equal(res.status,expected);
  }
  assert.deepEqual(Buffer.concat(list),bytes);
});
