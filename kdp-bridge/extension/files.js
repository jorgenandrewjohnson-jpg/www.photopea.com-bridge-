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
export async function stage(file,page,kind,id=crypto.randomUUID()) {
  if (!page?.edition_id || page.edition_id==='new' || page.stage!=='content' || !['cover','manuscript'].includes(kind)) throw Error('Select the saved edition’s Content page first');
  const ext=file.name.split('.').pop().toLowerCase();
  const extensions=kind==='cover'?['pdf','jpg','jpeg','tif','tiff','png']:['pdf','epub','docx','doc','kpf','rtf','txt'];
  if (!file.size || file.size>250*1024*1024 || !extensions.includes(ext)) throw Error('Unsupported or empty file, or file exceeds 250 MiB');
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  const sha256=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  const record={id,name:file.name,size:file.size,mime:file.type,kind,edition:page.edition,edition_id:page.edition_id,sha256,file};
  await use('readwrite',s=>s.add(record));
  return record.id;
}
export async function listFiles() {
  const records=await use('readonly',s=>s.getAll());
  return records.map(({file,...metadata})=>metadata);
}
export const getFile=id=>use('readonly',s=>s.get(id));
export const removeFile=id=>use('readwrite',s=>s.delete(id));

// Keep incomplete transfers in a separate database. Upgrading staging must never
// block an owner who has an older popup open on the existing selected-files DB.
let incomingDB;
async function incoming(mode,operation) {
  if (!incomingDB) incomingDB=new Promise((resolve,reject)=>{
    const open=indexedDB.open('kdp-incoming-transfers',1);
    open.onupgradeneeded=()=>open.result.createObjectStore('incoming');
    open.onsuccess=()=>resolve(open.result);
    open.onerror=()=>reject(open.error);
  });
  const db=await incomingDB;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('incoming',mode);
    const store=tx.objectStore('incoming');
    const read=store.get('manifest');
    let result,failure;
    read.onsuccess=()=>{
      try {result=operation(store,read.result);}
      catch(error){failure=error;tx.abort();}
    };
    tx.oncomplete=()=>resolve(result instanceof IDBRequest ? result.result : result);
    tx.onabort=()=>reject(failure || tx.error || Error('Transfer storage unavailable'));
  });
}
const partsRange=id=>IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]);
export const transferState=()=>incoming('readonly',(_store,current)=>current);
export const discardTransfer=id=>incoming('readwrite',(store,current)=>{
  if(current?.id!==id) return;
  store.delete(partsRange(id));
  store.delete('manifest');
});
export const beginTransfer=manifest=>incoming('readwrite',(store,current)=>{
  if(current && Date.now()<=current.expires) {
    const identity=['edition','edition_id','tab_id','expected_path','kind','name','size','sha256'];
    if(identity.every(key=>current[key]===manifest[key])) return current;
    throw Error('Another transfer is unfinished. Finish or abort it before receiving another file.');
  }
  if(current) store.delete(partsRange(current.id));
  store.put(manifest,'manifest');
  return manifest;
});
export const appendTransfer=(id,index,bytes)=>incoming('readwrite',(store,current)=>{
  if(current?.id!==id || Date.now()>current.expires) throw Error('Transfer expired');
  if(index!==current.next_index || current.received+bytes.length>current.size)
    throw Error('Unexpected transfer offset or size. Begin the same file again to inspect progress.');
  store.add(new Blob([bytes]),[id,index]);
  current.received+=bytes.length;
  current.next_index++;
  store.put(current,'manifest');
  return current;
});
export const transferParts=id=>incoming('readonly',(store,current)=>{
  if(current?.id!==id || current.received!==current.size) throw Error('Incomplete transfer');
  return store.getAll(partsRange(id));
});
