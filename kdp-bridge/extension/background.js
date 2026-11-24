import {route,openable,bridgeOrigin,isPdfPath,classifyUpload,contentBlockers} from './policy.js';
import {getFile,listFiles,stage,transferState,discardTransfer,beginTransfer,appendTransfer,transferParts} from './files.js';
import {validateRemoteManifest,decodeRemoteChunk,REMOTE_CHUNK_BYTES,STREAM_CHUNK_BYTES,REMOTE_TTL_MS} from './remote-policy.js';
let socket, heartbeat, paired=false, challenge='', pendingPublish, lastPublication, lastError='';
const uploads=new Map();

const popup=chrome.runtime.getURL('popup.html');
const config=async()=> (await chrome.storage.local.get('pairing')).pairing;
const ready=chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
async function connect() {
  await ready;
  const c=await config();
  if (!c || (socket && socket.readyState<=1)) return;
  const ws=new WebSocket(bridgeOrigin(c.origin).replace(/^http/,'ws')+'/browser');
  socket=ws;
  let lastServerMessage=Date.now();
  ws.onopen=()=>ws.send(JSON.stringify(c.device?{type:'pair',device:c.device,proof:c.proof}:{type:'enroll'}));
  ws.onmessage=async({data})=>{
    if (socket!==ws) return;
    try {
      const m=JSON.parse(data);
      lastServerMessage=Date.now();
      if (m.type==='challenge') {challenge=m.code;return;}
      if (m.type==='credential') {
        if (!challenge || !(await config()) || socket!==ws) return;
        await chrome.storage.local.set({pairing:{origin:c.origin,device:m.device,proof:m.proof}});
        if (socket===ws) ws.send(JSON.stringify({type:'pair',device:m.device,proof:m.proof}));
        return;
      }
      if (m.type==='paired') {
        paired=true; challenge=''; lastError='';
        heartbeat=setInterval(()=>{
          if(Date.now()-lastServerMessage>70000) ws.close();
          else if(ws.readyState===1) ws.send('{"type":"heartbeat"}');
        },20000);
        return;
      }
      if (m.type!=='command' || !paired) return;
      let reply;
      try {reply={ok:true,value:await run(m.op,m.args)};}
      catch(e){reply={ok:false,error:e.message};}
      if (socket===ws && ws.readyState===1) ws.send(JSON.stringify({type:'result',id:m.id,...reply}));
    } catch {ws.close();}
  };
  ws.onerror=()=>{lastError='WebSocket transport error; reconnect pending';};
  ws.onclose=event=>{
    if (socket!==ws) return;
    stop();
    lastError='WebSocket closed ('+event.code+'): '+(event.reason || 'no reason');
    // A one-shot alarm survives MV3 worker suspension. The existing periodic
    // alarm remains the fallback if Brave is offline.
    void chrome.alarms.create('kdp-reconnect-fast',{when:Date.now()+6000}).catch(()=>{});
  };
}
function stop() {
  const old=socket; socket=null; paired=false; challenge='';
  clearInterval(heartbeat);
  if (pendingPublish && !pendingPublish.dispatching) finishPublication(pendingPublish,'disconnected');
  old?.close();
}
chrome.alarms.onAlarm.addListener(a=>{if(['kdp-reconnect','kdp-reconnect-fast'].includes(a.name)) void connect().catch(()=>{});});
async function purgeExpiredTransfer() {
  const transfer=await transferState();
  if(transfer && Date.now()>transfer.expires) await discardTransfer(transfer.id);
}
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='kdp-reconnect') void purgeExpiredTransfer().catch(()=>{});});
async function wake() {
  await purgeExpiredTransfer();
  if (!await chrome.alarms.get('kdp-reconnect')) await chrome.alarms.create('kdp-reconnect',{periodInMinutes:1});
  await connect();
}
chrome.runtime.onStartup.addListener(()=>void wake());
chrome.runtime.onInstalled.addListener(()=>void wake());
void wake().catch(()=>{});

