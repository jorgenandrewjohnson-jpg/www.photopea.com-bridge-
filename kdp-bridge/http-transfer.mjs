// One-use, owner-authorized PDF ingress for a client that already possesses
// approved export bytes. No remote fetching, public URLs or persistent files.
// The PDF is streamed to the paired Brave extension in bounded chunks.
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';

const CHUNK = 24 * 1024;
const TTL = 20 * 60 * 1000;
const LIMIT = 250 * 1024 * 1024;

function sameSecret(a,b) {
  if (typeof a!=='string' || typeof b!=='string') return false;
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length && timingSafeEqual(x,y);
}
export function createTransferIngress({origin,dispatch}) {
  const sessions=new Map();
  async function prepare(a) {
    if(a.action!=='begin' || !Number.isSafeInteger(a.size) ||
       a.size<=0 || a.size>LIMIT) throw Error('A valid begin transfer is required');
    if(sessions.size>=3) throw Error('Too many unfinished PDF transfers');
    const result=await dispatch('receive_file',a);
    const id=randomUUID(),token=randomBytes(32).toString('base64url');
    sessions.set(id,{token,transfer_id:result.transfer_id,size:a.size,expires:Date.now()+TTL});
    return {...result,
      upload_url:origin+'/file-transfer/'+id,
      header_name:'X-KDP-Transfer-Token',upload_token:token,
      method:'POST',content_type:'application/pdf',expires_in_seconds:Math.floor(TTL/1000)};
  }
  async function handle(req,res,url) {
    const id=url.pathname.slice('/file-transfer/'.length);
    const session=sessions.get(id);
    if(req.method!=='POST' || !session || Date.now()>session.expires ||
       !sameSecret(req.headers['x-kdp-transfer-token'],session.token)) {
      res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({error:'unavailable_or_unauthorized'}));return;
    }
    // Single-use: an uncertain partially received PDF must never be replayed.
    sessions.delete(id);
    let index=0,total=0,carry=Buffer.alloc(0);
    const errorReply=()=>{
      if(!res.headersSent){
        res.writeHead(422,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify({error:'transfer_failed_or_unverified'}));
      }
    };
    try {
      if(!/^application\/pdf(?:\s*;|$)/i.test(req.headers['content-type']||''))
        throw Error('Content-Type must be application/pdf');
      const length=req.headers['content-length'];
      if(length && Number(length)!==session.size)
        throw Error('Incorrect Content-Length');
      for await (const chunk of req) {
        if(total+chunk.length>session.size) throw Error('Oversized PDF stream');
        total+=chunk.length;
        carry=Buffer.concat([carry,chunk]);
        while(carry.length>=CHUNK){
          await dispatch('receive_file',{
            action:'append',transfer_id:session.transfer_id,index:index++,
            data_base64:carry.subarray(0,CHUNK).toString('base64')
          });
          carry=carry.subarray(CHUNK);
        }
      }
      if(total!==session.size) throw Error('Incomplete PDF');
      if(carry.length) await dispatch('receive_file',{
        action:'append',transfer_id:session.transfer_id,index:index++,
        data_base64:carry.toString('base64')
      });
      const result=await dispatch('receive_file',{
        action:'commit',transfer_id:session.transfer_id
      });
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({status:'staged_in_brave_not_uploaded',...result}));
    } catch {
      await dispatch('receive_file',{
        action:'abort',transfer_id:session.transfer_id
      }).catch(()=>{});
      errorReply();
    }
  }
  return {prepare,handle};
}
