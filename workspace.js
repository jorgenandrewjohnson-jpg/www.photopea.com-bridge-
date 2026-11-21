'use strict';
const socketPath = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/socket`;
const pp = document.querySelector('#pp');
const status = document.querySelector('#status');
const tokenInput = document.querySelector('#token');
const connect = document.querySelector('#connect');
const fileInput = document.querySelector('#file');
const openFile = document.querySelector('#openFile');
let sock = null;
let ready = false;
let currentId = null;
let currentExport = false;
let busy = false;
function label(t) { status.textContent = t; }
function outgoing(o) { if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(o)); }
connect.addEventListener('click', () => {
  const token = tokenInput.value.trim();
  if (token.length < 32) return label('Enter the 32+ character BRIDGE_TOKEN first.');
  if (sock) sock.close();
  sock = new WebSocket(socketPath);
  sock.addEventListener('open', () => { outgoing({type:'hello',token}); tokenInput.value=''; label('Authorizing…'); });
  sock.addEventListener('message', evt => {
    let m; try { m = JSON.parse(evt.data); } catch { return; }
    if (m.type === 'authenticated') { label(ready ? 'Connected to Photopea' : 'Connected. Loading Photopea…'); if (ready) outgoing({ type:'photopea_ready' }); }
    if (m.type === 'run') {
      if (!ready || busy) return outgoing({type:'failed',job_id:m.job_id,error:'Photopea not ready'});
      busy = true; currentId = m.job_id; currentExport = m.script.includes('saveToOE(');
      try { pp.contentWindow.postMessage(m.script, 'https://www.photopea.com'); }
      catch (e) { outgoing({type:'failed',job_id:currentId,error:String(e)}); busy=false; currentId=null; }
    }
  });
  sock.addEventListener('close', () => label('Disconnected from bridge. Reconnect to resume.'));
  sock.addEventListener('error', () => label('Could not connect. Check the server URL.'));
});
window.addEventListener('message', e => {
  if (e.origin !== 'https://www.photopea.com' || e.source !== pp.contentWindow) return;
  if (e.data === 'done') {
    if (!ready) { ready = true; label('Photopea ready. Connect your bridge key.'); outgoing({type:'photopea_ready'}); return; }
    if (currentId) { outgoing({type:'complete',job_id:currentId}); busy=false; currentId=null; currentExport=false; }
    return;
  }
  if (!currentId) return;
  if (e.data instanceof ArrayBuffer) {
    // The binary export belongs to the active job. WebSocket ordering preserves the following completion message.
    if (sock?.readyState === WebSocket.OPEN && currentExport) sock.send(e.data);
  } else if (typeof e.data === 'string') outgoing({type:'message',job_id:currentId,value:e.data});
});
openFile.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]; if (!file) return;
  if (!ready) return label('Photopea is still loading.');
  if (busy) return label('Finish the current edit before opening a file.');
  try { pp.contentWindow.postMessage(await file.arrayBuffer(), 'https://www.photopea.com'); label(`Opening ${file.name}…`); }
  catch(e) { label(`Unable to open: ${e.message}`); }
  fileInput.value='';
});
