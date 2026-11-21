import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCOPE = 'photopea:edit';
const opaque = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
export function matches(a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}

export async function readBody(req, max) {
  const parts = [];
  let bytes = 0;
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw Object.assign(new Error('Request too large.'), { status: 413 });
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    bytes += part.length;
    if (bytes > max) throw Object.assign(new Error('Request too large.'), { status: 413 });
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8', ...headers
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function html(res, status, body, headers) {
  send(res, status, '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Photopea</title>' +
    '<style>body{font:16px system-ui;max-width:44rem;margin:12vh auto;padding:1rem}input,button{font:inherit;margin:.5rem 0;padding:.5rem}input{width:min(22rem,90%)}</style>' + body + '</html>',
  { 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'",
    ...headers });
}

const nativeRedirect = uri => typeof uri === 'string' &&
  /^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}\/callback(?:\/[a-zA-Z0-9_-]{1,128})?$/.test(uri) &&
  Number(uri.match(/:(\d+)\//)[1]) <= 65535;
const redirectAllowed = uri => nativeRedirect(uri) || (typeof uri === 'string' &&
  /^https:\/\/chatgpt\.com\/(?:connector_platform_oauth_redirect|connector\/oauth\/[a-zA-Z0-9_-]{1,128})$/.test(uri));

export function createOAuth({ origin, ownerSecret, signingKey }) {
  const resource = origin + '/mcp';
  const metadataPath = '/.well-known/oauth-protected-resource/mcp';
  const pending = new Map(), codes = new Map(), access = new Map(), refresh = new Map();
  const cookieName = origin.startsWith('https:') ? '__Host-photopea_authorize' : 'photopea_authorize';
  const cookie = value => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}`;
  let invalidPasswords = 0, blockedUntil = 0;
  const clientId = (uri, nonce = opaque()) => 'photopea.' + nonce + '.' + createHmac('sha256', signingKey)
    .update('oauth-client:' + resource + ':' + uri + ':' + nonce).digest('base64url');
  function validClient(client, uri) {
    const nonce = client?.match(/^photopea\.([a-zA-Z0-9_-]{43})\.[a-zA-Z0-9_-]{43}$/)?.[1];
    return !!nonce && matches(client, clientId(uri, nonce));
  }

  function targetsResource(value, redirect) {
    // The native client may omit resource. This issuer serves only one audience.
    return value === resource || (value === null && nativeRedirect(redirect));
  }

  function trim(map, cap) {
    const now = Date.now();
    for (const [key, record] of map) if (record.expires <= now) map.delete(key);
    return map.size < cap;
  }

  function read(map, key) {
    if (!key) return;
    const record = map.get(digest(key));
    if (record?.expires > Date.now()) return record;
    map.delete(digest(key));
  }

  function mint(map, record, ttl) {
    const key = opaque();
    map.set(digest(key), { ...record, expires: Date.now() + ttl * 1000 });
    return key;
  }

  function fail(res, error, status = 400) { send(res, status, { error }); }

  function issue(res, grant) {
    if (!trim(access, 512) || !trim(refresh, 128)) return fail(res, 'temporarily_unavailable', 503);
    const claims = { client: grant.client, uri: grant.uri, resource, scope: SCOPE };
    send(res, 200, {
      access_token: mint(access, claims, 3600), token_type: 'Bearer', expires_in: 3600,
      refresh_token: mint(refresh, claims, 30 * 86400), scope: SCOPE
    });
  }

  async function handle(req, res, url) {
    const { pathname, searchParams } = url;
    if (pathname === metadataPath || pathname === '/.well-known/oauth-protected-resource') {
      return send(res, 200, { resource, authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'] });
    }
    if (pathname === '/.well-known/oauth-authorization-server') {
      return send(res, 200, {
        issuer: origin, authorization_endpoint: origin + '/oauth/authorize',
        token_endpoint: origin + '/oauth/token', registration_endpoint: origin + '/oauth/register',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [SCOPE], authorization_response_iss_parameter_supported: true
      });
    }
    if (pathname === '/oauth/register' && req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) return fail(res, 'invalid_client_metadata');
      let input;
      try { input = JSON.parse(await readBody(req, 8192)); } catch { return fail(res, 'invalid_client_metadata'); }
      if (!Array.isArray(input?.redirect_uris) || input.redirect_uris.length !== 1 || !redirectAllowed(input.redirect_uris[0])) {
        return fail(res, 'invalid_redirect_uri');
      }
      if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') return fail(res, 'invalid_client_metadata');
      return send(res, 201, {
        client_id: clientId(input.redirect_uris[0]), client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: input.redirect_uris,
        response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none', scope: SCOPE
      });
    }
    if (pathname === '/oauth/authorize' && req.method === 'GET') {
      const uri = searchParams.get('redirect_uri'), client = searchParams.get('client_id');
      const state = searchParams.get('state'), challenge = searchParams.get('code_challenge');
      const requestedScopes = (searchParams.get('scope') ?? '').split(' ').filter(Boolean);
      if (!redirectAllowed(uri) || !validClient(client, uri)) return fail(res, 'invalid_client');
      if (searchParams.get('response_type') !== 'code' || !targetsResource(searchParams.get('resource'), uri) ||
          searchParams.get('code_challenge_method') !== 'S256' || !/^[\w-]{43}$/.test(challenge ?? '') ||
          !state || state.length > 1024 || requestedScopes.some(scope => scope !== SCOPE) ||
          [...new Set(searchParams.keys())].some(key => searchParams.getAll(key).length > 1)) {
        return fail(res, 'invalid_request');
      }
      if (!trim(pending, 256)) return fail(res, 'temporarily_unavailable', 503);
      const nonce = opaque();
      const flow = mint(pending, { state, challenge, client, uri, nonce: digest(nonce) }, 300);
      return html(res, 200, '<h1>Authorize Photopea editing</h1><p>Allow ChatGPT to list documents, make edits and request exports in your paired Photopea workspace.</p>' +
        '<form method="post" action="/oauth/authorize"><input type="hidden" name="flow" value="' + flow + '">' +
        '<label for="key">Owner authorization key</label><br><input required id="key" type="password" name="key" autocomplete="off" maxlength="512"><br>' +
        '<button name="decision" value="allow">Authorize editing</button><button name="decision" value="deny" formnovalidate>Cancel</button></form>',
      { 'Set-Cookie': cookie(nonce) + '; Max-Age=300' });
    }
    if (pathname === '/oauth/authorize' && req.method === 'POST') {
      if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return fail(res, 'invalid_request', 403);
      const form = new URLSearchParams(await readBody(req, 4096));
      const key = form.get('flow');
      const grant = read(pending, key);
      const nonce = req.headers.cookie?.split('; ').find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      if (!grant || !nonce || !matches(grant.nonce, digest(nonce))) return fail(res, 'invalid_request', 403);
      if (form.get('decision') !== 'deny') {
        if (Date.now() < blockedUntil) return html(res, 429, '<h1>Try again in one minute</h1>');
        if (form.get('decision') !== 'allow' || !matches(form.get('key'), ownerSecret)) {
          if (++invalidPasswords >= 8) { blockedUntil = Date.now() + 60_000; invalidPasswords = 0; }
          return html(res, 403, '<h1>Authorization key rejected</h1><p>Go back to try again.</p>');
        }
        invalidPasswords = 0;
      }
      pending.delete(digest(key));
      const destination = new URL(grant.uri);
      destination.searchParams.set('state', grant.state);
      destination.searchParams.set('iss', origin);
      if (form.get('decision') === 'deny') destination.searchParams.set('error', 'access_denied');
      else if (!trim(codes, 256)) destination.searchParams.set('error', 'temporarily_unavailable');
      else destination.searchParams.set('code', mint(codes, grant, 90));
      return send(res, 303, '', { Location: destination.href, 'Set-Cookie': cookie('') + '; Max-Age=0' });
    }
    if (pathname === '/oauth/token' && req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return fail(res, 'invalid_request');
      const form = new URLSearchParams(await readBody(req, 8192));
      if ([...new Set(form.keys())].some(key => form.getAll(key).length > 1)) return fail(res, 'invalid_request');
      const type = form.get('grant_type');
      const map = type === 'authorization_code' ? codes : type === 'refresh_token' ? refresh : null;
      if (!map) return fail(res, 'unsupported_grant_type');
      const key = form.get(type === 'authorization_code' ? 'code' : 'refresh_token');
      const grant = read(map, key);
      if (!grant || !matches(form.get('client_id'), grant.client)) return fail(res, 'invalid_grant');
      if (!targetsResource(form.get('resource'), grant.uri)) return fail(res, 'invalid_target');
      if (type === 'authorization_code') {
        const verifier = form.get('code_verifier') ?? '';
        if (form.get('redirect_uri') !== grant.uri || !/^[\w.~-]{43,128}$/.test(verifier) ||
            !matches(digest(verifier), grant.challenge)) return fail(res, 'invalid_grant');
      } else if (form.has('scope') && form.get('scope') !== SCOPE) return fail(res, 'invalid_scope');
      map.delete(digest(key));
      return issue(res, grant);
    }
    return fail(res, 'not_found', 404);
  }

  return {
    handle,
    verify: key => !!key && read(access, key)?.resource === resource,
    challenge: `Bearer resource_metadata="${origin + metadataPath}", scope="${SCOPE}"`
  };
}
