const queued=new Map();
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 (async()=>{
 if(m.type==='upload_begin'){queued.set(m.id,{name:m.name,mimeType:m.mimeType,parts:Array(m.parts),selector:m.selector});return {ok:true}}
 if(m.type==='upload_chunk'){const f=queued.get(m.id);if(!f)throw Error('No upload initiated');f.parts[m.index]=m.data;return {ok:true}}
 if(m.type==='upload_commit'){
  const f=queued.get(m.id);if(!f||f.parts.some(x=>typeof x!=='string'))throw Error('Missing upload chunks');
  const input=document.querySelector(f.selector||'input[type=file]');
  if(!input||input.type!=='file')throw Error('KDP file input selector missing: '+(f.selector||'input[type=file]'));
  const bytes=f.parts.map(b64=>{const b=atob(b64),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a});
  const file=new File(bytes,f.name,{type:f.mimeType}),dt=new DataTransfer();dt.items.add(file);input.files=dt.files;
  input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));queued.delete(m.id);
  return {ok:true,dispatched:true,filename:f.name,bytes:file.size,warning:'This does not prove KDP accepted the file'};
 }
 return {ok:false,error:'Unknown upload action'};
 })().then(reply).catch(e=>reply({ok:false,error:e.message}));return true;
});
