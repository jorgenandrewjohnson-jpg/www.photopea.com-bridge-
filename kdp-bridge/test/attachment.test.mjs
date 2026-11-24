import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {attachmentSource,createAttachmentReceiver} from '../attachment.mjs';

test('attachment streaming preserves bytes and validates the edition receipt',async()=>{
  const body=Buffer.alloc(120000,65); body.write('%PDF-1.7');
  const destination={tab_id:7,edition:'paperback',edition_id:'BOOK',kind:'cover'};
  const chunks=[];
  const hash=createHash('sha256').update(body).digest('hex');
  const run=createAttachmentReceiver({call:async(op,a)=>{
    if(op==='tabs') return [{...destination,stage:'content'}];
    if(a.action==='begin'){assert.equal(a.sha256,hash);return {transfer_id:'test'};}
    if(a.action==='append') {assert.equal(a.index,chunks.length);chunks.push(Buffer.from(a.data_base64,'base64'));return {};}
    if(a.action==='commit') return {...destination,filename:'proof.pdf',size:body.length,sha256:hash,file_id:'fixture'};
  }},async()=>new Response(body,{headers:{'Content-Length':body.length}}));
  const result=await run({...destination,file:{download_url:'https://files.oaiusercontent.com/proof?sig=test',file_id:'fixture',file_name:'proof.pdf'}});
  assert.equal(result.sha256,hash);
  assert.deepEqual(Buffer.concat(chunks),body);
  assert.throws(()=>attachmentSource('https://files.oaiusercontent.com.example.com/proof?sig=test'));
});
