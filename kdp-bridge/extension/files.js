let dbPromise;
function database() {
  if (!dbPromise) dbPromise=new Promise((resolve,reject)=>{
    const req=indexedDB.open('kdp-selected-files',1);
    req.onupgradeneeded=()=>req.result.createObjectStore('files',{keyPath:'id'});
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  return dbPromise;
}
async function use(mode,operation) {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('files',mode);
    const req=operation(tx.objectStore('files'));
    tx.oncomplete=()=>resolve(req.result);
    tx.onabort=tx.onerror=()=>reject(tx.error || Error('File storage unavailable'));
  });
}
export async function stage(file,page,kind) {
  if (!page?.edition_id || page.edition_id==='new' || page.stage!=='content' || !['cover','manuscript'].includes(kind)) throw Error('Select the saved edition’s Content page first');
  const ext=file.name.split('.').pop().toLowerCase();
  const extensions=kind==='cover'?['pdf','jpg','jpeg','tif','tiff','png']:['pdf','epub','docx','doc','kpf','rtf','txt'];
  if (!file.size || file.size>250*1024*1024 || !extensions.includes(ext)) throw Error('Unsupported or empty file, or file exceeds 250 MiB');
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  const sha256=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  const record={id:crypto.randomUUID(),name:file.name,size:file.size,mime:file.type,kind,edition:page.edition,edition_id:page.edition_id,sha256,file};
  await use('readwrite',s=>s.add(record));
  return record.id;
}
export async function listFiles() {
  const records=await use('readonly',s=>s.getAll());
  return records.map(({file,...metadata})=>metadata);
}
export const getFile=id=>use('readonly',s=>s.get(id));
export const removeFile=id=>use('readwrite',s=>s.delete(id));
