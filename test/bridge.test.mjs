import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';
import vm from 'node:vm';
import { setTimeout as wait } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WebSocket } from 'ws';
import { PNG } from 'pngjs';
import { PDFDocument } from 'pdf-lib';
import { createServer } from '../server.mjs';

const token = randomBytes(32).toString('base64url');
const png = new PNG({ width: 2, height: 3 });
png.data.fill(255);
const pngBytes = PNG.sync.write(png);
const psdBytes = Buffer.concat([Buffer.from('8BPS'), Buffer.alloc(30)]);
// Valid 2x3 JPEG; embedJpg parses real SOF dimensions, unlike the old marker-only fake.
const jpgBytes = Buffer.from([
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgH',
  'BgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEm',
  'KzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/',
  '2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7',
  'Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7',
  'Ozs7Ozs7Ozv/wAARCAADAAIDASIAAhEBAxEB/8QA',
  'FQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAA',
  'AAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAA',
  'AAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAM',
  'AwEAAhEDEQA/ALMAD//Z'
].join(''), 'base64');
const methods = [
  'bridge_status', 'job_status', 'photopea_add_text', 'photopea_export', 'photopea_manage_layers',
  'photopea_open_document', 'photopea_place_image', 'photopea_run_script'
];
let app, storage, origin, client;
const headers = { Authorization: 'Bearer ' + token };
const unwrap = result => result.structuredContent;

async function createClient(mode, bearer = token) {
  const mcp = new Client({ name: 'integration-tests', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer ' + bearer } }
  });
  await mcp.connect(transport);
  return mcp;
}

function tool(name, args = {}) { return client.callTool({ name, arguments: args }).then(unwrap); }
function status(id) { return tool('job_status', { job_id: id }); }
async function eventually(check, predicate = Boolean) {
  for (let n = 0; n < 200; n++) {
    const result = await check();
    if (predicate(result)) return result;
    await wait(20);
  }
  throw new Error('Timed out waiting for test condition.');
}
const terminal = result => ['completed', 'failed', 'uncertain'].includes(result.status);
async function submit(name, args) {
  const job = await tool(name, args);
  assert.ok(job.job_id, JSON.stringify(job));
  return eventually(() => status(job.job_id), terminal);
}

class MockPhotopea {
  documents = [];
  steps = 0;
  replies = [];
  auto = true;
  allowScripts = true;
  echo = null;
  exportBytes = null;

