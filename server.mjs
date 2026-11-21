import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { createBridge } from './bridge.mjs';
import { createOAuth, matches, send, SCOPE } from './oauth.mjs';
import { makeOperation } from './photopea.mjs';

const version = '0.3.1';
const directory = fileURLToPath(new URL('.', import.meta.url));
const name = z.string().trim().min(1).max(200);
const fileName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/).optional();
const text = z.string().min(1).max(6000);
const coordinate = z.number().min(-30_000).max(30_000);
const scale = z.number().min(1).max(1000);
const rotation = z.number().min(-360).max(360);
const layerPath = z.array(name).min(1).max(12);
const requestKey = z.string().min(8).max(128).optional().describe('Reuse this ID with identical arguments when retrying a request.');
const ownerScope = { type: 'oauth2', scopes: [SCOPE] };
const base64 = z.string().min(8).max(2_800_000).describe('Base64 file content without a data URL prefix, approximately 2 MiB maximum.');

function operationSchema(shape) { return z.strictObject({ ...shape, request_id: requestKey }); }

const operationTools = [
  ['photopea_open_document', 'Create a new RGB document, activate an exact open document name, open a small base64 PSD/PNG/JPG. Load large PSDs through the paired workspace. Poll job_status.',
    z.discriminatedUnion('mode', [
      operationSchema({ mode: z.literal('new'), name, width: z.number().int().min(1).max(12000),
        height: z.number().int().min(1).max(12000), dpi: z.number().int().min(72).max(600).default(300),
        background: z.enum(['white', 'transparent']).default('white') }),
      operationSchema({ mode: z.literal('activate'), name }),
      operationSchema({ mode: z.literal('asset'), name, format: z.enum(['psd', 'png', 'jpg']), base64 })
    ])],
  ['photopea_add_text', 'Add an editable point-text layer in the active document. x and y are the text anchor in canvas pixels, size is in Photopea text units (pixels), and rotation is in degrees. Poll job_status.',
    operationSchema({ name, text, font: name.optional().describe('Use a Photopea/PostScript font name.'), x: coordinate, y: coordinate,
      size: z.number().min(1).max(2000), color: z.string().regex(/^#[a-fA-F0-9]{6}$/).default('#202020'),
      alignment: z.enum(['left', 'center', 'right']).default('left'), rotation: rotation.default(0) })],
  ['photopea_place_image', 'Place a small PNG/JPG in the active document as an embedded editable Smart Object. x/y locate its visible upper left in pixels after scaling; 100 is unchanged scale. Poll job_status.',
    operationSchema({ name, format: z.enum(['png', 'jpg']), base64, x: coordinate, y: coordinate, scale: scale.default(100) })],
  ['photopea_manage_layers', 'List layers and editable text, rename, change visibility, replace text contents, reorder within a group, or translate, resize and rotate a layer. Paths contain exact layer/group names; list first. Scaling is percent about layer center, rotation is degrees, and translation is pixels. Poll job_status.',
    z.discriminatedUnion('action', [
      operationSchema({ action: z.literal('list') }), operationSchema({ action: z.literal('rename'), path: layerPath, name }),
      operationSchema({ action: z.literal('visibility'), path: layerPath, visible: z.boolean() }),
      operationSchema({ action: z.literal('text'), path: layerPath, text }),
      operationSchema({ action: z.literal('transform'), path: layerPath, scale: scale.optional(), rotation: rotation.optional(), dx: coordinate.optional(), dy: coordinate.optional() }),
      operationSchema({ action: z.literal('reorder'), path: layerPath, relative_to: layerPath, position: z.enum(['above', 'below']) })
    ])],
  ['photopea_run_script', 'Request execution of a Photopea scripting DOM command in the active paired browser. The workspace operator must approve the displayed script. Use typed tools for routine edits. Return a small JSON-serializable value to report results. Poll job_status.',
    operationSchema({ script: z.string().trim().min(1).max(20000) })],
  ['photopea_export', 'Export the active document as editable PSD, flattened PNG/JPG, or a single-page flattened RGB PDF. PDF uses the active document’s physical size and supports up to 18 megapixels. Download through the paired workspace or authenticated download URL. Poll job_status.',
    z.discriminatedUnion('format', [
      operationSchema({ format: z.literal('psd'), name: fileName }),
      operationSchema({ format: z.literal('png'), name: fileName }),
      operationSchema({ format: z.literal('jpg'), name: fileName, quality: z.number().min(0.1).max(1).default(0.95) }),
      operationSchema({ format: z.literal('pdf'), name: fileName })
    ])]
];

function result(value, isError = false) {
  return { isError, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolsFor(bridge) {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'photopea-cover-bridge', version }, {
      instructions: 'Check bridge_status before editing. Poll job_status for each job. Only completed jobs confirm Photopea results. A paired workspace can download exports without adding credentials to chat.'
    });
    const register = (name, description, inputSchema, handler, annotations) => {
      mcp.registerTool(name, {
        description, inputSchema, annotations,
        securitySchemes: [ownerScope], _meta: { securitySchemes: [ownerScope] }
      }, args => {
        try { return result(handler(args)); }
        catch (error) { return result({ error: error.message }, true); }
      });
    };
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    register('bridge_status', 'Report bridge health, browser pairing, editor responsiveness and command availability.', z.strictObject({}), bridge.status, readOnly);
    register('job_status', 'Get a job state, error, confirmed result or private export download URL.', z.strictObject({ job_id: z.uuid() }), a => bridge.job(a.job_id), readOnly);
    for (const [tool, description, schema] of operationTools) {
      register(tool, description, schema, ({ request_id, ...args }) => {
        return bridge.enqueue(tool, makeOperation(tool, args), request_id, args);
      }, { readOnlyHint: false, destructiveHint: ['photopea_run_script', 'photopea_manage_layers'].includes(tool),
        idempotentHint: false, openWorldHint: tool === 'photopea_run_script' });
    }
    return mcp;
  }, { maxRequestBodySize: 3_000_000, maxSubscriptions: 4 });
  return { handle: toNodeHandler(handler), close: () => handler.close() };
}