async function context(id) {
  const t=await chrome.tabs.get(id);
  const page=route(t.url);
  if (!page || t.pendingUrl) throw Error('Select a supported, fully loaded publishing page in Brave');
  return {t,page};
}
async function inPage(a,op,payload=a) {
  const {t,page}=await context(a.tab_id);
  if (a.expected_path && a.expected_path!==page.path) throw Error('Page changed. Inspect again.');
  const target={tabId:t.id,...(a.document_id?{documentIds:[a.document_id]}:{frameIds:[0]})};
  if (op==='inspect') {
    const [loaded]=await chrome.scripting.executeScript({target,files:['content.js']});
    delete target.frameIds;target.documentIds=[loaded.documentId];
  }
  const [out]=await chrome.scripting.executeScript({target,func:(op,args,page,expectedUrl)=>{
    try {
      if(location.href!==expectedUrl) throw Error('Document changed');
      return {ok:true,result:globalThis.kdpPage(op,args,page)};
    } catch(e) {return {ok:false,error:e.message};}
  },args:[op,payload,page,t.url]});
  if (!out?.result?.ok) throw Error(out?.result?.error || 'Document unavailable');
  return {tab_id:t.id,document_id:out.documentId,expected_path:page.path,result:out.result.result};
}
async function capture(a) {
  const {t,page}=await context(a.tab_id);
  if (!['previewer','cover_creator'].includes(page.stage)) throw Error('Capture is restricted to Previewer and Cover Creator');
  if (!t.active) throw Error('Activate the Previewer tab and click the extension icon to grant capture access');
  let changed=false;
  const activated=info=>{if(info.windowId===t.windowId) changed=true;};
  const updated=(id,change)=>{if(id===t.id && (change.url || change.status==='loading')) changed=true;};
  chrome.tabs.onActivated.addListener(activated);chrome.tabs.onUpdated.addListener(updated);
  try {
    await inPage(a,'check');
    const metadata=await inPage(a,'preview_metadata').then(x=>x.result).catch(()=>({
      inspected_scope:'visible browser viewport only',complete_book_inspected:false,
      visible_page_labels:[],metadata_unavailable:true
    }));
    const data=await chrome.tabs.captureVisibleTab(t.windowId,{format:'png'});
    const [active]=await chrome.tabs.query({windowId:t.windowId,active:true});
    await inPage(a,'check');
    if(changed || active?.id!==t.id) throw Error('Tab changed during capture');
    return {page:{...page,tab_id:t.id,document_id:a.document_id,preview_metadata:metadata},data:data.split(',')[1]};
  } finally {chrome.tabs.onActivated.removeListener(activated);chrome.tabs.onUpdated.removeListener(updated);}
}
// Native messaging requires one-time owner installation. The host only reads
// PDFs directly inside Desktop/Downloads; no arbitrary filesystem access.
async function stageNative(a) {
  const {page} = await context(a.tab_id);
  if (page.stage!=='content' || page.edition!==a.edition ||
      page.edition_id!==a.edition_id || page.edition_id==='new')
    throw Error('Select the exact saved edition Content tab before staging');
  if (!['manuscript','cover'].includes(a.kind) || !isPdfPath(a.path))
    throw Error('Only PDFs for manuscript or cover are accepted');
  let port;
  const waiters = new Map();
  const ask = (action,more={})=>new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const timer=setTimeout(()=>{waiters.delete(id);reject(Error('Mac file helper timed out'));},15000);
    waiters.set(id,{resolve,reject,timer});
    port.postMessage({id,action,path:a.path,...more});
  });
  try {
    port=chrome.runtime.connectNative('com.kdp.brave_bridge');
    port.onMessage.addListener(m=>{
      const w=waiters.get(m.id);
      if (!w) return;
      waiters.delete(m.id);clearTimeout(w.timer);
      if (!m.ok) w.reject(Error(m.error||'Mac file helper rejected the PDF'));
      else w.resolve(m);
    });
    port.onDisconnect.addListener(()=>{
      const e=Error(chrome.runtime.lastError?.message||'Mac file helper disconnected');
      for(const w of waiters.values()){clearTimeout(w.timer);w.reject(e);}
      waiters.clear();
    });
    const info=await ask('stat');
    if (!info.size || info.size>250*1024*1024 || !info.name?.toLowerCase().endsWith('.pdf'))
      throw Error('Invalid local PDF');
    const chunks=[];
    for(let offset=0;offset<info.size;offset+=256*1024) {
      const count=Math.min(256*1024,info.size-offset);
      const part=await ask('read',{offset,count,size:info.size,mtime_ns:info.mtime_ns});
      const raw=atob(part.data);
      const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
      if (bytes.length!==count || part.offset!==offset) throw Error('Incomplete Mac file transfer');
      chunks.push(bytes);
    }
    const file=new File(chunks,info.name,{type:'application/pdf'});
    const file_id=await stage(file,page,a.kind);
    const staged=(await listFiles()).find(x=>x.id===file_id);
    return {...staged,file_id,staged:true};
  } finally {
    port?.disconnect();
  }
}
// Receive a verified PDF from an authenticated MCP client directly into the
// paired Brave extension. No Desktop file, public URL or Render disk is used.
// A failed, expired or interrupted transfer cannot be replayed as a KDP upload.
async function receiveRemote(a) {
  if (a.action==='begin') {
    const {page}=await context(a.tab_id);
    validateRemoteManifest(a,page);
    const inspected=await inPage(a,'inspect');
    if (a.document_id && inspected.document_id!==a.document_id)
      throw Error('Content document changed; re-inspect the edition');
    if (inspected.result.content_state?.saving || inspected.result.content_state?.unsaved_changes)
      throw Error('KDP has unsaved changes or is saving');
    if (a.kind==='cover' && inspected.result.content_state?.cover_status!=='missing')
      throw Error('Cover is already present or cannot be verified; replacement is blocked');
    const partial=await beginTransfer({
      id:crypto.randomUUID(),
      tab_id:a.tab_id,edition:a.edition,edition_id:a.edition_id,
      kind:a.kind,name:a.name,size:a.size,sha256:a.sha256.toLowerCase(),
      expected_path:page.path,received:0,next_index:0,
      expires:Date.now()+REMOTE_TTL_MS
    });
    return {transfer_id:partial.id,next_index:partial.next_index,chunk_bytes:REMOTE_CHUNK_BYTES,stream_chunk_bytes:STREAM_CHUNK_BYTES,received:partial.received,status:'receiving_in_brave'};
  }
  const t=await transferState();
  if (!t || t.id!==a.transfer_id) throw Error('PDF transfer not found, expired or already completed');
  if (a.action==='abort') {
    await discardTransfer(a.transfer_id);
    return {aborted:true};
  }
  if (Date.now()>t.expires) {
    await discardTransfer(a.transfer_id);
    throw Error('PDF transfer expired');
  }
  const {page}=await context(t.tab_id);
  if(page.stage!=='content' || page.edition!==t.edition ||
     page.edition_id!==t.edition_id || page.path!==t.expected_path) {
    await discardTransfer(a.transfer_id);
    throw Error('KDP Content page changed during PDF receipt');
  }
  if (a.action==='append') {
    if(a.index!==t.next_index) throw Error('Out-of-order or repeated PDF chunk');
    const bytes=decodeRemoteChunk(a.data_base64,STREAM_CHUNK_BYTES);
    if(t.received+bytes.length>t.size) throw Error('PDF exceeds declared size');
    const saved=await appendTransfer(t.id,a.index,bytes);
    return {transfer_id:a.transfer_id,received:saved.received,total:saved.size,next_index:saved.next_index};
  }
  if(a.action==='commit') {
    if(t.received!==t.size) throw Error('Incomplete PDF receipt');
    const parts=await transferParts(t.id);
    const ext=t.name.split('.').pop().toLowerCase();
    const mime={pdf:'application/pdf',epub:'application/epub+zip',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',kpf:'application/octet-stream',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png'}[ext];
    if(!mime) throw Error('Unsupported received file type');
    const file=new File(parts,t.name,{type:mime});
    const h=new Uint8Array(await file.slice(0,8).arrayBuffer());
    const signature = (v)=>v.every((byte,i)=>h[i]===byte);
    if(ext==='pdf'&&!signature([37,80,68,70,45])) throw Error('Invalid PDF header');
    if(['epub','docx'].includes(ext)&&!signature([80,75,3,4])) throw Error('Invalid EPUB/DOCX ZIP header');
    if(['jpg','jpeg'].includes(ext)&&!signature([255,216,255])) throw Error('Invalid JPEG header');
    if(ext==='png'&&!signature([137,80,78,71,13,10,26,10])) throw Error('Invalid PNG header');
    const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
    const hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    if(hash!==t.sha256) {
      await discardTransfer(t.id);
      throw Error('File SHA-256 mismatch');
    }
    const inspected=await inPage({tab_id:t.tab_id},'inspect');
    if(t.kind==='cover' && inspected.result.content_state?.cover_status!=='missing')
      throw Error('Cover appeared during transfer; cannot replace it');
    const prior=await getFile(t.id);
    const file_id=prior?.sha256===hash ? prior.id : await stage(file,page,t.kind,t.id);
    await discardTransfer(t.id);
    return {file_id,filename:t.name,sha256:hash,size:t.size,
      edition:t.edition,edition_id:t.edition_id,kind:t.kind,
      status:'staged_in_brave_not_uploaded'};
  }
  throw Error('Unsupported receive_file action');
}