  constructor() {
    this.documents.add = (width, height, dpi, name) => {
      const doc = { height, width, resolution: dpi, name, layers: [] };
      doc.artLayers = { add: () => this.addLayer(doc, 'art') };
      doc.saveToOE = format => {
        this.exportBytes = { psd: psdBytes, png: pngBytes, jpg: jpgBytes }[format.split(':')[0]];
      };
      this.documents.push(doc);
      return this.activeDocument = doc;
    };
  }
  echoToOE(value) { this.echo = value; }
  open(url, ignored, smart) {
    assert.match(url, /^data:image\/png;base64,/);
    assert.equal(smart, true);
    this.addLayer(this.activeDocument, 'smart');
  }
  addLayer(doc, kind) {
    const shape = [0, 0, 2, 3];
    const textItem = { kind: null, contents: '', font: 'test', position: [0, 0], transform: '[1,0,0,1,0,0]' };
    Object.defineProperty(textItem, 'size', { get() { return { value: this.sizeValue }; }, set(value) { this.sizeValue = value; } });
    const layer = {
      name: 'Layer', kind, typename: 'ArtLayer', visible: true, textItem,
      get bounds() { return shape.map(value => ({ value })); },
      resize(x) { shape[2] = shape[0] + (shape[2] - shape[0]) * x / 100; shape[3] = shape[1] + (shape[3] - shape[1]) * x / 100; },
      translate(x, y) { shape[0] += x; shape[1] += y; shape[2] += x; shape[3] += y; },
      rotate(degrees) { this.rotation = degrees; },
      remove() { doc.layers.splice(doc.layers.indexOf(this), 1); },
      move(ref, place) { this.remove(); doc.layers.splice(doc.layers.indexOf(ref) + (place === 'after' ? 1 : 0), 0, this); }
    };
    doc.layers.unshift(layer);
    doc.activeLayer = layer;
    return layer;
  }
  async connect(takeover = false) {
    this.socket = new WebSocket(origin.replace('http', 'ws') + '/socket', { origin });
    this.socket.on('message', raw => this.message(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.send({ type: 'hello', token, takeover });
    await eventually(() => this.replies.some(m => m.type === 'authenticated'));
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  async ready() {
    this.send({ type: 'editor_idle' });
    await eventually(() => tool('bridge_status'), result => result.photopea_ready);
  }
  message(message) {
    this.replies.push(message);
    if (message.type === 'probe') return this.send({ type: 'probe_ok', id: message.id });
    if (message.type === 'approval') return this.send({ type: 'decision', job_id: message.job_id, approved: this.allowScripts });
    if (message.type !== 'step') return;
    this.steps++;
    const ids = { job_id: message.job_id, step_id: message.step_id };
    this.send({ type: 'ack', ...ids });
    if (!this.auto) return;
    if (message.bytes) {
      this.documents.add(2, 3, 300, 'Opened');
      return this.send({ type: 'complete', ...ids });
    }
    vm.runInNewContext(message.script, {
      app: this, NewDocumentMode: { RGB: 'RGB' }, DocumentFill: { WHITE: 'WHITE', TRANSPARENT: 'TRANSPARENT' },
      LayerKind: { TEXT: 'text', SMARTOBJECT: 'smart' }, TextType: { POINTTEXT: 'point' },
      Justification: { LEFT: 'left', CENTER: 'center', RIGHT: 'right' }, AnchorPosition: { MIDDLECENTER: 'center' },
      ElementPlacement: { PLACEBEFORE: 'before', PLACEAFTER: 'after' },
      SolidColor: class { rgb = { hexValue: '' }; }
    });
    const prefix = 'photopea-bridge:' + message.step_id + ':';
    const result = JSON.parse(this.echo.slice(prefix.length));
    if (message.export && this.exportBytes) {
      const bytes = this.exportBytes;
      this.exportBytes = null;
      this.socket.send(Buffer.concat([Buffer.from(message.job_id + randomUUID()), Buffer.from('stale export')]));
      this.socket.send(Buffer.concat([Buffer.from(message.job_id + message.step_id), bytes]));
    }
    this.send({ type: result.ok ? 'complete' : 'failed', ...ids, value: result.value, error: result.error });
  }
  close() { this.socket.close(); }
}

before(async () => {
  storage = await mkdtemp(join(tmpdir(), 'photopea-test-'));
  const reservation = netServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  origin = 'http://127.0.0.1:' + port;
  app = await createServer({ origin, token, storage, stepTimeout: 650 });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  client = await createClient('auto');
});

after(async () => {
  await client?.close();
  app?.bridge.close();
  if (app) await new Promise(resolve => app.server.close(resolve));
  if (storage) await rm(storage, { recursive: true, force: true });
});

test('current MCP discovery and legacy initialization list the same tools', async () => {
  assert.equal(client.getProtocolEra(), 'modern');
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(), methods);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.deepEqual(t._meta.securitySchemes, [{ type: 'oauth2', scopes: ['photopea:edit'] }]);
  }
  const legacy = await createClient('legacy');
  try {
    assert.equal(legacy.getProtocolEra(), 'legacy');
    assert.deepEqual((await legacy.listTools()).tools.map(t => t.name).sort(), methods);
  } finally { await legacy.close(); }
  assert.ok((await tool('bridge_status')).healthy);
});

test('HTTP rejects unauthorized calls, invalid origins, and malformed tool inputs', async () => {
  const denied = await fetch(origin + '/mcp');
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  assert.equal((await fetch(origin + '/download/' + randomUUID())).status, 401);
  assert.equal((await fetch(origin + '/mcp', { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(origin + '/workspace')).status, 200);
  const malformed = await client.callTool({ name: 'photopea_open_document', arguments: { mode: 'new', width: -1 } });
  assert.equal(malformed.isError, true);
  const wrongOrigin = new WebSocket(origin.replace('http', 'ws') + '/socket', { origin: 'https://other.example' });
  await new Promise(resolve => {
    wrongOrigin.once('error', resolve);
    wrongOrigin.once('open', () => assert.fail('Cross-origin browser was admitted.'));
  });
});

for (const native of [false, true]) {
  test(`OAuth owner consent, PKCE, audience and refresh through ${native ? 'desktop loopback' : 'ChatGPT web'}`, async () => {
    const resource = origin + '/mcp';
    const meta = await (await fetch(origin + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(meta.resource, resource);
    const issuer = await (await fetch(origin + '/.well-known/oauth-authorization-server')).json();
    assert.equal(issuer.issuer, origin);
    assert.deepEqual(issuer.code_challenge_methods_supported, ['S256']);
    const uri = native ? 'http://127.0.0.1:34723/callback' : 'https://chatgpt.com/connector_platform_oauth_redirect';
    const target = native ? {} : { resource };
    function register(redirect_uri) {
      return fetch(issuer.registration_endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirect_uri], token_endpoint_auth_method: 'none' })
      });
    }
    assert.equal((await register(uri + '?next=https://other.example')).status, 400);
    assert.equal((await register('http://127.0.0.1.example.com:34723/callback')).status, 400);
    const registration = await register(uri);
    assert.equal(registration.status, 201);
    const { client_id } = await registration.json();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({ client_id, redirect_uri: uri, response_type: 'code', state: 'csrf-state',
      code_challenge: challenge, code_challenge_method: 'S256', ...target, scope: 'photopea:edit' });
    const consent = await fetch(issuer.authorization_endpoint + '?' + query);
    assert.equal(consent.status, 200);
    const flow = (await consent.text()).match(/name="flow" value="([^"]+)"/)[1];
    const form = new URLSearchParams({ flow, key: token, decision: 'allow' });
    const authCookie = consent.headers.get('set-cookie').split(';')[0];
    // Reject an explicitly foreign Origin, even when a valid flow exists.
    assert.equal((await fetch(issuer.authorization_endpoint, {
      method: 'POST', body: form, headers: { Origin: 'https://attacker.invalid' }
    })).status, 403);
    const redirect = await fetch(issuer.authorization_endpoint, {
      method: 'POST', redirect: 'manual', body: form, headers: { Origin: origin, Cookie: authCookie }
    });
    assert.equal(redirect.status, 303);
    const redirectUrl = new URL(redirect.headers.get('location'));
    assert.equal(redirectUrl.searchParams.get('iss'), origin);
    assert.equal(redirectUrl.searchParams.get('state'), 'csrf-state');
    assert.equal(redirectUrl.origin + redirectUrl.pathname, uri);
    // Some privacy browsers omit first-party cookies. An unguessable flow
    // token plus trusted same-origin Fetch Metadata permits consent safely.
    const consentWithoutCookies = await fetch(issuer.authorization_endpoint + '?' + query);
    assert.equal(consentWithoutCookies.status, 200);
    const cookieFreeFlow = (await consentWithoutCookies.text()).match(/name="flow" value="([^"]+)"/)[1];
    const cookieFreeForm = new URLSearchParams({ flow: cookieFreeFlow, key: token, decision: 'allow' });
    const cookieFreePost = await fetch(issuer.authorization_endpoint, {
      method: 'POST', redirect: 'manual', body: cookieFreeForm,
      headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' }
    });
    assert.equal(cookieFreePost.status, 303);
    // A foreign-origin form submission must fail even with same-origin metadata.
    const forgedConsent = await fetch(issuer.authorization_endpoint + '?' + query);
    const forgedFlow = (await forgedConsent.text()).match(/name="flow" value="([^"]+)"/)[1];
    const forgedPost = await fetch(issuer.authorization_endpoint, {
      method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ flow: forgedFlow, key: token, decision: 'allow' }),
      headers: { Origin: 'https://attacker.invalid', 'Sec-Fetch-Site': 'same-origin' }
    });
    assert.equal(forgedPost.status, 403);
    // A browser with no Origin can still report a protected same-origin request.
    const noOriginConsent = await fetch(issuer.authorization_endpoint + '?' + query);
    const noOriginFlow = (await noOriginConsent.text()).match(/name="flow" value="([^"]+)"/)[1];
    assert.equal((await fetch(issuer.authorization_endpoint, {
      method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ flow: noOriginFlow, key: token, decision: 'allow' }),
      headers: { 'Sec-Fetch-Site': 'same-origin' }
    })).status, 303);
    // Brave may produce an opaque Origin but still supply reliable same-origin
    // Fetch Metadata. That combination can be approved without a cookie.
    const opaquePage = await fetch(issuer.authorization_endpoint + '?' + query);
    const opaqueFlow = (await opaquePage.text()).match(/name="flow" value="([^"]+)"/)[1];
    assert.equal((await fetch(issuer.authorization_endpoint, {
      method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ flow: opaqueFlow, key: token, decision: 'allow' }),
      headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }
    })).status, 303);
    // When privacy features strip both Origin and Fetch Metadata, the valid
    // first-party session cookie plus unguessable flow token still suffice.
    const cookiePage = await fetch(issuer.authorization_endpoint + '?' + query);
    const cookieFlow = (await cookiePage.text()).match(/name="flow" value="([^"]+)"/)[1];
    assert.equal((await fetch(issuer.authorization_endpoint, {
      method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ flow: cookieFlow, key: token, decision: 'allow' }),
      headers: { Cookie: cookiePage.headers.get('set-cookie').split(';')[0] }
    })).status, 303);
    // Never permit a reported cross-site submission even with a valid cookie.
    const crossPage = await fetch(issuer.authorization_endpoint + '?' + query);
    const crossFlow = (await crossPage.text()).match(/name="flow" value="([^"]+)"/)[1];
    assert.equal((await fetch(issuer.authorization_endpoint, {
      method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ flow: crossFlow, key: token, decision: 'allow' }),
      headers: { Cookie: crossPage.headers.get('set-cookie').split(';')[0], 'Sec-Fetch-Site': 'cross-site' }
    })).status, 403);
    function exchange(body) {
      return fetch(issuer.token_endpoint, { method: 'POST', body: new URLSearchParams({ client_id, ...target, ...body }) });
    }
    const codeExchange = { grant_type: 'authorization_code', code: redirectUrl.searchParams.get('code'), redirect_uri: uri, code_verifier: verifier };
    assert.equal((await exchange({ ...codeExchange, resource: origin })).status, 400);
    assert.equal((await exchange({ ...codeExchange, code_verifier: 'a'.repeat(43) })).status, 400);
    const response = await exchange(codeExchange);
    assert.equal(response.status, 200);
    const credentials = await response.json();
    assert.equal((await exchange(codeExchange)).status, 400);
    const authenticated = await createClient('auto', credentials.access_token);
    try { assert.equal((await authenticated.listTools()).tools.length, 8); }
    finally { await authenticated.close(); }
    const refresh = { grant_type: 'refresh_token', refresh_token: credentials.refresh_token };
    assert.equal((await exchange(refresh)).status, 200);
    assert.equal((await exchange(refresh)).status, 400);
  });
}

