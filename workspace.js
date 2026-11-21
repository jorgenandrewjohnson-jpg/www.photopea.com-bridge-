'use strict';

const photopea = 'https://www.photopea.com';
const socketUrl = new URL('/socket', location.href);
socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const iframe = document.querySelector('#pp');
const statusLine = document.querySelector('#status');
const tokenInput = document.querySelector('#token');
const connect = document.querySelector('#connect');
const fileInput = document.querySelector('#file');
const openFile = document.querySelector('#openFile');
const approval = document.querySelector('#approval');
const seen = new Set();
let socket, key, reconnectTimer, authenticated = false, loaded = false, pending = null, remoteJob = null, approvalId = null;
let retryDelay = 1000, maxFile = 100_000_000;

function label(text) { statusLine.textContent = text; }
function syncButtons() {
  openFile.disabled = !loaded || !!pending || !!remoteJob || !!approvalId;
  connect.textContent = key ? 'Unpair workspace' : 'Pair workspace';
}
function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function idle() {
  syncButtons();
  if (loaded && authenticated && !pending && !remoteJob && !approvalId) send({ type: 'editor_idle' });
}
function clearApproval() {
  approvalId = null;
  if (approval.open) approval.close();
  document.querySelector('#script').textContent = '';
  syncButtons();
}
function decision(approved) {
  if (!approvalId) return;
  send({ type: 'decision', job_id: approvalId, approved });
  if (approved) remoteJob = approvalId;
  clearApproval();
}

function pair() {
  clearTimeout(reconnectTimer);
  const next = new WebSocket(socketUrl.href);
  socket = next;
  next.addEventListener('open', () => { if (socket === next && key) send({ type: 'hello', token: key }); });
  next.addEventListener('message', event => {
    if (socket !== next) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'authenticated') {
      authenticated = true;
      maxFile = message.max_file_bytes;
      retryDelay = 1000;
      label(loaded ? 'Paired. Checking editor…' : 'Paired. Loading Photopea…');
      idle();
    } else if (message.type === 'probe') {
      if (pending || remoteJob || !loaded) return;
      const prefix = 'photopea-probe:' + message.id;
      pending = { type: 'probe', prefix, id: message.id, socket: next };
      syncButtons();
      iframe.contentWindow.postMessage('app.echoToOE(' + JSON.stringify(prefix) + ');', photopea);
    } else if (message.type === 'approval') {
      if (pending || remoteJob || approvalId) return send({ type: 'decision', job_id: message.job_id, approved: false });
      approvalId = message.job_id;
      document.querySelector('#script').textContent = message.script;
      approval.showModal();
      syncButtons();
    } else if (message.type === 'step') {
      startStep(message, next);
    } else if (message.type === 'finished') {
      if (remoteJob === message.job_id) remoteJob = null;
      if (approvalId === message.job_id) clearApproval();
      if (message.download) addDownload(message.job_id);
      label(message.error || 'Connected to Photopea');
      syncButtons();
      if (pending === null) idle();
    }
  });
  next.addEventListener('close', event => {
    if (socket !== next) return;
    authenticated = false;
    remoteJob = null;
    clearApproval();
    const reason = event.reason ? ': ' + event.reason.slice(0, 120) : '';
    // An explicit policy rejection should be visible rather than silently retried.
    if (event.code === 1008) {
      key = undefined;
      label('Pairing rejected (' + event.code + ')' + reason);
    } else if (key) {
      const detail = event.code === 1006 ? 'abnormal close (1006)' : 'code ' + event.code + reason;
      label(pending
        ? 'Connection lost (' + detail + '). Waiting for Photopea to finish…'
        : 'Connection lost (' + detail + '). Reconnecting…');
      reconnectTimer = setTimeout(pair, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15_000);
    } else label('Workspace unpaired');
    syncButtons();
  });
}

connect.addEventListener('click', () => {
  if (key) {
    key = undefined;
    tokenInput.value = '';
    clearTimeout(reconnectTimer);
    socket?.close(1000, 'Workspace unpaired');
    syncButtons();
    return;
  }
  if (tokenInput.value.length < 32) return label('Enter the bridge key.');
  key = tokenInput.value;
  tokenInput.value = '';
  label('Pairing workspace…');
  syncButtons();
  pair();
});