async function upload(a) {
  const f=await getFile(a.file_id);
  if (!f) throw Error('Selected artifact is missing');
  const {file,...metadata}=f;
  const id=crypto.randomUUID();
  const progress={operation_id:id,edition_id:metadata.edition_id,edition:metadata.edition,kind:metadata.kind,name:metadata.name,total_bytes:file.size,transferred_bytes:0,status:'transferring'};
  uploads.set(id,progress);
  try {
    await inPage(a,'upload_begin',{...a,...metadata,id});
    const chunk=256*1024;
    for(let at=0;at<file.size;at+=chunk) {
      if (!paired) throw Error('Disconnected before transfer finished');
      const bytes=new Uint8Array(await file.slice(at,at+chunk).arrayBuffer());
      let raw=''; for (const byte of bytes) raw+=String.fromCharCode(byte);
      await inPage(a,'upload_chunk',{id,index:at/chunk,data:btoa(raw)});
      progress.transferred_bytes=Math.min(at+bytes.length,file.size);
    }
    const outcome=await inPage(a,'upload_commit',{id});
    progress.status='dispatched_to_amazon_unverified';
    progress.sha256=f.sha256;
    return {...outcome,operation_id:id,sha256:f.sha256};
  } catch(e) {progress.status='failed_or_uncertain';progress.error=e.message;throw e;}
  finally {await inPage(a,'upload_cancel',{id}).catch(()=>{});}
}
// Return the review request immediately; owner confirmation is a separate local
// action. Never infer Amazon acceptance from a click or repeat an uncertain click.
function publicationSnapshot(p) {
  if (!p) return {status:'no_request_observed'};
  const {title,edition,edition_id,price,rights,warnings,tab_id}=p.args;
  return {request_id:p.request_id, title,edition,edition_id,price,rights,warnings,tab_id,
    button:p.button,expires:p.expires,status:p.status,
    ...(p.error?{error:p.error}:{}), ...(p.popup_opened!==undefined?{popup_opened:p.popup_opened}:{})};
}
function finishPublication(p,status,error) {
  if(pendingPublish!==p) return;
  clearTimeout(p.timer);
  p.status=status;p.error=error;
  lastPublication=publicationSnapshot(p);
  pendingPublish=null;
  void chrome.action.setBadgeText({text:''}).catch(()=>{});
}
async function publish(a) {
  if(pendingPublish) throw Error('A publication review is already pending; inspect publication status');
  if(lastPublication?.edition_id===a.edition_id && lastPublication?.edition===a.edition &&
     ['submitted_unverified','outcome_unknown'].includes(lastPublication.status))
    throw Error('Previous publication outcome is uncertain. Verify Amazon Bookshelf before any retry.');
  const review=await inPage(a,'review_publish');
  if(!paired) throw Error('Bridge disconnected before review');
  const expires=Date.now()+5*60*1000, request_id=crypto.randomUUID();
  const p={args:a,button:review.result.button,request_id,expires,status:'awaiting_owner_confirmation',dispatching:false};
  pendingPublish=p;
  p.timer=setTimeout(()=>{if(!p.dispatching) finishPublication(p,'expired');},5*60*1000);
  try {
    await chrome.action.setBadgeText({text:'ASK'});
    const {t}=await context(a.tab_id);
    await chrome.tabs.update(t.id,{active:true});
    await chrome.windows.update(t.windowId,{focused:true});
    if(chrome.action.openPopup) {
      await chrome.action.openPopup({windowId:t.windowId});
      p.popup_opened=true;
    } else p.popup_opened=false;
  } catch {p.popup_opened=false;}
  return publicationSnapshot(p);
}
async function confirmPublication(m) {
  const p=pendingPublish;
  const [active]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
  if(!p || p.request_id!==m.request_id || p.dispatching || Date.now()>p.expires ||
     !paired || active?.id!==p.args.tab_id)
    throw Error('Activate the exact pricing tab with the current publication request');
  if(m.approve!==true) {finishPublication(p,'declined');return {status:'declined'};}
  p.dispatching=true;p.status='dispatching';
  clearTimeout(p.timer);
  try {
    const result=await inPage(p.args,'publish');
    finishPublication(p,'submitted_unverified');
    return {status:'submitted_unverified',result};
  } catch(e) {
    finishPublication(p,'outcome_unknown',e.message);
    throw e;
  }
}
async function run(op,a) {
  if(op==='publication_status') {
    const observed=pendingPublish?publicationSnapshot(pendingPublish):lastPublication;
    return observed?.edition_id===a.edition_id && observed?.edition===a.edition ? observed :
      {edition_id:a.edition_id,edition:a.edition,status:'no_request_observed'};
  }
  // Inspection reinjects the scanner and invalidates its reviewed control IDs.
  // Freeze bridge operations during local review; the page fingerprint still
  // catches manual changes and navigation.
  if(pendingPublish && !['tabs','staged'].includes(op))
    throw Error('Owner publication review pending; confirm or decline in Brave before other operations');
  switch(op) {
    case 'tabs':return (await chrome.tabs.query({url:['https://kdp.amazon.com/*','https://cc.amazon.com/*']})).flatMap(t=>{const p=route(t.url);return p?[{tab_id:t.id,active:t.active,...p}]:[];});
    case 'staged':return listFiles();
    case 'upload_status': {
      const {page}=await context(a.tab_id);
      if(page.edition!==a.edition || page.edition_id!==a.edition_id || page.stage!=='content') throw Error('Edition mismatch');
      const observed=await inPage(a,'processing');
      const operations=[...uploads.values()].filter(o=>o.edition===a.edition&&o.edition_id===a.edition_id).map(o=>({
        ...o,
        amazon_observation:classifyUpload(observed.result.observed_text,o.name),
        amazon_accepted_verified:false
      }));
      return {operations,amazon:{...observed.result,
        blockers:contentBlockers(observed.result.observed_text),
        amazon_processing_verified:false}};

    }
    case 'stage_file':return stageNative(a);
    case 'receive_file':return receiveRemote(a);
    case 'open': {
      if(!openable(a.url)) throw Error('Unsupported publishing destination');
      const t=await chrome.tabs.create({url:a.url});return {tab_id:t.id,requested:a.url};
    }
    case 'capture':return capture(a);
    case 'upload':return upload(a);
    case 'publish':return publish(a);
    case 'inspect':case 'fill':case 'click':case 'scroll':return inPage(a,op);
    default:throw Error('Unknown operation');
  }
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if (s.id!==chrome.runtime.id || s.url!==popup) return;
  (async()=>{
    await ready;
    if (m.type==='status') {
      const c=await config();
      const p=pendingPublish;
      return {origin:c?.origin,paired,challenge,lastError,publication:p?publicationSnapshot(p):null,lastPublication};
    }
    if (m.type==='pair') {
      const origin=bridgeOrigin(m.origin);
      stop();lastError='';
      await chrome.storage.local.set({pairing:{origin}});await connect();return {connecting:true};
    }
    if (m.type==='disconnect') {await chrome.storage.local.remove('pairing');stop();return {disconnected:true};}
    if (m.type==='confirm') {
      return confirmPublication(m);
    }
    throw Error('Unknown extension operation');
  })().then(reply).catch(e=>reply({error:e.message}));
  return true;
});
