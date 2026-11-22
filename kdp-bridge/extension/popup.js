import {route} from './policy.js';
import {stage,listFiles,removeFile} from './files.js';
const el=id=>document.getElementById(id);
async function send(message) {
  const r=await chrome.runtime.sendMessage(message);
  if(r?.error) throw Error(r.error);
  return r;
}
let pending;
async function refresh() {
  const s=await send({type:'status'});
  if(!el('origin').value && s.origin) el('origin').value=s.origin;
  el('status').textContent=s.paired?'Paired with '+s.origin:s.challenge?'Pairing code: '+s.challenge+'\nAuthorize this code on your KDP bridge within three minutes.':s.lastError || 'Disconnected';
  pending=s.publication;
  el('publication').hidden=!pending;
  if(pending) el('review').textContent=[pending.title,pending.edition+' '+pending.edition_id,'Price: '+pending.price,'Rights: '+pending.rights,'Warnings: '+(pending.warnings.join('\n')||'None reported'),pending.button,'Expires '+new Date(pending.expires).toLocaleTimeString()].join('\n');
}
function action(id,fn) {el(id).onclick=async()=>{try{await fn();await refresh();}catch(e){el('status').textContent=e.message;}};}
action('pair',()=>send({type:'pair',origin:el('origin').value.trim()}));
action('disconnect',()=>send({type:'disconnect'}));
action('confirm',()=>send({type:'confirm',approve:true,request_id:pending?.request_id}));
action('deny',()=>send({type:'confirm',approve:false,request_id:pending?.request_id}));
async function showFiles() {
  el('staged').replaceChildren();
  for(const f of await listFiles()) {
    const line=document.createElement('p'),remove=document.createElement('button');
    line.textContent=f.name+' · '+f.kind+' · '+f.edition+' '+f.edition_id+' ';
    remove.textContent='Remove';remove.onclick=async()=>{await removeFile(f.id);await showFiles();};
    line.append(remove);el('staged').append(line);
  }
}
el('file').onchange=async()=>{
  try {
    const [t]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
    const file=el('file').files[0];
    if(file) {await stage(file,route(t?.url),el('kind').value);el('fileStatus').textContent='Staged locally';await showFiles();}
  }catch(e){el('fileStatus').textContent=e.message;}
};
await refresh();await showFiles();
setInterval(()=>refresh().catch(e=>{el('status').textContent=e.message;}),1000);
