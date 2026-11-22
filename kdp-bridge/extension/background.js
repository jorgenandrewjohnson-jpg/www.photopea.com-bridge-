let ws=null,paired=false,origin='',staged=new Map(),staging=new Map(),armed=null,ping=null;
const amazon=url=>{try{return new URL(url).protocol==='https:'&&['kdp.amazon.com','cc.amazon.com'].includes(new URL(url).hostname)}catch{return false}};
const clean=url=>{try{const u=new URL(url);return u.origin+u.pathname}catch{return ''}};
const tabs=async()=>{const t=await chrome.tabs.query({});return t.filter(x=>amazon(x.url)).map(x=>({id:x.id,title:x.title,url:clean(x.url),active:x.active,windowId:x.windowId}))};
const target=async(id)=>{const t=(await chrome.tabs.query({})).filter(x=>amazon(x.url));const x=id?t.find(a=>a.id===id):t.find(a=>a.active)||t.at(-1);if(!x)throw Error('Open KDP or Amazon Cover Creator in Chrome and sign in');return x};
async function script(id,op,a){
 const out=await chrome.scripting.executeScript({target:{tabId:id},func:(op,a)=>{
 const find=()=>{if(a.selector)return document.querySelector(a.selector);const q=String(a.text||a.label||'').trim().toLowerCase();const all=Array.from(document.querySelectorAll('button,a,label,[role=button],input,textarea,select'));let x=all.find(el=>(el.innerText||el.value||el.getAttribute('aria-label')||el.getAttribute('placeholder')||'').trim().toLowerCase()===q);if(!x)x=all.find(el=>(el.innerText||'').trim().toLowerCase().includes(q));if(x?.tagName==='LABEL')return x.control||document.getElementById(x.htmlFor)||x;return x};
 const visible=x=>!!(x.offsetWidth||x.offsetHeight||x.getClientRects().length);
 const clean=x=>{try{const u=new URL(x);return u.origin+u.pathname}catch{return ''}};
 if(op==='inspect')return {url:clean(location.href),title:document.title,headings:Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).slice(0,30).map(x=>x.innerText?.trim()),controls:Array.from(document.querySelectorAll('input,textarea,select,button,a,[role=button]')).filter(visible).slice(0,170).map(x=>({tag:x.tagName,id:x.id||null,name:x.name||null,type:x.type||null,label:(x.labels?Array.from(x.labels).map(y=>y.textContent).join(' '):x.getAttribute('aria-label')||x.getAttribute('placeholder')||x.innerText||'').trim().slice(0,120),disabled:x.disabled||false})),alerts:Array.from(document.querySelectorAll('[role=alert],[class*=error],[class*=warning]')).filter(visible).slice(0,25).map(x=>x.innerText?.slice(0,500)),text:(document.body?.innerText||'').slice(0,14000),note:'DOM inspection is not visual QA'};
 if(op==='scroll'){window.scrollBy(Number(a.x||0),Number(a.y||700));return {x:scrollX,y:scrollY}};
 const el=find();if(!el)throw Error('Control not found');
 const label=(el.innerText||el.value||el.getAttribute('aria-label')||'').trim();
 if(op==='click'||op==='publish'){
   if(op==='click'&&/(publish|submit\s+(book|your|edition)|delete|unpublish|terminate)/i.test(label))throw Error('High-impact action blocked');
   if(op==='publish'&&!/(publish|submit)/i.test(label))throw Error('Selected control is not a publication control');
   if(el.disabled)throw Error('Control disabled');
   el.click();return {clicked:true,label,note:'Click dispatched; inspect KDP again to confirm saved state'};
 }
 if(op==='fill'){
  if(!['INPUT','TEXTAREA','SELECT'].includes(el.tagName))throw Error('Not a form field');
  if(/password|file|hidden/i.test(el.type||'')||/bank|tax|card|otp|secret/i.test(label))throw Error('Sensitive field');
  if(el.tagName==='SELECT')el.value=a.value;else {const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,String(a.value))}
  el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {filled:true,label,unsaved:true};
 }
 throw Error('Unknown action');
 },args:[op,a]});
 return out[0]?.result;
}
async function run(op,a={}){
 if(op==='tabs')return {tabs:await tabs()};
 if(op==='staged')return {files:Array.from(staged.values()).map(f=>({filename:f.name,bytes:f.size,mimeType:f.mimeType,not_uploaded:true}))};
 if(op==='open'){if(!amazon(a.url))throw Error('Only KDP/CC HTTPS addresses allowed');const t=await chrome.tabs.create({url:a.url});return {opened:true,tab_id:t.id,url:clean(a.url)}}
 const t=await target(a.tab_id);
 if(['inspect','click','fill','scroll'].includes(op))return {tab_id:t.id,...await script(t.id,op,a)};
 if(op==='capture'){if(!t.active)throw Error('Activate the KDP tab first to allow Chrome screenshot capture');return {tab_id:t.id,dataUrl:await chrome.tabs.captureVisibleTab(t.windowId,{format:'png'})}}
 if(op==='upload'){
  const f=staged.get(a.filename);if(!f)throw Error('First stage the exact file using extension popup');
  let r=await chrome.tabs.sendMessage(t.id,{type:'upload_begin',id:f.name,name:f.name,mimeType:f.mimeType,parts:f.parts.length,selector:a.selector||''});
  if(!r?.ok)throw Error(r?.error||'Upload begin failed');
  for(let i=0;i<f.parts.length;i++){r=await chrome.tabs.sendMessage(t.id,{type:'upload_chunk',id:f.name,index:i,data:f.parts[i]});if(!r?.ok)throw Error(r?.error||'Upload chunk failed')}
  r=await chrome.tabs.sendMessage(t.id,{type:'upload_commit',id:f.name});if(!r?.ok)throw Error(r?.error||'Upload failed');
  return {...r,tab_id:t.id,note:'Browser file input populated; KDP processing and acceptance must be checked separately'};
 }
 if(op==='publish'){
  if(!armed||Date.now()>armed.until||armed.title!==a.title||armed.edition!==a.edition)throw Error('User must arm exact title and edition in extension within five minutes, after approving in chat');
  if(!/(publish|submit)/i.test(a.button_text||''))throw Error('Specify exact Publish/Submit button');
  armed=null;return {tab_id:t.id,...await script(t.id,'publish',{text:a.button_text}),note:'One-time click attempted; not proof of KDP publication'};
 }
 throw Error('Unknown command');
}
async function pair(url,token){
 if(!/^https:\/\/[-a-z0-9.]+(?::\d+)?$/i.test(url)||token.length<32)throw Error('Use Render HTTPS address and 32+ character BRIDGE_TOKEN');
 if(ws)ws.close();paired=false;origin=url;ws=new WebSocket(url.replace(/^https:/,'wss:')+'/browser');
 ws.onopen=()=>ws.send(JSON.stringify({type:'pair',token}));
 ws.onclose=()=>{paired=false;if(ping)clearInterval(ping)};
 ws.onerror=()=>{paired=false};
 ws.onmessage=async e=>{let m;try{m=JSON.parse(e.data)}catch{return}
  if(m.type==='paired'){paired=true;if(ping)clearInterval(ping);ping=setInterval(()=>{if(ws?.readyState===1)ws.send(JSON.stringify({type:'heartbeat'}))},20000);return}
  if(m.type==='command'){let value,error,ok=true;try{value=await run(m.op,m.args||{})}catch(e){ok=false;error=e.message}if(ws?.readyState===1)ws.send(JSON.stringify({type:'result',id:m.id,ok,value,error}))}
 };
 return {connecting:true};
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 (async()=>{
 if(m.type==='status')return {paired,origin,files:Array.from(staged.keys()),armed:!!armed&&armed.until>Date.now()};
 if(m.type==='pair')return pair(m.url,m.token);
 if(m.type==='disconnect'){ws?.close();ws=null;paired=false;armed=null;return {disconnected:true}};
 if(m.type==='stage_begin'){if(m.size>80*1024*1024)throw Error('80 MB staging limit');staging.set(m.name,{name:m.name,size:m.size,mimeType:m.mimeType||'application/octet-stream',parts:[]});return {ok:true}};
 if(m.type==='stage_chunk'){const f=staging.get(m.name);if(!f||m.index!==f.parts.length)throw Error('Unexpected chunk');f.parts.push(m.data);return {ok:true}};
 if(m.type==='stage_done'){const f=staging.get(m.name);if(!f)throw Error('No file');staged.set(f.name,f);staging.delete(f.name);return {staged:true,filename:f.name}};
 if(m.type==='arm'){if(!m.confirmed||!m.title||!['paperback','hardcover','kindle_ebook'].includes(m.edition))throw Error('Enter title, edition and check approval');armed={title:m.title,edition:m.edition,until:Date.now()+300000};return {armed:true,expires_in_seconds:300}};
 throw Error('Unknown extension command');
 })().then(reply).catch(e=>reply({error:e.message}));return true;
});
