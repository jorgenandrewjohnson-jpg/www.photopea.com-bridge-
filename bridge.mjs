import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, unlink, rename, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { composePdf } from './pdf.mjs';
import { wrapStep } from './photopea.mjs';
import { matches, send } from './oauth.mjs';

const UUID_BYTES = 36;
const FRAME_HEADER = UUID_BYTES * 2;
const TTL = 60 * 60_000;
const MAX_JOBS = 100;
// Give the embedded editor time to load before deciding that its handshake failed.
const AUTH_TIMEOUT_MS = 30_000;
const mime = { psd: 'image/vnd.adobe.photoshop', png: 'image/png', jpg: 'image/jpeg', pdf: 'application/pdf' };

function isFormat(bytes, format) {
  if (format === 'psd') return bytes.length > 26 && bytes.subarray(0, 4).toString() === '8BPS';
  if (format === 'png') return bytes.length > 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  return bytes.length > 4 && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
}

export async function createBridge(server, { origin, token, storage, maxFile, stepTimeout = 35_000 }) {
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFile + FRAME_HEADER, perMessageDeflate: false });
  const jobs = new Map();
  let workspace = null, active = null, pendingProbe = null, responsiveAt = 0, editorReady = false;
  let storedBytes = 0;
  let socketSequence = 0;

  async function expireDisk() {
    const entries = await readdir(storage);
    await Promise.all(entries.filter(name => /^[\da-f-]{36}\.(?:psd|png|jpg|pdf|part)$/.test(name)).map(async name => {
      const file = join(storage, name);
      try {
        if (Date.now() - (await stat(file)).mtimeMs > TTL) await unlink(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }));
  }

  function post(socket, message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function status() {
    const connected = workspace?.readyState === WebSocket.OPEN;
    const responsive = !!connected && editorReady && Date.now() - responsiveAt < stepTimeout + 18_000;
    return {
      healthy: true, connected: !!connected, photopea_ready: responsive, can_execute: responsive && !active,
      active_job: active?.id ?? null, queued_jobs: [...jobs.values()].filter(job => job.status === 'queued').length
    };
  }

  function view(job) {
    return {
      job_id: job.id, status: job.status, created_at: job.createdAt, completed_at: job.finishedAt ?? null,
      ...(job.error && { error: job.error }),
      ...(job.result !== undefined && { result: job.result }),
      ...(job.file && {
        bytes: job.file.bytes, file_name: job.file.name,
        download_url: origin + '/download/' + job.id, download_requires_bearer_token: true,
        expires_at: new Date(job.expires).toISOString()
      })
    };
  }

  function finish(job, outcome, error) {
    clearTimeout(job.timer);
    job.status = outcome;
    job.error = error;
    job.finishedAt = new Date().toISOString();
    job.expires = Date.now() + TTL;
    job.operation = undefined;
    job.stepId = undefined;
    job.binary = undefined;
    if (active !== job) return;
    active = null;
    post(workspace, { type: 'finished', job_id: job.id, status: outcome, error, download: !!job.file });
    dispatch();
  }

  function disconnect(socket, reason) {
    if (workspace !== socket) return;
    workspace = null;
    editorReady = false;
    responsiveAt = 0;
    pendingProbe = null;
    for (const job of jobs.values()) {
      if (job === active) {
        const outcome = job.status === 'awaiting_approval' ? 'failed' : 'uncertain';
        finish(job, outcome, outcome === 'uncertain' ? reason + ' Check Photopea before retrying.' : reason);
      } else if (job.status === 'queued') finish(job, 'failed', reason + ' No command was sent.');
    }
  }

  function probe() {
    if (!workspace || active || pendingProbe || !editorReady) return;
    pendingProbe = { id: randomUUID(), at: Date.now() };
    post(workspace, { type: 'probe', id: pendingProbe.id });
  }

  function startStep(job) {
    const step = job.operation.steps[job.index];
    job.stepId = randomUUID();
    job.stepStartedAt ??= Date.now();
    job.status = 'dispatching';
    job.binary = undefined;
    job.timer = setTimeout(() => {
      const socket = workspace;
      disconnect(socket, 'Timed out waiting for Photopea to acknowledge the command.');
      socket?.close(1011, 'Command timed out');
    }, Math.min(10_000, stepTimeout)).unref();
    post(workspace, {
      type: 'step', job_id: job.id, step_id: job.stepId,
      script: step.body === undefined ? undefined : wrapStep('photopea-bridge:' + job.stepId + ':', step.body, job.result),
      bytes: step.bytes?.toString('base64'), export: !!step.export
    });
  }

  function dispatch() {
    if (active || pendingProbe || !status().photopea_ready) return;
    const job = [...jobs.values()].find(item => item.status === 'queued');
    if (!job) return;
    active = job;
    clearTimeout(job.timer);
    if (job.operation.approval) {
      job.status = 'awaiting_approval';
      post(workspace, { type: 'approval', job_id: job.id, script: job.operation.approval });
      job.timer = setTimeout(() => finish(job, 'failed', 'Script approval expired.'), 120_000).unref();
      return;
    }
    startStep(job);
  }

  async function saveExport(job) {
    const raw = job.binary;
    if (!raw) throw new Error('Photopea returned no export data.');
    const { format, wireFormat, name } = job.operation;
    if (!isFormat(raw, wireFormat)) throw new Error('Photopea returned an unexpected or damaged file format.');
    const bytes = format === 'pdf' ? await composePdf(raw, job.result?.dpi) : raw;
    if (active !== job || job.status !== 'saving') return;
    if (bytes.length > maxFile || storedBytes + bytes.length > 2 * maxFile) throw new Error('Export storage is full or the file exceeds the size limit.');
    const basename = job.id + '.' + format;
    const partial = join(storage, job.id + '.part');
    try {
      await pipeline([bytes], createWriteStream(partial, { mode: 0o600, flags: 'wx' }));
      await rename(partial, join(storage, basename));
    } catch (error) {
      await unlink(partial).catch(() => {});
      throw error;
    }
    if (active !== job || job.status !== 'saving') {
      await unlink(join(storage, basename)).catch(() => {});
      return;
    }
    storedBytes += bytes.length;
    job.file = { basename, name: (name || 'photopea-cover') + '.' + format, bytes: bytes.length, format };
    finish(job, 'completed');
  }

  function handleMessage(socket, raw, binary) {
    if (binary) {
      if (raw.length <= FRAME_HEADER || !active || active.status !== 'running') return;
      const job = active;
      if (raw.subarray(0, 36).toString() !== job.id || raw.subarray(36, FRAME_HEADER).toString() !== job.stepId) return;
      if (!job.operation.steps[job.index].export || job.binary) return;
      job.binary = raw.subarray(FRAME_HEADER);
      return;
    }
    if (raw.length > 256_000) return;
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'editor_idle' && !active) {
      editorReady = true;
      probe();
      return;
    }
    if (message.type === 'editor_busy' && !active) {
      editorReady = false;
      pendingProbe = null;
      responsiveAt = 0;
      return;
    }
    if (message.type === 'probe_ok' && pendingProbe?.id === message.id) {
      pendingProbe = null;
      responsiveAt = Date.now();
      dispatch();
      return;
    }
    const job = active;
    if (!job || message.job_id !== job.id) return;
    if (message.type === 'decision' && job.status === 'awaiting_approval') {
      clearTimeout(job.timer);
      if (message.approved === true) startStep(job);
      else finish(job, 'failed', 'The workspace declined the script.');
      return;
    }
    if (message.step_id !== job.stepId) return;
    if (message.type === 'ack' && job.status === 'dispatching') {
      clearTimeout(job.timer);
      job.status = 'running';
      job.timer = setTimeout(() => {
        disconnect(socket, 'Photopea did not confirm completion before the timeout.');
        socket.close(1011, 'Command timed out');
      }, stepTimeout).unref();
      return;
    }
    if (message.type === 'failed' && ['dispatching', 'running'].includes(job.status)) {
      finish(job, job.status === 'running' && message.uncertain ? 'uncertain' : 'failed',
        String(message.error ?? 'Photopea rejected the command.').slice(0, 1000));
      return;
    }
    if (message.type !== 'complete' || job.status !== 'running') return;
    clearTimeout(job.timer);
    responsiveAt = Date.now();
    const step = job.operation.steps[job.index];
    if (step.waitForResult && message.value === null) {
      if (Date.now() - job.stepStartedAt > 12_000) {
        return finish(job, 'failed', 'Photopea did not finish preparing the new layer. Inspect the editor before retrying.');
      }
      job.status = 'waiting_editor';
      job.timer = setTimeout(() => startStep(job), 250).unref();
      return;
    }
    if (!step.bytes) job.result = message.value ?? null;
    job.stepStartedAt = undefined;
    job.index++;
    if (job.index < job.operation.steps.length) return startStep(job);
    if (job.operation.format) {
      job.status = 'saving';
      saveExport(job).catch(error => {
        if (active === job) finish(job, 'failed', error.code ? 'Could not store the export.' : error.message);
      });
      return;
    }
    finish(job, 'completed');
  }

  server.on('upgrade', (req, socket, head) => {
    // Record rejection categories only; never log headers, URLs, or bridge keys.
    const rejection = req.url !== '/socket' ? 'path'
      : req.headers.origin !== origin ? 'origin'
        : wss.clients.size >= 12 ? 'capacity' : null;
    if (rejection) {
      console.warn('[photopea-ws] upgrade rejected:', rejection);
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, sock => wss.emit('connection', sock));
  });
  wss.on('connection', socket => {
    const connectionId = ++socketSequence;
    let authenticated = false;
    socket.alive = true;
    socket._bridgeId = connectionId;
    console.info('[photopea-ws] connected:', connectionId);
    const authTimeout = setTimeout(() => {
      console.warn('[photopea-ws] hello timeout:', connectionId);
      socket.close(1008, 'Pairing timed out');
      // Give the browser a chance to receive the close reason.
      setTimeout(() => socket.terminate(), 2000).unref();
    }, AUTH_TIMEOUT_MS).unref();
    socket.on('pong', () => { socket.alive = true; });
    socket.on('error', error => {
      // Only report the error code. Exception messages can contain private data.
      console.warn('[photopea-ws] socket error:', connectionId, error?.code ?? 'unknown');
    });
    socket.on('close', code => {
      clearTimeout(authTimeout);
      console.info('[photopea-ws] closed:', connectionId, 'code:', code, 'authenticated:', authenticated);
      disconnect(socket, 'Workspace disconnected.');
    });
    socket.on('message', (raw, binary) => {
      if (authenticated) {
        if (workspace === socket) handleMessage(socket, raw, binary);
        return;
      }
      let hello;
      try { if (!binary && raw.length < 2048) hello = JSON.parse(raw.toString()); } catch {}
      if (hello?.type !== 'hello' || !matches(hello.token, token)) {
        console.warn('[photopea-ws] invalid hello or key:', connectionId);
        return socket.close(1008, 'Invalid bridge key');
      }
      // A fresh, correctly authenticated pairing may recover an abandoned browser
      // tab. Never replace a workspace while an edit is executing or queued.
      if (workspace && (active || [...jobs.values()].some(job => job.status === 'queued'))) {
        console.info('[photopea-ws] replacement denied; workspace busy:', connectionId);
        return socket.close(1008, 'Photopea is running a command; try again after it finishes');
      }
      if (workspace) {
        const previous = workspace;
        console.info('[photopea-ws] replaced idle workspace:', previous._bridgeId ?? 'unknown', 'with:', connectionId);
        disconnect(previous, 'Workspace replaced by another authorized pairing.');
        if (previous.readyState === WebSocket.OPEN) previous.close(1000, 'Replaced by another workspace');
        else previous.terminate();
      }
      clearTimeout(authTimeout);
      authenticated = true;
      workspace = socket;
      console.info('[photopea-ws] authenticated:', connectionId);
      post(socket, { type: 'authenticated', max_file_bytes: maxFile });
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.alive) {
        console.warn('[photopea-ws] heartbeat lost:', socket._bridgeId ?? 'unknown');
        socket.terminate();
        continue;
      }
      socket.alive = false;
      socket.ping();
    }
    if (pendingProbe && Date.now() - pendingProbe.at > 10_000) {
      pendingProbe = null;
      responsiveAt = 0;
      editorReady = false;
    }
    probe();
  }, 15000).unref();
  const cleanup = setInterval(() => {
    for (const [id, job] of jobs) {
      if (!job.expires || Date.now() < job.expires) continue;
      jobs.delete(id);
      if (job.file) {
        storedBytes -= job.file.bytes;
        unlink(join(storage, job.file.basename)).catch(() => {});
      }
    }
    expireDisk().catch(() => {});
  }, 60_000).unref();
  await expireDisk();

  return {
    status,
    enqueue(tool, operation, requestKey, args) {
      const hash = createHash('sha256').update(JSON.stringify([tool, args])).digest('hex');
      const prior = requestKey && [...jobs.values()].find(job => job.requestKey === requestKey);
      if (prior) {
        if (prior.hash !== hash) throw new Error('request_id belongs to different parameters.');
        return view(prior);
      }
      if (!status().photopea_ready) throw new Error('Open and pair /workspace, then wait for Photopea to respond.');
      if (jobs.size >= MAX_JOBS || status().queued_jobs >= 8) throw new Error('Queue full. Wait for existing jobs or their retention window.');
      const id = randomUUID();
      const job = { id, operation, requestKey, hash, status: 'queued', index: 0, createdAt: new Date().toISOString() };
      jobs.set(id, job);
      job.timer = setTimeout(() => finish(job, 'failed', 'Timed out in the queue. No command was sent.'), 180_000).unref();
      dispatch();
      return view(job);
    },
    job(id) {
      const job = jobs.get(id);
      if (!job) throw new Error('Job expired or is unknown.');
      return view(job);
    },
    download(id, res) {
      const file = jobs.get(id)?.file;
      if (!file) return send(res, 404, { error: 'Export expired or is unavailable.' });
      const stream = createReadStream(join(storage, file.basename));
      stream.once('open', () => {
        res.writeHead(200, {
          'Content-Type': mime[file.format], 'Content-Length': file.bytes, 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${file.name}"`, 'X-Content-Type-Options': 'nosniff'
        });
        stream.pipe(res);
      });
      stream.once('error', () => {
        if (!res.headersSent) send(res, 404, { error: 'Export expired or is unavailable.' });
        else res.destroy();
      });
      res.once('close', () => stream.destroy());
    },
    close() {
      clearInterval(heartbeat);
      clearInterval(cleanup);
      for (const job of jobs.values()) clearTimeout(job.timer);
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    }
  };
}
