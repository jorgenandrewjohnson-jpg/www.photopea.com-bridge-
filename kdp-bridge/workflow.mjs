// Project only edition-bound, allowlisted observations from Brave's existing scanner.
import {route} from './extension/policy.js';

export const savedEditionId = /^(?!new$)[A-Za-z0-9_-]{1,64}$/i;
const stages = ['content', 'pricing', 'details'];
const stageGroup = stage => stage === 'rights-and-pricing' ? 'pricing' : stage;
const unique = values => [...new Set(values)];
function consensus(values) {
  const distinct = unique(values);
  return distinct.length === 1 ? distinct[0] : null;
}

// The only free-form output is a book's dedicated title field on Details.
// Skip opaque, contact, credential-like and multiline values, including scanner redactions.
function bookTitle(value) {
  if (typeof value !== 'string' || value.length > 160 ||
      !/^[\p{L}\p{M}\p{N} ,.:;!?'"‘’“”()&–—-]+$/u.test(value)) return null;
  const sensitive = /\b(?:password|passphrase|token|secret|bearer|api[ -]?key|authorization|https?|www)\b|\b(?:sk-|(?:AKIA|ASIA)[A-Z0-9]{16})|\w+\.\w{2,}/i;
  if (sensitive.test(value) || /[\p{L}\d-]{32,}|\d{6,}/u.test(value)) return null;
  return value.trim() || null;
}

function isbn(value) {
  if (typeof value !== 'string' || !/^[0-9X -]{10,22}$/i.test(value)) return null;
  const n = value.replace(/[ -]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(n) && [...n].reduce((sum,d,i)=>sum+Number(d)*(i%2 ? 3 : 1),0)%10 === 0) return n;
  if (/^\d{9}[\dX]$/.test(n) && [...n].reduce((sum,d,i)=>sum+(d==='X' ? 10 : Number(d))*(10-i),0)%11 === 0) return n;
  return null;
}

function usd(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:USD\s*|\$\s*)?(\d{1,5}(?:\.\d{2})?)(?:\s+USD)?$/i.exec(value.trim());
  return match && Number(match[1]) > 0 ? Number(match[1]).toFixed(2) : null;
}

function pricingFields(controls) {
  const prices = [], rights = [];
  for (const c of controls) {
    const label = c.label;
    // Bare numeric fields require an unambiguous Amazon.com row as well as a list-price label.
    const marketLabel = /^(?:Amazon\.com list price|List price (?:for )?Amazon\.com)(?: \(USD\))?$/i.test(label);
    const priceLabel = /^list price(?: \(USD\))?$/i.test(label);
    const marketRow = typeof c.context === 'string' && /^Amazon\.com(?:\s|$)/i.test(c.context);
    // KDP's current Pricing page labels this input "Price for Amazon.com in USD".
    const nativePriceLabel = /^Price for Amazon\.com in USD$/i.test(label) && marketRow;
    const otherMarket = /Amazon\.(?!com(?:\s|$))|\b(?:CAD|AUD|GBP|EUR|JPY|INR|PLN|SEK|BRL|MXN)\b/i.test(c.context);
    if (c.kind === 'fill' && !otherMarket && (marketLabel || nativePriceLabel || (priceLabel && marketRow))) prices.push(usd(c.value));
    if (c.kind === 'click' && c.checked === true) {
      if (/^(?:all territories(?: \(worldwide rights\))?|worldwide rights)$/i.test(label)) rights.push('worldwide');
      if (/^individual territories(?: \(selected territories\))?$/i.test(label)) rights.push('individual_territories');
    }
  }
  return {amazon_com_list_price_usd:consensus(prices), rights:consensus(rights)};
}

const approvedNotice = /^(?:print preview(?:er)?(?: status:| is| has been)? approved|you (?:have )?approved (?:your|the) print preview)\.?$/i;
function alertCategory(alert) {
  if (typeof alert !== 'string') return 'review_alert';
  if (/preview/i.test(alert)) return 'preview';
  if (/cover/i.test(alert)) return 'cover';
  if (/manuscript|upload/i.test(alert)) return 'upload';
  if (/price|pricing|royalt/i.test(alert)) return 'pricing';
  if (/rights|territor/i.test(alert)) return 'rights';
  return 'review_alert';
}

function summarizePage(result, group, edition) {
  const controls = Array.isArray(result.controls) ? result.controls.filter(c=>typeof c?.label === 'string') : [];
  if (group === 'details') {
    const titles = controls.filter(c=>c.kind === 'fill' && /^(?:book )?title$/i.test(c.label)).map(c=>bookTitle(c.value));
    return {title:consensus(titles)};
  }

  const alerts = Array.isArray(result.alerts) ? result.alerts : null;
  const state = result.content_state ?? {};
  const print = ['paperback','hardcover'].includes(edition);
  const approval = a => group === 'content' && print && typeof a === 'string' && approvedNotice.test(a.trim());
  const categories = unique((alerts ?? []).filter(a=>!approval(a)).map(alertCategory));
  const blockers = [];
  if (state.saving === true) blockers.push('saving');
  if (state.unsaved_changes === true) blockers.push('unsaved_changes');
  if (state.preview_approval_required === true) blockers.push('preview_approval_required');
  if (group === 'pricing' && alerts?.some(a=>typeof a === 'string' && /^(?:please enter (?:a|your) list price|list price is required)\.?$/i.test(a.trim()))) {
    blockers.push('list_price_required');
  }
  if (group === 'content') {
    if (state.upload_error === true) blockers.push('upload_error');
    if (state.cover_status === 'missing') blockers.push('cover_missing');
  }
  const status = blockers.length ? 'blocked' : categories.length ? 'review_alerts' : alerts ? 'no_alerts_observed' : 'unknown';
  const summary = {status, alert_categories:categories, blockers};
  if (group === 'pricing') return {summary,...pricingFields(controls)};

  // A labeled readout or field can provide an ISBN. Ignore numbers elsewhere on the page.
  const numbers = controls.filter(c=>c.kind === 'fill' && /^ISBN(?:-1[03])?$/i.test(c.label)).map(c=>isbn(c.value));
  if (typeof result.text === 'string') {
    for (const match of result.text.matchAll(/^ISBN(?:-1[03])?[ \t]*:[ \t]*(?:\r?\n)?([\dX -]{10,22})[ \t]*\r?$/gim)) numbers.push(isbn(match[1]));
  }
  const clean = state.saving === false && state.unsaved_changes === false && state.upload_error === false &&
    state.preview_approval_required === false && state.cover_status !== 'missing' && !categories.length;
  return {summary:{...summary,
    cover_status:['present','missing'].includes(state.cover_status) ? state.cover_status : 'unknown',
    preview_enabled:typeof state.preview_enabled === 'boolean' ? state.preview_enabled : null},
    isbn:consensus(numbers.filter(Boolean)),
    print_preview_approval:clean && alerts?.some(approval) ? 'confirmed' : 'unknown'};
}

function listedEditions(inventory) {
  if (!Array.isArray(inventory)) return null;
  const tabs = [];
  const seen = new Set();
  for (const row of inventory) {
    const page = route(row?.path);
    if (!row?.edition_id && !page?.edition_id && ['bookshelf','create','series','cover_creator','previewer'].includes(row?.stage)) continue;
    if (page?.edition_id === 'new' && row.edition_id === 'new') continue;
    if (!page?.edition_id || !savedEditionId.test(page.edition_id) || row.path !== page.path ||
        row.edition_id !== page.edition_id || row.edition !== page.edition || row.stage !== page.stage ||
        !Number.isSafeInteger(row.tab_id) || row.tab_id < 0 || seen.has(row.tab_id)) return null;
    seen.add(row.tab_id);
    tabs.push({...page,tab_id:row.tab_id,active:row.active === true});
  }
  return tabs;
}

async function inspect(browser, tab) {
  // expected_path is checked by the existing extension before scanner injection.
  const reply = await browser.call('inspect',{tab_id:tab.tab_id, expected_path:tab.path});
  const page = reply?.result?.page;
  if (reply?.tab_id !== tab.tab_id || !reply.document_id || reply.expected_path !== tab.path ||
      page?.path !== tab.path || page.edition_id !== tab.edition_id ||
      page.edition !== tab.edition || page.stage !== tab.stage) return null;
  return summarizePage(reply.result,stageGroup(tab.stage),tab.edition);
}

export async function workflowOverview(browser, editionId) {
  const unavailable = (status,next_action) => ({status,edition_id:editionId ?? null,next_action});
  let inventory;
  try {
    if (!browser.status().paired) return unavailable('offline','Check the paired Brave connection.');
    inventory = listedEditions(await browser.call('tabs',{}));
  } catch { /* Provider messages may contain URLs or page contents. */ }
  if (!inventory) return unavailable('inventory_unavailable','Refresh the supported tab inventory in Brave.');
  const ids = unique(inventory.map(t=>t.edition_id)).sort();
  if (editionId === undefined && ids.length > 1) {
    return {...unavailable('ambiguous','Specify the exact saved edition ID.'),available_ids:ids};
  }
  const id = editionId ?? ids[0];
  const tabs = inventory.filter(t=>t.edition_id === id);
  if (!tabs.length) return unavailable('not_found','Check that the saved edition is open in Brave.');
  const editions = unique(tabs.map(t=>t.edition));
  if (editions.length > 1) return {status:'ambiguous',edition_id:id,available_editions:editions,
    next_action:'Keep only the intended format open for this shared edition ID.'};

  const found = tabs.map(t=>({tab_id:t.tab_id,stage:t.stage,active:t.active,inspection:'skipped_duplicate'}));
  const pages = {};
  // One snapshot per logical stage, at most three. Background duplicates have no recency signal.
  for (const group of stages) {
    const indices = tabs.flatMap((t,i)=>stageGroup(t.stage) === group ? [i] : []);
    if (!indices.length) continue;
    const index = indices.length === 1 ? indices[0] : consensus(indices.filter(i=>tabs[i].active));
    if (index === null) continue;
    try { pages[group] = await inspect(browser,tabs[index]); } catch { /* A tab may have moved or closed. */ }
    found[index].inspection = pages[group] ? 'inspected' : 'unavailable';
  }
  const unknown = {status:'unknown',alert_categories:[],blockers:[]};
  const content = pages.content?.summary ?? unknown;
  const pricing = pages.pricing?.summary ?? unknown;
  const blockers = unique([...content.blockers,...pricing.blockers]);
  const active = found.filter(t=>t.active);
  const current = active.length === 1 && active[0].inspection === 'inspected' ? active[0].stage : 'unknown';
  const complete = stages.every(s=>pages[s]) && [content,pricing].every(p=>p.status !== 'unknown');
  const review = content.alert_categories.length || pricing.alert_categories.length;
  const disputedPreview = blockers.includes('preview_approval_required') || pricing.alert_categories.includes('preview');
  const approval = disputedPreview ? 'unknown' : pages.content?.print_preview_approval;
  // Keep attempted reads first so a pile of old duplicate tabs cannot hide the evidence.
  const listed = [...found.filter(t=>t.inspection !== 'skipped_duplicate'),...found.filter(t=>t.inspection === 'skipped_duplicate')].slice(0,12);
  return {status:complete ? 'observed' : 'partial',edition_id:id,edition:editions[0],tabs:listed,
    found_stages:unique(found.map(t=>t.stage)),omitted_tab_count:found.length-listed.length,
    current_stage:current,title:pages.details?.title ?? null,content,pricing,blockers,
    isbn:pages.content?.isbn ?? null,amazon_com_list_price_usd:pages.pricing?.amazon_com_list_price_usd ?? null,
    rights:pages.pricing?.rights ?? null,print_preview_approval:approval ?? 'unknown',
    next_action:blockers.length ? 'Resolve the observed blockers in KDP.' : review ? 'Review the flagged KDP alerts.' :
      !complete ? 'Check missing or unavailable edition tabs in Brave.' : 'Verify the release requirements with kdp_preflight_edition.'};
}

export function preflight(overview) {
  const blockers = overview.blockers ?? [];
  const blocked = blockers.length > 0;
  const checks = {
    latest_manuscript_amazon_upload:'unknown',
    latest_cover_amazon_upload:blockers.includes('cover_missing') ? 'missing' : 'unknown',
    amazon_com_list_price:overview.amazon_com_list_price_usd ? 'observed' : 'unknown',
    territorial_rights:overview.rights === 'worldwide' ? 'observed' : 'unknown',
    previewer_approval:overview.print_preview_approval === 'confirmed' ? 'confirmed' :
      blockers.includes('preview_approval_required') ? 'required' : 'unknown',
    kdp_blockers:blocked ? 'blocked' : 'unknown'
  };
  // tabs/inspect cannot bind Amazon's file to the intended latest revision, certify saved
  // pricing, or establish release-wide clearance. There is no "ready" inference here.
  const alerts_to_review = {content:overview.content?.alert_categories ?? [],pricing:overview.pricing?.alert_categories ?? []};
  const needsReview = alerts_to_review.content.length || alerts_to_review.pricing.length;
  return {edition_id:overview.edition_id,edition:overview.edition ?? null,status:blocked ? 'blocked' : 'unknown',
    alerts_to_review,
    overview_status:overview.status, checks, blockers, missing_or_unknown:Object.keys(checks).filter(k=>checks[k] !== 'confirmed'),
    next_action:overview.tabs && !blocked && !needsReview ? 'Verify the outstanding checks against the intended files and saved KDP edition.' : overview.next_action};
}
