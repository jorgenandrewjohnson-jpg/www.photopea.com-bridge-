import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 3000);
const token = process.env.BRIDGE_TOKEN || '';
if (token.length < 32) {
  console.error('BRIDGE_TOKEN must be set to a random value of at least 32 characters.');
  process.exit(1);
}
const dir = path.dirname(fileURLToPath(import.meta.url));
const storageDir = process.env.STORAGE_DIR || path.join(dir, 'exports');
fs.mkdirSync(storageDir, { recursive: true });
const jobs = new Map();
let workspace = null;
let workspaceReady = false;
let activeId = null;
const MAX_FILE = Number(process.env.MAX_FILE_BYTES || 100_000_000);
const MAX_JOBS = 60;

function auth(req) {
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  const a = Buffer.from(String(raw));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function send(res, code, body, extra = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(payload);
}
function success(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function statusInfo() { return { connected: !!workspace && workspace.readyState === WebSocket.OPEN, photopea_ready: workspaceReady, active_job: activeId, queued_jobs: [...jobs.values()].filter(x=>x.status === 'queued').length, note: 'Both connected and photopea_ready must be true before jobs can execute.' }; }
function resultTool(value, isError = false) { return { content: [{ type: 'text', text: JSON.stringify(value) }], isError }; }
const schemas = [
  { name: 'bridge_status', description: 'Check whether the Photopea companion workspace is connected and ready. Do not claim Photopea is connected unless photopea_ready is true.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'photopea_run_script', description: 'Queue a Photopea-compatible JavaScript editing script in the open companion workspace. Returns a job_id; poll job_status to verify completion. Run only scripts from trusted sources.', inputSchema: { type: 'object', properties: { script: { type: 'string', maxLength: 20000 } }, required: ['script'], additionalProperties: false } },
  { name: 'photopea_export', description: 'Queue export of currently open Photopea document. Use job_status for an authorized download URL when finished.', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['psd', 'png', 'jpg'] } }, required: ['format'], additionalProperties: false } },
  { name: 'job_status', description: 'Get the verified status and output of a previously queued Photopea job.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false } }
];
function enqueue(kind, options) {
  if (jobs.size >= MAX_JOBS) {
    for (const [id, j] of jobs) { if (j.status === 'completed' || j.status === 'failed') { jobs.delete(id); if (jobs.size < MAX_JOBS) break; } }
    if (jobs.size >= MAX_JOBS) throw new Error('Job queue full.');
  }
  const id = crypto.randomUUID();
  const job = { id, kind, ...options, status: 'queued', created_at: new Date().toISOString(), messages: [], file_name: null, downloaded: false };
  jobs.set(id, job);
  dispatch();
  return { job_id: id, status: job.status, bridge: statusInfo() };
}
function dispatch() {
  if (!workspaceReady || !workspace || workspace.readyState !== WebSocket.OPEN || activeId) return;
  const job = [...jobs.values()].find(x => x.status === 'queued');
  if (!job) return;
  activeId = job.id;
  job.status = 'running';
  job.started_at = new Date().toISOString();
  const script = job.kind === 'export' ? `app.activeDocument.saveToOE(${JSON.stringify(job.format)});` : job.script;
  workspace.send(JSON.stringify({ type: 'run', job_id: job.id, script }));
}
function jobView(job) {
  const { script, messages, ...safe } = job;
  return { ...safe, messages: messages.slice(-25), download_url: job.file_name ? `/download/${job.id}` : null, download_requires_bearer_token: !!job.file_name };
}
function getTool(name, args) {
  try {
    if (name === 'bridge_status') return resultTool(statusInfo());
    if (name === 'job_status') {
      const job = jobs.get(args.job_id);
      if (!job) return resultTool({ error: 'Unknown job ID' }, true);
      return resultTool(jobView(job));
    }
    if (name === 'photopea_run_script') {
      if (typeof args.script !== 'string' || !args.script.trim() || args.script.length > 20000) return resultTool({ error: 'Script must be nonempty and <=20000 characters.' }, true);
      return resultTool(enqueue('script', { script: args.script }));
    }
    if (name === 'photopea_export') {
      if (!['psd','png','jpg'].includes(args.format)) return resultTool({ error: 'Unsupported export format' }, true);
      return resultTool(enqueue('export', { format: args.format }));
    }
    return resultTool({ error: 'Unknown tool' }, true);
  } catch (e) { return resultTool({ error: e.message }, true); }
}
function handleMcp(body) {
  if (!body || body.jsonrpc !== '2.0') return error(body?.id ?? null, -32600, 'Invalid JSON-RPC request');
  if (body.method === 'notifications/initialized') return null;
  if (body.method === 'initialize') return success(body.id, { protocolVersion: body.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'photopea-cover-bridge', version: '0.2.0' } });
  if (body.method === 'ping') return success(body.id, {});
  if (body.method === 'tools/list') return success(body.id, { tools: schemas });
  if (body.method === 'tools/call') return success(body.id, getTool(body.params?.name, body.params?.arguments || {}));
  return error(body.id, -32601, 'Unknown method');
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, service: 'photopea-cover-bridge' });
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/workspace')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src https://www.photopea.com; connect-src 'self' wss: ws:; img-src 'self' data:" });
    return fs.createReadStream(path.join(dir, 'public', 'workspace.html')).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/workspace.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(path.join(dir, 'public', 'workspace.js')).pipe(res);
  }
  if (url.pathname === '/mcp' && req.method === 'POST') {
    if (!auth(req)) return send(res, 401, { error: 'Unauthorized' });
    let raw = ''; for await (const piece of req) { raw += piece; if (raw.length > 100_000) return send(res, 413, { error: 'Request too large' }); }
    try { const body = JSON.parse(raw); const out = handleMcp(body); if (!out) return send(res, 202, ''); return send(res, 200, out); }
    catch { return send(res, 400, { error: 'Invalid JSON' }); }
  }
  if (url.pathname === '/mcp' && req.method === 'GET') return send(res, 405, { error: 'GET SSE sessions not supported; use POST Streamable HTTP.' }, { Allow: 'POST' });
  if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
    if (!auth(req)) return send(res, 401, { error: 'Unauthorized' });
    const id = url.pathname.split('/')[2], job = jobs.get(id);
    if (!job?.file_name) return send(res, 404, { error: 'Export not found.' });
    const filepath = path.join(storageDir, job.file_name);
    if (!fs.existsSync(filepath)) return send(res, 404, { error: 'Export expired.' });
    res.writeHead(200, { 'Content-Type': job.format === 'psd' ? 'image/vnd.adobe.photoshop' : job.format === 'png' ? 'image/png' : 'image/jpeg', 'Content-Disposition': `attachment; filename="${job.file_name}"`, 'Content-Length': fs.statSync(filepath).size, 'Cache-Control': 'no-store' });
    return fs.createReadStream(filepath).pipe(res);
  }
  send(res, 404, { error: 'Not found' });
});
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FILE + 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/socket') return socket.destroy();
  const origin = req.headers.origin;
  if (!origin || new URL(origin).host !== req.headers.host) return socket.destroy();
  wss.handleUpgrade(req, socket, head, sock => wss.emit('connection', sock));
});
wss.on('connection', sock => {
  let authorized = false;
  sock.on('message', (raw, binary) => {
    if (!authorized) {
      if (binary) return sock.close(1008);
      let obj; try { obj = JSON.parse(String(raw)); } catch { return sock.close(1008); }
      const a = Buffer.from(String(obj.token || '')), b = Buffer.from(token);
      if (obj.type !== 'hello' || a.length !== b.length || !crypto.timingSafeEqual(a,b)) return sock.close(1008, 'Bad key');
      authorized = true;
      if (workspace && workspace !== sock) workspace.close(1000, 'New workspace connected');
      workspace = sock; workspaceReady = false; activeId = null;
      for (const j of jobs.values()) if (j.status === 'running') { j.status = 'queued'; j.messages.push('Previous workspace disconnected; job will be retried.'); }
      sock.send(JSON.stringify({ type: 'authenticated', status: 'Connected. Waiting for Photopea to finish loading.' }));
      return;
    }
    if (sock !== workspace) return;
    if (binary) {
      const job = jobs.get(activeId);
      if (!job || job.kind !== 'export') return;
      if (raw.length > MAX_FILE) { job.status = 'failed'; job.error = 'Export exceeds MAX_FILE_BYTES'; return; }
      const ext = job.format === 'jpg' ? 'jpg' : job.format;
      const filename = `${job.id}.${ext}`;
      fs.writeFileSync(path.join(storageDir, filename), raw);
      job.file_name = filename;
      job.bytes = raw.length;
      return;
    }
    let obj; try { obj = JSON.parse(String(raw)); } catch { return; }
    if (obj.type === 'photopea_ready') { workspaceReady = true; dispatch(); return; }
    const job = jobs.get(activeId);
    if (!job || obj.job_id !== activeId) return;
    if (obj.type === 'message') {
      if (typeof obj.value === 'string' && job.messages.length < 100) job.messages.push(obj.value.slice(0,4000));
    } else if (obj.type === 'complete') {
      if (job.status === 'failed') {} else if (job.kind === 'export' && !job.file_name) { job.status = 'failed'; job.error = 'No exported data received'; }
      else job.status = 'completed';
      job.completed_at = new Date().toISOString();
      activeId = null; dispatch();
    } else if (obj.type === 'failed') {
      job.status = 'failed'; job.error = String(obj.error || 'Browser error').slice(0,1000); job.completed_at = new Date().toISOString(); activeId = null; dispatch();
    }
  });
  sock.on('close', () => {
    if (workspace !== sock) return;
    workspace = null; workspaceReady = false;
    if (activeId) { const job = jobs.get(activeId); if (job && job.status === 'running') { job.status = 'queued'; job.messages.push('Connection lost before completion.'); } }
    activeId = null;
  });
});
server.listen(port, '0.0.0.0', () => console.log(`Photopea bridge listening on ${port}; open /workspace in a browser.`));