export async function createServer({
  origin, token, ownerSecret = token, storage = join(directory, 'exports'), maxFile = 100_000_000, stepTimeout
}) {
  const base = new URL(origin);
  if (base.origin !== origin || (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname))) {
    throw new Error('PUBLIC_ORIGIN requires a canonical HTTPS origin or a loopback HTTP origin.');
  }
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || ownerSecret.length < 32 || ownerSecret.length > 512) {
    throw new Error('Bridge and owner authorization keys must contain 32–512 characters.');
  }
  if (!Number.isSafeInteger(maxFile) || maxFile < 1024 || maxFile > 100_000_000) {
    throw new Error('MAX_FILE_BYTES must be between 1024 and 100000000.');
  }

  const html = await readFile(join(directory, 'workspace.html'), 'utf8');
  const script = await readFile(join(directory, 'workspace.js'), 'utf8');
  const oauth = createOAuth({ origin, ownerSecret, signingKey: token });
  const server = http.createServer({ requestTimeout: 20_000, headersTimeout: 10_000 }, async (req, res) => {
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.headers.host !== base.host) {
        return send(res, 400, { error: 'Invalid request host.' });
      }
      const url = new URL(req.url, origin);
      const { pathname } = url;
      if (req.method === 'GET' && pathname === '/health') {
        return send(res, 200, { ok: true, service: 'photopea-cover-bridge', version });
      }
      if (req.method === 'GET' && ['/', '/workspace', '/workspace.js'].includes(pathname)) {
        const htmlPage = pathname !== '/workspace.js';
        return send(res, 200, htmlPage ? html : script, {
          'Content-Type': htmlPage ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src https://www.photopea.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
        });
      }
      if (pathname.startsWith('/oauth/') || (req.method === 'GET' && pathname.startsWith('/.well-known/oauth-'))) {
        return await oauth.handle(req, res, url);
      }
      if (pathname === '/mcp' || (req.method === 'GET' && pathname.startsWith('/download/'))) {
        const headerOrigin = req.headers.origin;
        if (headerOrigin && headerOrigin !== origin) return send(res, 403, { error: 'Origin is not allowed.' });
        const bearer = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
        const oldToken = bearer || req.headers['x-api-key'];
        if (!(matches(oldToken, token) || oauth.verify(bearer))) {
          return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': oauth.challenge });
        }
        if (pathname === '/mcp') {
          res.setHeader('Cache-Control', 'no-store');
          return await mcp.handle(req, res);
        }
        return bridge.download(pathname.slice('/download/'.length), res);
      }
      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      send(res, error.status ?? 500, { error: error.status ? error.message : 'Bridge request failed.' });
    }
  });

  const bridge = await createBridge(server, { origin, token, storage, maxFile, stepTimeout });
  const mcp = toolsFor(bridge);
  server.on('close', () => { bridge.close(); void mcp.close(); });
  return { server, bridge };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const origin = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + port;
  const { server, bridge } = await createServer({
    origin, token: process.env.BRIDGE_TOKEN, ownerSecret: process.env.MCP_OWNER_KEY,
    storage: process.env.STORAGE_DIR, maxFile: Number(process.env.MAX_FILE_BYTES ?? 100_000_000)
  });
  server.listen(port, '0.0.0.0', () => console.log('Photopea bridge ' + version + ' listening.'));
  process.once('SIGTERM', () => { bridge.close(); server.close(); });
}
