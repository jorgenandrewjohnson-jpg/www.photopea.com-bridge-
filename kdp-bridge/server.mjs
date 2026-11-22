import http from 'node:http';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {WebSocket,WebSocketServer} from 'ws';
const PORT=Number(process.env.PORT||3000), SECRET=process.env.BRIDGE_TOKEN||'',VERSION='0.1.0';
if(SECRET.length<32){console.error('Set a unique BRIDGE_TOKEN (32+ characters) in Render');process.exit(1)}
const h=s=>createHash('sha256').update(String(s)).digest();
const good=s=>timingSafeEqual(h(s),h(SECRET));
const allowed=url=>{try{let x=new URL(url);return x.protocol==='https:'&&['kdp.amazon.com','cc.amazon.com'].includes(x.hostname)}catch{return false}};
let paired=null,lastSeen=null;const pending=new Map();
const definitions={
kdp_bridge_status:['Check bridge health and actual Chrome pairing',{}],
kdp_list_tabs:['List authorized KDP and Cover Creator tabs',{}],
kdp_open:['Open a KDP or Amazon Cover Creator page',{url:{type:'string'}},['url']],
kdp_inspect_page:['Inspect headings, form fields, validation notices, and page text; redact URL query tokens',{tab_id:{type:'integer'}}],
kdp_click:['Click ordinary controls, including Save and Continue, but not Publish or Delete',{tab_id:{type:'integer'},selector:{type:'string'},text:{type:'string'}}],
kdp_fill:['Fill an ordinary non-sensitive metadata field',{tab_id:{type:'integer'},selector:{type:'string'},label:{type:'string'},value:{type:'string'}},['value']],
kdp_scroll:['Scroll the active KDP page',{tab_id:{type:'integer'},x:{type:'number'},y:{type:'number'}}],
kdp_capture:['Return real screenshot of active KDP or Cover Creator Chrome tab',{tab_id:{type:'integer'}}],
kdp_list_staged_files:['List local files staged by user in Chrome extension',{ } ],
kdp_upload_staged_file:['Inject a user-staged book or cover into a KDP file input; verify Amazon processing separately',{filename:{type:'string'},tab_id:{type:'integer'},selector:{type:'string'}},['filename']],
kdp_publish_approved:['One Publish click only after exact-title user approval in chat and separate one-time confirmation in Chrome extension',{title:{type:'string'},edition:{type:'string',enum:['paperback','hardcover','kindle_ebook']},tab_id:{type:'integer'},button_text:{type:'string'}},['title','edition','button_text']]
};
const tools=Object.entries(definitions).map(([name,[description,properties,required]])=>({name,description,inputSchema:{type:'object',properties,...(required?{required}:{})}}));
function browserCall(op,args={}){if(!paired||paired.readyState!==WebSocket.OPEN)throw Error('KDP Chrome extension is not paired');const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Browser timed out; inspect KDP before retry'))},60000);pending.set(id,{resolve,reject,timer});paired.send(JSON.stringify({type:'command',id,op,args}))})}
async function call(name,args={}){
if(!(name in definitions))throw Error('Unknown tool');
if(name==='kdp_bridge_status')return {content:[{type:'text',text:JSON.stringify({ready:true,version:VERSION,paired:!!paired,lastSeen,note:'Pairing is not Amazon login'})}]};
if(name==='kdp_open'&&!allowed(args.url))throw Error('Only HTTPS KDP and Cover Creator URLs are allowed');
if(name==='kdp_click'&&/(publish|submit|unpublish|delete|terminate|place.order)/i.test((args.selector||'')+' '+(args.text||'')))throw Error('High-impact click blocked: use dedicated publish tool');
if(name==='kdp_fill'&&/(password|token|secret|otp|bank|tax|card)/i.test((args.selector||'')+' '+(args.label||'')))throw Error('Sensitive field blocked');
const op={kdp_list_tabs:'tabs',kdp_open:'open',kdp_inspect_page:'inspect',kdp_click:'click',kdp_fill:'fill',kdp_scroll:'scroll',kdp_capture:'capture',kdp_list_staged_files:'staged',kdp_upload_staged_file:'upload',kdp_publish_approved:'publish'}[name];
const value=await browserCall(op,args);
if(name==='kdp_capture'&&value?.dataUrl?.startsWith('data:image/png;base64,'))return {content:[{type:'image',mimeType:'image/png',data:value.dataUrl.split(',')[1]},{type:'text',text:JSON.stringify({captured:true,tab_id:value.tab_id})}]};
return {content:[{type:'text',text:JSON.stringify(value)}]};
}
const send=(res,status,value,extra={})=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...extra});res.end(JSON.stringify(value))};
const read=req=>new Promise((resolve,reject)=>{let x='';req.on('data',c=>{x+=c;if(x.length>1e6)reject(Error('Too large'))});req.on('end',()=>{try{resolve(JSON.parse(x))}catch(e){reject(e)}});req.on('error',reject)});
const landing='<!doctype html><title>Private KDP Browser Bridge</title><h1>KDP Browser Bridge</h1><p>Install and pair the Chrome extension from the GitHub kdp-browser-bridge branch. Log into Amazon directly in Chrome. No Amazon passwords or cookies are collected by this service.</p><p>Use /health for status and /mcp for authenticated MCP tools.</p>';
const server=http.createServer(async(req,res)=>{try{
if(req.url==='/health')return send(res,200,{status:'ok',version:VERSION,browserPaired:!!paired,lastSeen});
if(req.url==='/'||req.url==='/workspace'){res.writeHead(200,{'Content-Type':'text/html','X-Frame-Options':'DENY'});return res.end(landing)}
if(req.url!=='/mcp')return send(res,404,{error:'not_found'});
const auth=req.headers.authorization||'';if(!auth.startsWith('Bearer ')||!good(auth.slice(7))){res.writeHead(401,{'WWW-Authenticate':'Bearer realm="KDP Bridge"'});return res.end()}
if(req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write(': connected\n\n');const i=setInterval(()=>res.write(': keepalive\n\n'),20000);req.on('close',()=>clearInterval(i));return}
if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'});
const m=await read(req);if(m.method==='notifications/initialized'){res.writeHead(202);return res.end()}
let r={jsonrpc:'2.0',id:m.id};if(m.method==='initialize')r.result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'kdp-browser-bridge',version:VERSION}};
else if(m.method==='ping')r.result={};
else if(m.method==='tools/list')r.result={tools};
else if(m.method==='tools/call'){try{r.result=await call(m.params?.name,m.params?.arguments||{})}catch(e){r.result={isError:true,content:[{type:'text',text:e.message}]}}}
else r.error={code:-32601,message:'Method not found'};
send(res,200,r,{'MCP-Protocol-Version':'2025-03-26'});
}catch(e){send(res,400,{error:e.message})}});
const wss=new WebSocketServer({noServer:true,maxPayload:18*1024*1024});
server.on('upgrade',(req,sock,head)=>{if(req.url!=='/browser'||(req.headers.origin&&!/^chrome-extension:\/\/[a-z]{32}$/.test(req.headers.origin))){sock.destroy();return}wss.handleUpgrade(req,sock,head,ws=>wss.emit('connection',ws))});
wss.on('connection',ws=>{let ok=false;ws.on('message',data=>{try{const m=JSON.parse(data.toString());if(!ok){if(m.type!=='pair'||!good(m.token||''))return ws.close(1008,'Unauthorized');if(paired&&paired.readyState===WebSocket.OPEN)paired.close(1000,'New connection');paired=ws;ok=true;lastSeen=new Date().toISOString();return ws.send(JSON.stringify({type:'paired',version:VERSION}))}
lastSeen=new Date().toISOString();if(m.type==='result'&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.ok?p.resolve(m.value):p.reject(Error(m.error||'Browser failure'))}
}catch{ws.send(JSON.stringify({type:'error',message:'Invalid message'}))}});
ws.on('close',()=>{if(paired===ws){paired=null;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Browser disconnected'))}pending.clear()}})});
server.listen(PORT,'0.0.0.0',()=>console.log('KDP browser bridge '+VERSION+' on port '+PORT));
