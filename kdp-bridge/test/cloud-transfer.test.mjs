import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRemoteManifest,decodeRemoteChunk,REMOTE_CHUNK_BYTES} from '../extension/remote-policy.js';

const page={stage:'content',edition:'hardcover',edition_id:'MDYZRKK4ZHV',
  path:'https://kdp.amazon.com/en_US/print-setup/hardcover/MDYZRKK4ZHV/content'};
const safe={edition:page.edition,edition_id:page.edition_id,kind:'cover',
  name:'Corinthians_Joel_Hardcover_317p_500DPI.pdf',size:10374517,
  sha256:'a'.repeat(64),expected_path:page.path};

test('remote PDF receipt accepts an exact edition and safe PDF metadata',()=>{
  assert.equal(validateRemoteManifest(safe,page),true);
});
test('remote PDF receiver never confuses the paperback with hardcover',()=>{
  assert.throws(()=>validateRemoteManifest({...safe,edition:'paperback'},page),/exact saved/);
  assert.throws(()=>validateRemoteManifest({...safe,edition_id:'OTHER'},page),/exact saved/);
  assert.throws(()=>validateRemoteManifest({...safe,expected_path:'/wrong'},page),/exact saved/);
  assert.throws(()=>validateRemoteManifest(safe,{...page,edition_id:'new'}),/exact saved/);
});
test('remote receiver prevents paths, unexpected file types and excessive sizes',()=>{
  for(const name of ['../book.pdf','/tmp/book.pdf','book.pdf.exe','book.psd','folder\\book.pdf','book..pdf']) {
    assert.throws(()=>validateRemoteManifest({...safe,name},page));
  }
  assert.throws(()=>validateRemoteManifest({...safe,size:250*1024*1024+1},page));
  assert.throws(()=>validateRemoteManifest({...safe,sha256:'bad'},page));
});
test('remote binary chunks decode exactly and reject malformed or oversized data',()=>{
  const b=Buffer.from('%PDF-1.7');
  assert.deepEqual(decodeRemoteChunk(b.toString('base64')),new Uint8Array(b));
  assert.throws(()=>decodeRemoteChunk('not base64***'));
  assert.throws(()=>decodeRemoteChunk(Buffer.alloc(REMOTE_CHUNK_BYTES+1).toString('base64')));
});
