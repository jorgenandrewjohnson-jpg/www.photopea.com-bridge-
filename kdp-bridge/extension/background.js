import {route,openable,bridgeOrigin} from './policy.js';
import {getFile,listFiles,stage} from './files.js';
let socket, heartbeat, paired=false, challenge='', pendingPublish, lastError='';
const popup=chrome.runtime.getURL('popup.html');
const config=async()=> (await chrome.storage.local.get('pairing')).pairing;
const ready=chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
async function connect() {
  await ready;
  const c=await config();
  if (!c || (socket && socket.readyState<=1)) return;
  const ws=new WebSocket(bridgeOrigin(c.origin).replace(/^http/,'ws')+'/browser');
  socket=ws;
  ws.onopen=()=>ws.send(JSON.stringify(c.device?{type:'pair',device:c.device,proof:c.proof}:{type:'enroll'}));
  ws.onmessage=async({data})=>{
    if (socket!==ws) return;
    try {
      const m=JSON.parse(data);
      if (m.type==='challenge') {challenge=m.code;return;}
      if (m.type==='credential') {
        if (!challenge || !(await config()) || socket!==ws) return;
        await chrome.storage.local.set({pairing:{origin:c.origin,device:m.device,proof:m.proof}});
        if (socket===ws) ws.send(JSON.stringify({type:'pair',device:m.device,proof:m.proof}));
        return;
      }
      if (m.type==='paired') {
        paired=true; challenge=''; lastError='';
        heartbeat=setInterval(()=>{if(ws.readyState===1)ws.send('{"type":"heartbeat"}');},20000);
        return;
      }
      if (m.type!=='command' || !paired) return;
      let reply;
      try {reply={ok:true,value:await run(m.op,m.args)};}
      catch(e){reply={ok:false,error:e.message};}
      if (socket===ws && ws.readyState===1) ws.send(JSON.stringify({type:'result',id:m.id,...reply}));
    } catch {ws.close();}
  };
  ws.onclose=event=>{
    if (socket!==ws) return;
    stop();
    lastError=event.reason || 'Disconnected. Reconnect will be attempted.';
  };
}
function stop() {
  const old=socket; socket=null; paired=false; challenge='';
  clearInterval(heartbeat);
  if (pendingPublish) pendingPublish.decide(false);
  old?.close();
}
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='kdp-reconnect') void connect().catch(()=>{});});
async function wake() {
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
    const data=await chrome.tabs.captureVisibleTab(t.windowId,{format:'png'});
    const [active]=await chrome.tabs.query({windowId:t.windowId,active:true});
    await inPage(a,'check');
    if(changed || active?.id!==t.id) throw Error('Tab changed during capture');
    return {page:{...page,tab_id:t.id,document_id:a.document_id},data:data.split(',')[1]};
  } finally {chrome.tabs.onActivated.removeListener(activated);chrome.tabs.onUpdated.removeListener(updated);}
}
// Native messaging requires one-time owner installation. The host only reads
// PDFs directly inside Desktop/Downloads; no arbitrary filesystem access.
async function stageNative(a) {
  const {page} = await context(a.tab_id);
  if (page.stage!=='content' || page.edition!==a.edition ||
      page.edition_id!==a.edition_id || page.edition_id==='new')
    throw Error('Select the exact saved edition Content tab before staging');
  if (!['manuscript','cover'].includes(a.kind) || !/\\.pdf$/i.test(a.path))
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
    if (!info.size || info.size>80*1024*1024 || !info.name?.toLowerCase().endsWith('.pdf'))
      throw Error('Invalid local PDF');
    const chunks=[];
    for(let offset=0;offset<info.size;offset+=128*1024) {
      const count=Math.min(128*1024,info.size-offset);
      const part=await ask('read',{offset,count,size:info.size,mtime_ns:info.mtime_ns});
      const raw=atob(part.data);
      const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
      if (bytes.length!==count || part.offset!==offset) throw Error('Incomplete Mac file transfer');
      chunks.push(bytes);
    }
    const file=new File(chunks,info.name,{type:'application/pdf'});
    const file_id=await stage(file,page,a.kind);
    const staged=(await listFiles()).find(x=>x.id===file_id);
    return {...staged,staged:true};
  } finally {
    port?.disconnect();
  }
}
async function upload(a) {
  const f=await getFile(a.file_id);
  if (!f) throw Error('Selected artifact is missing');
  const {file,...metadata}=f;
  const id=crypto.randomUUID();
  await inPage(a,'upload_begin',{...a,...metadata,id});
  try {
    const chunk=96*1024;
    for(let at=0;at<file.size;at+=chunk) {
      if (!paired) throw Error('Disconnected before transfer finished');
      const bytes=new Uint8Array(await file.slice(at,at+chunk).arrayBuffer());
      let raw=''; for (const byte of bytes) raw+=String.fromCharCode(byte);
      await inPage(a,'upload_chunk',{id,index:at/chunk,data:btoa(raw)});
    }
    return {...(await inPage(a,'upload_commit',{id})),sha256:f.sha256};
  } finally {await inPage(a,'upload_cancel',{id}).catch(()=>{});}
}
async function publish(a) {
  if(pendingPublish) throw Error('Another publication request is pending');
  const review=await inPage(a,'review_publish');
  const expires=Date.now()+90000, request_id=crypto.randomUUID();
  let decide;
  const decision=new Promise(resolve=>{decide=resolve;});
  pendingPublish={args:a,button:review.result.button,request_id,expires,decide};
  const timer=setTimeout(()=>decide(false),90000);
  await chrome.action.setBadgeText({text:'ASK'});
  try {
    if (!await decision || Date.now()>expires || !paired) throw Error('Publication request expired or declined');
    return await inPage(a,'publish');
  } finally {clearTimeout(timer);pendingPublish=null;await chrome.action.setBadgeText({text:''});}
}
async function run(op,a) {
  switch(op) {
    case 'tabs':return (await chrome.tabs.query({url:['https://kdp.amazon.com/*','https://cc.amazon.com/*']})).flatMap(t=>{const p=route(t.url);return p?[{tab_id:t.id,active:t.active,...p}]:[];});
    case 'staged':return listFiles();
    case 'stage_file':return stageNative(a);
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
      return {origin:c?.origin,paired,challenge,lastError,publication:p?{...p.args,button:p.button,request_id:p.request_id,expires:p.expires}:null};
    }
    if (m.type==='pair') {
      const origin=bridgeOrigin(m.origin);
      stop();lastError='';
      await chrome.storage.local.set({pairing:{origin}});await connect();return {connecting:true};
    }
    if (m.type==='disconnect') {await chrome.storage.local.remove('pairing');stop();return {disconnected:true};}
    if (m.type==='confirm') {
      const p=pendingPublish;
      const [active]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
      if (!p || p.request_id!==m.request_id || Date.now()>p.expires || active?.id!==p.args.tab_id) throw Error('Activate the exact pricing tab with the current publication request');
      p.decide(m.approve===true);return {received:true};
    }
    throw Error('Unknown extension operation');
  })().then(reply).catch(e=>reply({error:e.message}));
  return true;
});
