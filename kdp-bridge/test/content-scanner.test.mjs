import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';

test('scanner distinguishes cover notices, disabled Previewer and visible preview evidence',async t=>{
  const chrome=process.env.CHROME_BIN || (process.platform==='darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  const profile=await mkdtemp(join(tmpdir(),'kdp-scanner-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const scanner=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
  const fixture=`<!doctype html><body>
    <h2>Hardcover Content</h2><p id="cover">No Cover Uploaded</p>
    <button disabled>Launch Previewer</button>
    <label>Page Range: <input value="2-3"> / 548</label>
    <div>We've removed non-printable markup from your document.</div>
    <div style="position:absolute;top:5000px">Pages 30-31</div>
    <output></output>
    <script>${scanner}</script><script>
    const page={stage:'content',path:location.href,edition:'hardcover',edition_id:'example'};
    const state=()=>kdpPage('inspect',{},page).content_state;
    const missing=state();
    cover.textContent='Cover "wrap.pdf" uploaded successfully!';
    const present=state();
    cover.append(' No Cover Uploaded');
    const conflict=state();
    const preview=kdpPage('preview_metadata',{},{...page,stage:'previewer'});
    document.querySelector('output').textContent=JSON.stringify({
      missing:missing.cover_status,present:present.cover_status,conflict:conflict.cover_status,
      enabled:missing.preview_enabled,labels:preview.visible_page_labels,alerts:preview.alerts});
    </script>`;
  const server=createServer((req,res)=>res.end(fixture)).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>server.close());
  let stdout;
  try {
    ({stdout}=await promisify(execFile)(chrome,['--headless','--disable-background-networking',
      '--disable-extensions','--no-first-run','--user-data-dir='+profile,'--dump-dom',
      'http://127.0.0.1:'+server.address().port+'/'],{timeout:30000}));
  } catch (error) {
    if(error.code==='ENOENT') return t.skip('Set CHROME_BIN to run the browser regression');
    throw error;
  }
  const result=JSON.parse(stdout.match(/<output>([^<]+)<\/output>/)[1]);
  assert.deepEqual(result,{missing:'missing',present:'present',conflict:'unknown',enabled:false,
    labels:['2-3 / 548'],alerts:["We've removed non-printable markup from your document."]});
});