function rejectStep(message, error) {
  send({ type: 'failed', job_id: message.job_id, step_id: message.step_id, error });
}

function startStep(message, connection) {
  if (!loaded || pending || (remoteJob && remoteJob !== message.job_id)) return rejectStep(message, 'Photopea is busy.');
  if (seen.has(message.step_id)) return rejectStep(message, 'Duplicate command was blocked.');
  if (seen.size >= 512) seen.delete(seen.values().next().value);
  seen.add(message.step_id);
  remoteJob = message.job_id;
  pending = {
    ...message, prefix: 'photopea-bridge:' + message.step_id + ':',
    socket: connection
  };
  syncButtons();
  send({ type: 'ack', job_id: message.job_id, step_id: message.step_id });
  try {
    let payload = message.script;
    if (message.bytes) payload = Uint8Array.from(atob(message.bytes), c => c.charCodeAt(0)).buffer;
    iframe.contentWindow.postMessage(payload, photopea);
  } catch {
    pending = null;
    rejectStep(message, 'Could not send the command to Photopea.');
    syncButtons();
  }
}

window.addEventListener('message', event => {
  if (event.origin !== photopea || event.source !== iframe.contentWindow) return;
  if (!pending) {
    if (!loaded && event.data === 'done') {
      loaded = true;
      label(authenticated ? 'Paired. Checking editor…' : 'Photopea loaded. Pair the workspace to start.');
      idle();
    }
    return;
  }
  const task = pending;
  if (event.data instanceof ArrayBuffer) {
    if (task.export && !task.binary) {
      if (event.data.byteLength > maxFile) task.result = { ok: false, error: 'Export exceeds the service size limit.' };
      else task.binary = event.data;
    }
    return;
  }
  if (typeof event.data !== 'string') return;
  if (task.type === 'probe' && event.data === task.prefix) task.confirmed = true;
  if (task.type === 'step' && event.data.startsWith(task.prefix) && task.result?.ok !== false) {
    try { task.result = JSON.parse(event.data.slice(task.prefix.length)); } catch {}
  }
  if (event.data !== 'done') return;
  // Photopea may emit an intermediate "done" while creating a document.
  if (task.type === 'probe' && !task.confirmed) return;
  if (task.type === 'step' && !task.bytes && !task.result) return;
  const belongs = task.socket === socket && authenticated;
  pending = null;
  if (task.type === 'probe') {
    if (belongs && task.confirmed) {
      send({ type: 'probe_ok', id: task.id });
      label('Connected to Photopea');
      syncButtons();
    } else idle();
    return;
  }
  if (task.type === 'local') {
    label('Local file sent to Photopea');
    idle();
    return;
  }
  if (!belongs) { idle(); return; }
  const ids = { job_id: task.job_id, step_id: task.step_id };
  if (!task.bytes && !task.result.ok) {
    send({ type: 'failed', ...ids, error: task.result.error });
    return;
  }
  if (task.binary) socket.send(new Blob([task.job_id, task.step_id, task.binary]));
  send({ type: 'complete', ...ids, value: task.result?.value });
});

openFile.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file || openFile.disabled) return;
  if (file.size > maxFile) return label('The file exceeds the workspace size limit.');
  send({ type: 'editor_busy' });
  pending = { type: 'local', socket };
  syncButtons();
  try { iframe.contentWindow.postMessage(await file.arrayBuffer(), photopea); }
  catch { pending = null; idle(); label('Unable to open the local file.'); }
});
document.querySelector('#approve').addEventListener('click', () => decision(true));
document.querySelector('#decline').addEventListener('click', () => decision(false));
approval.addEventListener('cancel', event => { event.preventDefault(); decision(false); });

function addDownload(id) {
  const list = document.querySelector('#downloads');
  const button = document.createElement('button');
  button.textContent = 'Download export ' + id.slice(0, 8);
  button.addEventListener('click', async () => {
    if (!key || !authenticated) return label('Pair the workspace to download this export.');
    button.disabled = true;
    try {
      const response = await fetch('/download/' + id, { headers: { Authorization: 'Bearer ' + key } });
      if (!response.ok) throw new Error();
      const name = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || 'photopea-export';
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { label('Unable to download. The export may have expired.'); }
    finally { button.disabled = false; }
  });
  list.prepend(button);
  while (list.children.length > 8) list.lastChild.remove();
}

iframe.src = photopea + '/';
