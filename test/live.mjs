import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';

const endpoint = new URL(process.env.MCP_URL || 'http://localhost:3000/mcp');
const token = process.env.BRIDGE_TOKEN;
assert.ok(token, 'Set BRIDGE_TOKEN in your local environment before running the live test.');
const headers = { Authorization: 'Bearer ' + token };
const client = new Client({ name: 'photopea-live-tests', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } }));

async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(JSON.stringify(response.structuredContent ?? response.content));
  return response.structuredContent;
}

async function run(name, args) {
  const { job_id } = await call(name, { ...args, request_id: randomUUID() });
  const expires = Date.now() + 45_000;
  while (Date.now() < expires) {
    const job = await call('job_status', { job_id });
    if (job.status === 'completed') {
      console.log(name, args.action || args.format || args.mode || '', JSON.stringify(job.result));
      return job;
    }
    if (job.status === 'failed' || job.status === 'uncertain') throw new Error(JSON.stringify(job));
    await wait(250);
  }
  throw new Error('Timed out waiting for job ' + job_id);
}

const { format } = new Intl.DateTimeFormat('en-CA', { timeStyle: 'medium', hourCycle: 'h23', timeZone: 'UTC' });
const fixture = 'Bridge QA ' + format(new Date()).replaceAll(':', '-');
const output = await mkdtemp(join(tmpdir(), 'photopea-live-'));
try {
  assert.equal((await client.listTools()).tools.length, 9);
  assert.equal((await call('bridge_status')).photopea_ready, true, 'Pair a disposable Photopea workspace first.');
  const created = await run('photopea_open_document', { mode: 'new', name: fixture, width: 540, height: 400, dpi: 300 });
  assert.deepEqual(created.result, { name: fixture, width: 540, height: 400, dpi: 300 });
  const title = await run('photopea_add_text', {
    name: 'Editable title', text: 'Photopea Bridge', font: 'DejaVuSerif', size: 38,
    color: '#3f2459', x: 270, y: 120, alignment: 'center', rotation: 8
  });
  assert.equal(title.result.kind, 'text');
  assert.equal(title.result.text, 'Photopea Bridge');
  assert.equal(title.result.font, 'DejaVuSerif');
  assert.equal(title.result.size, 38);
  assert.ok(Math.abs(title.result.transform[1]) > 0.1);

  const png = new PNG({ width: 35, height: 27 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 192;
    png.data[i + 1] = 82;
    png.data[i + 2] = 63;
    png.data[i + 3] = 255;
  }
  const placed = await run('photopea_place_image', {
    name: 'Editable artwork', format: 'png', base64: PNG.sync.write(png).toString('base64'), x: 80, y: 200, scale: 80
  });
  assert.equal(placed.result.kind, 'smart_object');
  assert.ok(Math.abs(placed.result.bounds[0] - 80) <= 1);
  assert.ok(Math.abs(placed.result.bounds[1] - 200) <= 1);
  const path = ['Artwork renamed'];
  await run('photopea_manage_layers', { action: 'rename', path: ['Editable artwork'], name: path[0] });
  assert.equal((await run('photopea_manage_layers', { action: 'visibility', path, visible: false })).result.visible, false);
  assert.equal((await run('photopea_manage_layers', { action: 'visibility', path, visible: true })).result.visible, true);
  const updated = await run('photopea_manage_layers', { action: 'text', path: ['Editable title'], text: 'Edited through MCP' });
  assert.equal(updated.result.text, 'Edited through MCP');
  await run('photopea_manage_layers', { action: 'reorder', path, relative_to: ['Editable title'], position: 'below' });
  const transformed = await run('photopea_manage_layers', { action: 'transform', path, scale: 125, dx: 18, dy: 12 });
  assert.ok(transformed.result.bounds[2] - transformed.result.bounds[0] > placed.result.bounds[2] - placed.result.bounds[0]);
  const listed = await run('photopea_manage_layers', { action: 'list' });
  assert.deepEqual(listed.result.layers.slice(0, 2).map(layer => layer.name), ['Editable title', 'Artwork renamed']);
  if (process.env.TEST_SCRIPT_APPROVAL === '1') {
    const scripted = await run('photopea_run_script', { script: 'return app.activeDocument.name;' });
    assert.equal(scripted.result, fixture);
  }

  let psd;
  for (const format of ['psd', 'png', 'jpg', 'pdf']) {
    const exported = await run('photopea_export', { format, name: 'bridge-qa' });
    const file = await fetch(exported.download_url, { headers });
    assert.equal(file.status, 200);
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.length, exported.bytes);
    await writeFile(join(output, 'bridge-qa.' + format), bytes);
    if (format === 'psd') {
      assert.equal(bytes.subarray(0, 4).toString(), '8BPS');
      assert.equal(bytes.readUInt32BE(14), 400);
      assert.equal(bytes.readUInt32BE(18), 540);
      psd = bytes;
    }
    if (format === 'png') assert.equal(PNG.sync.read(bytes).width, 540);
    if (format === 'jpg') assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
    if (format === 'pdf') assert.deepEqual((await PDFDocument.load(bytes)).getPage(0).getSize(), { width: 129.6, height: 96 });
  }
  await run('photopea_open_document', { mode: 'asset', name: fixture + ' reopened', format: 'psd', base64: psd.toString('base64') });
  const reopened = await run('photopea_manage_layers', { action: 'list' });
  assert.equal(reopened.result.layers[0].text, 'Edited through MCP');
  assert.equal(reopened.result.layers[1].kind, 'smart_object');
  await run('photopea_open_document', { mode: 'activate', name: fixture });
  console.log('Live Photopea check passed. Outputs in ' + output);
} finally { await client.close(); }