test('mocked editor runs typed edits and scripts and returns valid download metadata', async () => {
  const browser = new MockPhotopea();
  await browser.connect();
  try {
    const beforeProbe = await tool('bridge_status');
    assert.ok(beforeProbe.connected);
    assert.equal(beforeProbe.photopea_ready, false);
    await browser.ready();
    assert.equal((await tool('bridge_status')).can_execute, true);
    assert.equal((await submit('photopea_open_document', { mode: 'new', name: 'Fixture', width: 800, height: 600 })).result.width, 800);
    const request = { name: 'Title', text: 'A title', x: 50, y: 70, size: 30, rotation: 15, request_id: randomUUID() };
    const title = await submit('photopea_add_text', request);
    assert.equal(title.result.kind, 'text');
    assert.equal(title.result.text, 'A title');
    assert.equal(browser.activeDocument.activeLayer.rotation, 15);
    assert.equal((await tool('photopea_add_text', request)).job_id, title.job_id);
    assert.match((await tool('photopea_add_text', { ...request, text: 'different' })).error, /different parameters/);
    const picture = await submit('photopea_place_image', { name: 'Image', format: 'png', base64: pngBytes.toString('base64'), x: 10, y: 11, scale: 200 });
    assert.equal(picture.result.kind, 'smart_object');
    assert.deepEqual(picture.result.bounds, [10, 11, 14, 17]);
    assert.equal((await submit('photopea_manage_layers', { action: 'rename', path: ['Image'], name: 'New name' })).result.name, 'New name');
    assert.equal((await submit('photopea_manage_layers', { action: 'visibility', path: ['New name'], visible: false })).result.visible, false);
    assert.equal((await submit('photopea_manage_layers', { action: 'text', path: ['Title'], text: 'Updated' })).result.text, 'Updated');
    await submit('photopea_manage_layers', { action: 'reorder', path: ['New name'], relative_to: ['Title'], position: 'below' });
    const layers = await submit('photopea_manage_layers', { action: 'list' });
    assert.deepEqual(layers.result.layers.map(l => l.name), ['Title', 'New name']);
    const transformed = await submit('photopea_manage_layers', { action: 'transform', path: ['New name'], dx: 4, dy: 6 });
    assert.deepEqual(transformed.result.bounds, [14, 17, 18, 23]);
    assert.match((await submit('photopea_manage_layers', { action: 'rename', path: ['Missing'], name: 'Example' })).error, /not found/i);
    browser.allowScripts = false;
    assert.equal((await submit('photopea_run_script', { script: 'return 1;' })).status, 'failed');
    browser.allowScripts = true;
    assert.equal((await submit('photopea_run_script', { script: 'return 42;' })).result, 42);

    for (const [format, bytes] of [['psd', psdBytes], ['png', pngBytes], ['jpg', jpgBytes], ['pdf', undefined]]) {
      const exported = await submit('photopea_export', { format, name: 'fixture' });
      assert.equal(exported.status, 'completed', JSON.stringify(exported));
      assert.equal((await fetch(exported.download_url)).status, 401);
      const file = await fetch(exported.download_url, { headers });
      assert.equal(file.status, 200);
      assert.equal(file.headers.get('content-disposition'), 'attachment; filename="fixture.' + format + '"');
      const actual = Buffer.from(await file.arrayBuffer());
      if (bytes) assert.deepEqual(actual, bytes);
      else assert.deepEqual((await PDFDocument.load(actual)).getPage(0).getSize(), { width: 0.48, height: 0.72 });
    }
    const imported = await submit('photopea_open_document', { mode: 'asset', format: 'psd', base64: psdBytes.toString('base64'), name: 'Reopened' });
    assert.equal(imported.result.name, 'Reopened');
    assert.equal((await submit('photopea_open_document', { mode: 'activate', name: 'Fixture' })).result.name, 'Fixture');
  } finally {
    browser.close();
    await eventually(() => tool('bridge_status'), current => !current.connected);
  }
});

