// Pure validation shared by the Brave worker and regression tests.
// Files are only received over the authenticated MCP -> paired-Brave channel.
export const REMOTE_CHUNK_BYTES = 24 * 1024;
export const REMOTE_MAX_BYTES = 250 * 1024 * 1024;
export const REMOTE_TTL_MS = 20 * 60 * 1000;

export function validateRemoteManifest(a, page) {
  if (!page || page.stage !== 'content' || page.edition_id === 'new' ||
      page.edition !== a.edition || page.edition_id !== a.edition_id ||
      (a.expected_path && a.expected_path !== page.path))
    throw Error('Select the exact saved KDP edition Content page');
  if (!['cover','manuscript'].includes(a.kind)) throw Error('Invalid PDF role');
  if (typeof a.name !== 'string' || a.name.length > 180 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 _().+-]*\.pdf$/i.test(a.name) ||
      a.name.includes('..'))
    throw Error('Use a simple PDF filename without paths');
  if (!Number.isSafeInteger(a.size) || a.size <= 0 || a.size > REMOTE_MAX_BYTES)
    throw Error('Invalid PDF size (maximum 250 MiB)');
  if (!/^[a-f0-9]{64}$/i.test(a.sha256 || ''))
    throw Error('Provide the PDF SHA-256 before transfer');
  return true;
}
export function decodeRemoteChunk(value) {
  if (typeof value !== 'string' || !value.length ||
      value.length > REMOTE_CHUNK_BYTES * 4 / 3 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw Error('Invalid base64 PDF chunk');
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length > REMOTE_CHUNK_BYTES)
    throw Error('PDF chunk exceeds allowed size');
  return bytes;
}
