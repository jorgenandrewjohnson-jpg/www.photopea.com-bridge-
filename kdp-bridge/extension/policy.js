export function route(value) {
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.username || u.password || u.port || u.protocol !== 'https:') return null;
  if (u.hostname === 'cc.amazon.com') return {stage: 'cover_creator', path: 'https://cc.amazon.com/'};
  if (u.hostname !== 'kdp.amazon.com') return null;
  const path = u.origin + u.pathname;
  const base = u.pathname.replace(/^\/[a-z]{2}_[A-Z]{2}(?=\/)/, '');
  if (/^\/(bookshelf|create)\/?$/.test(base)) return {stage: base.split('/')[1], path};
  const match = base.match(/^\/(?:title-setup|print-setup)\/(paperback|hardcover|kindle-ebook|kindle|ebook)\/([A-Za-z0-9_-]+)\/(details|content|pricing|rights-and-pricing)\/?$/);
  if (match) return {edition: match[1], edition_id: match[2], stage: match[3], path};
  if (/^\/(?:series-setup|series-manager)(?:\/[\w-]+)*\/?$/.test(base)) return {stage: 'series', path};
  if (/^\/(?:[\w-]+\/)*(?:print-preview|print-previewer|previewer|online-previewer)(?:\/[\w-]+)*\/?$/i.test(base)) return {stage:'previewer', path:u.origin + '/[previewer]'};
  return null;
}
export function openable(value) {
  const page = route(value);
  if (!page || ['cover_creator','previewer'].includes(page.stage)) return false;
  const u = new URL(value);
  return !u.search && !u.hash && (['bookshelf','create'].includes(page.stage) || (page.edition_id && page.edition_id !== 'new'));
}
export function bridgeOrigin(value) {
  const u = new URL(value);
  const local = u.protocol === 'http:' && u.hostname === '127.0.0.1' && !!u.port;
  if ((!local && !(u.protocol === 'https:' && /^[a-z0-9-]+\.onrender\.com$/.test(u.hostname) && !u.port)) || u.origin !== value) throw Error('Enter the exact Render HTTPS origin or a loopback test origin');
  return u.origin;
}

// Filename precheck only; the native host independently enforces path allowlists.
export const isPdfPath = value => typeof value === 'string' && /\.pdf$/i.test(value);

/** Conservative status classification. Amazon acceptance requires positive evidence,
 * never a browser-side dispatched event, progress bar, or selected file alone. */
export function classifyUpload(observedText, fileName='') {
  const text=String(observedText||'');
  if (/upload (?:failed|error)|error uploading|unable to (?:upload|process)|file (?:rejected|invalid)/i.test(text))
    return 'rejected_or_error';
  if (/processing|uploading|please wait|checking file|validating (?:your )?file/i.test(text))
    return 'processing';
  // A generic 'uploaded' elsewhere on the page is not filename-specific proof.
  const escaped=String(fileName||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if (escaped && new RegExp(escaped+'[\\s\\S]{0,180}(?:successfully uploaded|upload complete|processed successfully|approved)','i').test(text))
    return 'accepted_observed';
  return 'unverified';
}
export function contentBlockers(observedText) {
  const t=String(observedText||'');
  return {
    cover_missing:/no cover uploaded|launch cover creator to create your required cover/i.test(t),
    preview_approval_required:/please preview and approve your book/i.test(t),
    saving:/\\bsaving\\.{0,3}(?:\\s|$)/i.test(t),
    unsaved_changes:/unsaved changes|continue without saving/i.test(t),
  };
}