test('timeout and reconnect never replay an edit or execute a queued command against another workspace', async () => {
  const browser = new MockPhotopea();
  await browser.connect();
  await browser.ready();
  browser.auto = false;
  const args = { mode: 'new', name: 'Timeout', width: 40, height: 40, request_id: randomUUID() };
  const first = await tool('photopea_open_document', args);
  const second = await tool('photopea_open_document', { ...args, request_id: randomUUID(), name: 'Waiting' });
  await eventually(() => status(first.job_id), terminal);
  assert.equal((await status(first.job_id)).status, 'uncertain');
  assert.equal((await status(second.job_id)).status, 'failed');
  assert.equal(browser.steps, 1);
  await eventually(() => tool('bridge_status'), current => !current.connected);
  const reconnected = new MockPhotopea();
  await reconnected.connect();
  try {
    await reconnected.ready();
    assert.equal((await tool('photopea_open_document', args)).job_id, first.job_id);
    assert.equal(reconnected.steps, 0);
    const fresh = await submit('photopea_open_document', { ...args, request_id: randomUUID() });
    assert.equal(fresh.status, 'completed');
  } finally {
    reconnected.close();
    await eventually(() => tool('bridge_status'), current => !current.connected);
  }
});

test('a newly authorized tab replaces an idle paired workspace without losing active edits', async () => {
  const first = new MockPhotopea();
  await first.connect();
  await first.ready();
  // Automatic reconnects must not displace a currently paired editor.
  const automatic = new WebSocket(origin.replace('http', 'ws') + '/socket', { origin });
  const autoRejected = new Promise(resolve => automatic.once('close',
    (code, reason) => resolve({ code, reason: reason.toString() })));
  await new Promise((resolve, reject) => {
    automatic.once('open', resolve);
    automatic.once('error', reject);
  });
  automatic.send(JSON.stringify({ type: 'hello', token, takeover: false }));
  const automaticResult = await autoRejected;
  assert.equal(automaticResult.code, 1008);
  assert.match(automaticResult.reason, /Another workspace is paired/);
  assert.equal((await tool('bridge_status')).can_execute, true);

  const displaced = new Promise(resolve => first.socket.once('close',
    (code, reason) => resolve({ code, reason: reason.toString() })));

  const second = new MockPhotopea();
  try {
    await second.connect(true);
    const displacedResult = await displaced;
    assert.equal(displacedResult.code, 1000);
    assert.equal(displacedResult.reason, 'Replaced by another workspace');
    await second.ready();
    assert.equal((await tool('bridge_status')).can_execute, true);

    const edited = await submit('photopea_open_document', {
      mode: 'new', name: 'Replacement test', width: 100, height: 100
    });
    assert.equal(edited.status, 'completed');
    assert.equal(first.steps, 0);
    assert.equal(second.steps, 1);

    // Protect an in-progress operation from a third tab taking control.
    second.auto = false;
    const running = await tool('photopea_open_document', {
      mode: 'new', name: 'Protected edit', width: 60, height: 60,
      request_id: randomUUID()
    });
    await eventually(() => status(running.job_id), result => result.status === 'running');
    const challenger = new WebSocket(origin.replace('http', 'ws') + '/socket', { origin });
    const rejected = new Promise(resolve => challenger.once('close',
      (code, reason) => resolve({ code, reason: reason.toString() })));
    await new Promise((resolve, reject) => {
      challenger.once('open', resolve);
      challenger.once('error', reject);
    });
    challenger.send(JSON.stringify({ type: 'hello', token, takeover: true }));
    const rejection = await rejected;
    assert.equal(rejection.code, 1008);
    assert.match(rejection.reason, /running a command/);
    assert.equal((await tool('bridge_status')).connected, true);
    assert.equal((await eventually(() => status(running.job_id), terminal)).status, 'uncertain');
  } finally {
    second.close();
    first.close();
    await eventually(() => tool('bridge_status'), value => !value.connected);
  }
});
