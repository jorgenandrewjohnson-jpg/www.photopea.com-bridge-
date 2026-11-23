import http from 'node:http';
import {createHmac, randomUUID, randomBytes} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createOAuth,readBody,send,matches} from './oauth.mjs';
import {VERSION,createMcp} from './tools.mjs';
import {createTransferIngress} from './http-transfer.mjs';

const port = Number(process.env.PORT || 3000);
const origin = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:'+port;
const owner = process.env.KDP_OWNER_KEY;
if (!owner || owner.length < 43) throw Error('Set a unique KDP_OWNER_KEY of at least 43 characters');
const local = new URL(origin).hostname === '127.0.0.1';
if (new URL(origin).origin !== origin || (!local && !origin.startsWith('https://'))) throw Error('Invalid public origin');
const sign = (label,value) => createHmac('sha256',owner).update(label+'\0'+value).digest('base64url');
const oauth = createOAuth({origin,ownerSecret:owner,signingKey:sign('oauth',origin)});
let paired;
let lastDisconnect=null;
let lastPairedAt=null;
const requests = new Map();
const candidates = new Map();
const sockets = new WebSocketServer({noServer:true,maxPayload:12*1024*1024,perMessageDeflate:false});
// Serialize independent MCP requests instead of rejecting them when Brave is busy.
const queue = [];
let activeId = null;
function dispatch() {
  if (activeId || !queue.length) return;
  const id = queue.shift();
  const job = requests.get(id);
  if (!job) return dispatch();
  if (job.ws !== paired || paired?.readyState !== WebSocket.OPEN) {
    finish(id, Error('Brave disconnected before the operation began.'));
    return;
  }
  activeId = id;
  job.state = 'running';
  job.timer = setTimeout(() => finish(id, Error('Operation outcome unknown. Reinspect KDP before retrying.')), job.op === 'publish' ? 125000 : ['stage_file','upload'].includes(job.op) ? 900000 : 65000);
  job.ws.send(JSON.stringify({type:'command',id,op:job.op,args:job.args}), err => {
    if (err) finish(id,err);
  });
}
const browser = {
  status:()=>({
    version:VERSION, paired:paired?.readyState===WebSocket.OPEN,
    last_paired_at:lastPairedAt,last_disconnect:lastDisconnect,
    active_operation: activeId ? {operation_id:activeId, type:requests.get(activeId)?.op} : null,
    queued_operations:queue.length
  }),
  call(op,args) {
    const ws=paired;
    if (ws?.readyState !== WebSocket.OPEN) throw Error('Brave is not paired');
    if (requests.size >= 12) throw Error('Browser operation queue is full');
    if (op === 'publish' && requests.size) throw Error('Finish pending operations and reinspect the pricing page before publishing');
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      requests.set(id,{resolve,reject,ws,op,args,state:'queued',timer:null});
      queue.push(id);
      dispatch();
    });
  }
};
const ingress=createTransferIngress({origin,dispatch:(op,args)=>browser.call(op,args)});
browser.prepareTransfer=a=>ingress.prepare(a);
browser.pullTransfer=a=>ingress.pull(a);
function finish(id,err,value) {
  const job=requests.get(id);
  if (!job) return;
  requests.delete(id);
  if (job.timer) clearTimeout(job.timer);
  const index=queue.indexOf(id);
  if(index>=0) queue.splice(index,1);
  if(activeId===id) activeId=null;
  if(err) job.reject(err); else job.resolve(value);
  dispatch();
}
const server = http.createServer(async(req,res)=>{
  try {
    const url = new URL(req.url,origin);
    if (url.pathname==='/health') return send(res,200,{status:'ok',version:VERSION});
    if (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/oauth/')) return await oauth.handle(req,res,url);
    if (url.pathname.startsWith('/file-transfer/')) return await ingress.handle(req,res,url);
    if (req.headers.origin && req.headers.origin!==origin) return send(res,403,{error:'origin_denied'});
    if (url.pathname==='/device/approve' && req.method==='POST') {
      if (!matches(req.headers.authorization,'Bearer '+owner)) return send(res,401,{error:'unauthorized'});
      const {code}=JSON.parse(await readBody(req,1024));
      const ws=candidates.get(code);
      if (!ws || ws.readyState!==WebSocket.OPEN || paired) return send(res,409,{error:'pairing_unavailable'});
      const device=randomBytes(32).toString('base64url')+'.'+(Date.now()+30*86400000);
      candidates.delete(code);
      ws.send(JSON.stringify({type:'credential',device,proof:sign('browser',device)}));
      return send(res,200,{issued:true});
    }
    if (url.pathname!=='/mcp' || url.search) return send(res,404,{error:'not_found'});
    if (!oauth.verify(req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1])) return send(res,401,{error:'unauthorized'},{'WWW-Authenticate':oauth.challenge});
    if (req.method!=='POST') return send(res,405,{error:'method_not_allowed'},{Allow:'POST'});
    if (!req.headers['content-type']?.startsWith('application/json')) return send(res,415,{error:'invalid_content_type'});
    const body=JSON.parse(await readBody(req,65536));
    const mcp=createMcp(browser);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>void mcp.close());
    await mcp.connect(transport);
    await transport.handleRequest(req,res,body);
  } catch(e) { if(!res.headersSent) send(res,e.status || 400,{error:'invalid_request'}); }
});
server.on('upgrade',(req,socket,head)=>{
  if (req.url!=='/browser' || !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin||'') || sockets.clients.size>=16) return socket.destroy();
  sockets.handleUpgrade(req,socket,head,ws=>sockets.emit('connection',ws));
});
sockets.on('connection',ws=>{
  let code;
  let lastPong=Date.now();
  ws.on('pong',()=>{lastPong=Date.now();});
  const keepAlive=setInterval(()=>{
    if(ws.readyState!==WebSocket.OPEN) return;
    if(Date.now()-lastPong>85000) {
      ws.terminate();return;
    }
    try {ws.ping();} catch {ws.terminate();}
  },30000);
  keepAlive.unref?.();
  let deadline=setTimeout(()=>ws.close(1008,'Pairing expired'),10000);
  ws.on('error',err=>{
    console.warn('KDP websocket transport error',err?.code||'unknown');
    ws.terminate();
  });
  ws.on('message',raw=>{
    try {
      if (ws!==paired && raw.length>1024) return ws.close(1008);
      const m=JSON.parse(raw);
      if (ws!==paired) {
        if (m.type==='enroll' && !code && !paired) {
          code=randomBytes(10).toString('hex');
          candidates.set(code,ws);
          clearTimeout(deadline); deadline=setTimeout(()=>ws.close(1008,'Pairing expired'),180000);
          return ws.send(JSON.stringify({type:'challenge',code}));
        }
        if (m.type!=='pair' || (!/^[\w-]{43}\.\d{13}$/.test(m.device||'') || Number(m.device.split('.')[1])<=Date.now()) || !matches(m.proof,sign('browser',m.device)) || paired) return ws.close(1008,'Pairing rejected');
        clearTimeout(deadline); paired=ws;lastPairedAt=new Date().toISOString();
        return ws.send(JSON.stringify({type:'paired'}));
      }
      if (m.type==='heartbeat') return ws.send(JSON.stringify({type:'alive'}));
      if (m.type==='result' && requests.get(m.id)?.ws===ws) finish(m.id,m.ok?null:Error(String(m.error||'Brave operation failed').slice(0,300)),m.value);
    } catch { ws.close(1008,'Invalid message'); }
  });
  ws.on('close',(closeCode,reason)=>{
    clearTimeout(deadline);clearInterval(keepAlive);candidates.delete(code);
    if(ws===paired) {
      lastDisconnect={time:new Date().toISOString(),code:closeCode,reason:String(reason||'').slice(0,80)};
      console.warn('KDP paired browser disconnected',lastDisconnect);
      paired=null;
    }
    for(const [id,job] of requests) if(job.ws===ws) finish(id,Error('Brave disconnected. Inspect the edition before retrying.'));
  });
});
server.listen(port,local?'127.0.0.1':'0.0.0.0',()=>console.log('KDP bridge ready'));
