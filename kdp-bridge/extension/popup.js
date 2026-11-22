const el=id=>document.getElementById(id),send=m=>chrome.runtime.sendMessage(m),status=s=>el('status').textContent=s;
(async()=>{const s=await send({type:'status'});el('url').value=s.origin||'https://kdp-browser-bridge.onrender.com';status('Paired: '+(s.paired?'yes':'no')+'\nStaged: '+s.files.join(', ')+'\nPublish armed: '+(s.armed?'yes':'no'))})().catch(e=>status(e.message));
el('pair').onclick=async()=>{const r=await send({type:'pair',url:el('url').value.trim().replace(/\/$/,''),token:el('token').value});status(r.error||'Pair requested. Reopen this popup to verify.');el('token').value=''};
el('disconnect').onclick=async()=>{await send({type:'disconnect'});status('Disconnected')};
el('files').onchange=async()=>{for(const f of el('files').files){
  let r=await send({type:'stage_begin',name:f.name,size:f.size,mimeType:f.type});if(r.error){el('file-status').textContent=r.error;continue}
  let i=0;for(let at=0;at<f.size;at+=192*1024){const a=new Uint8Array(await f.slice(at,at+192*1024).arrayBuffer());let b='';for(const n of a)b+=String.fromCharCode(n);r=await send({type:'stage_chunk',name:f.name,index:i++,data:btoa(b)});if(r.error)break;el('file-status').textContent='Staging '+f.name+': '+Math.min(f.size,at+192*1024)+' / '+f.size}
  if(!r.error)r=await send({type:'stage_done',name:f.name});el('file-status').textContent=r.error||'Ready: '+f.name+' (not uploaded to KDP)';
}};
el('arm').onclick=async()=>{const r=await send({type:'arm',title:el('title').value.trim(),edition:el('edition').value,confirmed:el('confirm').checked});status(r.error||'Authorized one publication click for 5 minutes.');};
