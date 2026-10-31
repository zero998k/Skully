// Phone access has its own loopback listener, password sessions and tunnel. It never
// exposes the desktop listener or the friend's Finder tunnel as an owner dashboard.
// Once switched on it stays on: only a scrypt hash of the phone password is saved, and the
// link reopens by itself after a restart or a dropped tunnel (quick tunnels get a new address).
// With Tailscale on this computer it also listens on the private Tailscale address: a link that
// never changes, reachable only from the owner's own devices, behind the same password.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {createAuth,hashPassword} from './auth.js';
import {createShare} from './share.js';
const GET=new Set(['/api/state','/api/account/portfolio','/api/account/qr','/api/hypothetical']);
const POST=new Set(['/api/sell','/api/sell-all','/api/pause','/api/settings','/api/wallets/toggle','/api/wallets/add','/api/wallets/remove','/api/paper/balance','/api/reset-pnl']);
export function createPhone({port,page,secret,stateFile=null,onLink=()=>{}}){
 let server,wss,tunnel,auth,base=null,epoch=0,starting=null,retry=null,lastError=null;const sockets=new Set();
 const saved=()=>{try{const x=JSON.parse(fs.readFileSync(stateFile,'utf8'));return typeof x.hash==='string'&&x.hash.startsWith('scrypt$')?x:null;}catch{return null;}};
 const save=hash=>{if(!stateFile)return;fs.mkdirSync(path.dirname(stateFile),{recursive:true});const tmp=stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify({hash}),{mode:0o600});fs.renameSync(tmp,stateFile);};
 let tsServer=null,tsBase=null,tsError=null;
 const tailscaleIp=()=>{if(process.env.PHONE_TAILSCALE_TEST_IP)return process.env.PHONE_TAILSCALE_TEST_IP;
  for(const list of Object.values(os.networkInterfaces()))for(const a of list??[]){if(a.family!=='IPv4'&&a.family!==4)continue;const [x,y]=a.address.split('.').map(Number);if(x===100&&y>=64&&y<=127)return a.address;}return null;};
 const link=req=>tsServer&&req.socket?.localPort===tsServer.address()?.port?{ts:true,base:tsBase,prefix:'/phone',token:tsBase?'tailscale':null}:{ts:false,base,prefix:base?new URL(base).pathname:null,token:tunnel?.guestToken()};
 async function ensureTs(){
  const ip=tailscaleIp();if(!server||!ip){if(!ip)tsError=null;return;}if(tsServer)return;
  const s=http.createServer((req,res)=>server.emit('request',req,res));s.on('upgrade',(req,socket,head)=>server.emit('upgrade',req,socket,head));
  s.requestTimeout=15000;s.headersTimeout=10000;s.maxConnections=100;s.on('connection',c=>{sockets.add(c);c.on('close',()=>sockets.delete(c));});
  try{await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(Number(process.env.PHONE_TAILSCALE_PORT)||port+1,ip,resolve);});tsServer=s;tsBase=`http://${ip}:${s.address().port}/phone`;tsError=null;}
  catch(e){tsError=e.code==='EADDRINUSE'?'Permanent link port is busy':'Tailscale link unavailable';try{s.close();}catch{}}
 }
 const status=()=>({state:starting?'starting':base&&tunnel?.guestToken()?'on':saved()?'reconnecting':'off',url:base,error:tunnel?.status().error??lastError,remembered:!!saved(),tailscale:{found:!!tailscaleIp(),url:tsBase,error:tsError}});
 const send=(r,n,body,type='application/json')=>{r.writeHead(n,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});r.end(type==='application/json'?JSON.stringify(body):body);};
 async function body(req){let s='';for await(const b of req){s+=b;if(s.length>2048)throw Error('Request too large');}return JSON.parse(s||'{}');}
 const sessionId=req=>/(?:^|;\s*)solboy=([a-f0-9]{64})/.exec(req.headers.cookie??'')?.[1];
 const stop=()=>{epoch++;clearTimeout(retry);retry=null;base=null;auth=null;tunnel?.stop();for(const ws of wss?.clients??[])ws.terminate();wss?.close();wss=null;for(const s of sockets)s.destroy();sockets.clear();server?.close();server=null;tsServer?.close();tsServer=null;tsBase=null;return status();};
 async function start(password){
  if(starting)throw Error('Phone link is still starting.');
  if(typeof password!=='string'||password.length<12||password.length>128)throw Error('Choose a phone password with 12 to 128 characters.');
  const hash=hashPassword(password);await open(hash);save(hash);return status();
 }
 // The owner switched it off: forget the saved password so a restart cannot reopen it.
 function turnOff(){const result=stop();if(stateFile)try{fs.rmSync(stateFile,{force:true});}catch{}return {...result,state:'off',remembered:false};}
 // Reopen a remembered link, retrying with a growing pause while the internet or tunnel is down.
 function keepOpen(delay=0){clearTimeout(retry);retry=null;const x=saved();if(!x)return;retry=setTimeout(async()=>{retry=null;if(starting||(base&&tunnel?.guestToken()))return;try{await open(x.hash);lastError=null;}catch(e){lastError=e.message;keepOpen(Math.min(Math.max(delay*2,15000),300000));}},delay);retry.unref?.();}
 async function open(hash){
  stop();const run=epoch;auth=createAuth(()=>hash);let prefix=null;
  server=http.createServer(async(req,res)=>{try{
   const L=link(req),base=L.base,prefix=L.prefix,token=L.token,u=new URL(req.url,'http://localhost');
   if(!base||!token||!prefix||!(u.pathname===prefix||u.pathname.startsWith(prefix+'/')))return send(res,404,{error:'Phone link is off.'});
   const path=u.pathname.slice(prefix.length)||'/',origin=new URL(base).origin;
   if(req.method==='POST'&&req.headers.origin&&req.headers.origin!==origin)return send(res,403,{error:'Wrong origin.'});
   if(path==='/login'){
    if(req.method==='POST'){
     const cookie=await auth.login(req,(await body(req)).password);
     res.setHeader('Set-Cookie',cookie.replace('Path=/;',`Path=${prefix};`)+(process.env.SHARE_TUNNEL_TEST||L.ts?'':'; Secure'));
     return send(res,200,{ok:true});
    }
    return send(res,200,`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>SolBoy phone login</title><style>body{background:#050505;color:white;font:18px system-ui;padding:24px}form{max-width:380px;margin:15vh auto}input,button{box-sizing:border-box;width:100%;padding:16px;margin:12px 0;border-radius:14px;font:inherit}button{background:#ff2d95;color:white;font-weight:bold}#err{color:#ff5470}</style><form><h1>SolBoy · phone</h1><p>Your Mac must stay awake and online.</p><input type="password" autocomplete="current-password" aria-label="Phone password" required><button>Log in</button><p id="err"></p></form><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();try{const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.querySelector('input').value})});if(r.ok)location.href=${JSON.stringify(prefix)};else document.querySelector('#err').textContent=(await r.json()).error;}catch{document.querySelector('#err').textContent='Mac unavailable. Check its connection.';}};</script>`,'text/html; charset=utf-8');
   }
   if(!auth?.isLoggedIn(req)){if(path==='/'&&req.method==='GET'){res.writeHead(302,{Location:prefix+'/login','Cache-Control':'no-store'});return res.end();}return send(res,401,{error:'Log in on your phone first.'});}
   if(path==='/logout'&&req.method==='POST'){for(const ws of wss.clients)if(ws.sessionId===sessionId(req))ws.terminate();res.setHeader('Set-Cookie',auth.logout(req).replace('Path=/;',`Path=${prefix};`));return send(res,200,{ok:true});}
   if(path==='/manifest.webmanifest'&&req.method==='GET')return send(res,200,JSON.stringify({name:'SolBoy',short_name:'SolBoy',start_url:prefix+'/',scope:prefix+'/',display:'standalone',background_color:'#050505',theme_color:'#ff2d95'}),'application/manifest+json');
   if(path==='/'&&req.method==='GET'){
    const events=`<script>class PhoneEvents{constructor(){this.handlers={};this.open();}addEventListener(k,f){this.handlers[k]=f;}open(){this.ws=new WebSocket(location.origin.replace(/^http/,'ws')+${JSON.stringify(prefix+'/stream')});this.ws.onopen=()=>this.onopen?.({});this.ws.onmessage=e=>{try{const x=JSON.parse(e.data);(x.event==='message'?this.onmessage:this.handlers[x.event])?.({data:x.data});}catch{}};this.ws.onclose=e=>{this.onerror?.({});if(e.code===4001)location.href=${JSON.stringify(prefix+'/login')};else this.timer=setTimeout(()=>this.open(),1000);};this.ws.onerror=()=>this.onerror?.({});}}</script>`;
    const html=page.replace('new EventSource(', 'new PhoneEvents(').replaceAll('/api/',prefix+'/api/').replace("location.href = '/login'",`location.href = '${prefix}/login'`).replace('<head>',`<head>${events}<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="SolBoy"><link rel="manifest" href="${prefix}/manifest.webmanifest"><style>#shareBtn,#phoneBtn,#checkUpdBtn,#updateBtn,#askFab{display:none!important}</style>`).replace('<body>',`<body><div style="padding:12px;background:#ff2d95;color:white;font:700 14px system-ui">Phone connected · Mac must stay awake. Wallet keys, withdrawals and mode changes stay on your Mac. <button onclick="fetch('${prefix}/logout',{method:'POST'}).then(()=>location.href='${prefix}/login')">Log out</button></div>`);
    return send(res,200,html,'text/html; charset=utf-8');
   }
   const allowed=req.method==='GET'&&(GET.has(path)||/^\/api\/finder\/(kind|wallet|linked|coin|replay)$/.test(path))||req.method==='POST'&&POST.has(path);
   if(!allowed)return send(res,403,{error:'Use SolBoy on your Mac for this action.'});
   // Only a small explicit set of APIs can cross this bridge. No forwarded host/IP,
   // cookies or arbitrary client headers can turn it into a proxy for desktop secrets.
   const upstream=http.request({hostname:'127.0.0.1',port,path:path+u.search,method:req.method,headers:{host:`localhost:${port}`,'content-type':'application/json'}},r=>{
    res.writeHead(r.statusCode,{'Content-Type':r.headers['content-type']??'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});r.pipe(res);
   });upstream.on('error',()=>{if(!res.headersSent)send(res,502,{error:'Mac connection unavailable.'});else res.end();});res.on('close',()=>upstream.destroy());if(path==='/api/events'){const expiry=setTimeout(()=>upstream.destroy(),600000);expiry.unref();res.on('close',()=>clearTimeout(expiry));}req.pipe(upstream);
  }catch(e){if(!res.headersSent)send(res,401,{error:e.message});else res.end();}});
  // Quick tunnels buffer SSE. Bridge the existing LOCAL event stream over WebSocket
  // so phone ticks travel immediately without adding RPC polling or changing the bot.
  wss=new WebSocket.Server({noServer:true,maxPayload:1024,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{try{
   const L=link(req),base=L.base,prefix=L.prefix;
   if(!base||!L.token||new URL(req.url,'http://localhost').pathname!==prefix+'/stream'||req.headers.origin!==new URL(base).origin||!auth?.isLoggedIn(req)||wss.clients.size>=10){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
   wss.handleUpgrade(req,socket,head,ws=>{ws.sessionId=sessionId(req);
    let buffer='';const upstream=http.get({hostname:'127.0.0.1',port,path:'/api/events?t='+secret,headers:{host:`localhost:${port}`}},r=>{
     if(r.statusCode!==200){r.resume();ws.close(1013);return;}
     r.setEncoding('utf8');r.on('data',chunk=>{buffer+=chunk;if(buffer.length>2000000){ws.close(1013);return;}let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const lines=frame.split('\n'),data=lines.filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(!data){if(ws.readyState===1)ws.ping();continue;}if(ws.bufferedAmount>1000000){ws.close(1013);return;}if(ws.readyState===1)ws.send(JSON.stringify({event:lines.find(x=>x.startsWith('event:'))?.slice(6).trim()??'message',data}));}});r.on('end',()=>ws.close(1013));r.on('error',()=>ws.close(1013));
    });upstream.on('error',()=>ws.close(1013));
    const expiry=setTimeout(()=>ws.close(auth?.isLoggedIn(req)?1012:4001),600000);expiry.unref();
    ws.on('message',()=>ws.close(1008));ws.on('error',()=>{});ws.on('close',()=>{clearTimeout(expiry);upstream.destroy();});
   });
  }catch{socket.destroy();}});
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxConnections=100;
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});await ensureTs();
  tunnel=createShare({port:server.address().port,registerExit:false});starting=tunnel.start();
  try{const result=await starting;if(run!==epoch){tunnel.stop();throw Error('Phone link stopped.');}if(result.state!=='on')throw Error(result.error??'Could not make phone link.');base=result.url;prefix=new URL(base).pathname;starting=null;try{onLink(base);}catch{}return status();}catch(e){stop();throw e;}finally{starting=null;}
 }
 // A quick tunnel can drop while you are away. Check once a minute and reopen it with a new link.
 const watch=setInterval(()=>{if(saved()&&!starting&&!retry&&!(base&&tunnel?.guestToken()))keepOpen();else if(server&&!tsServer)void ensureTs();},60000);watch.unref?.();
 process.on('exit',stop);return {start,stop:turnOff,status,resume:()=>keepOpen(0),checkTailscale:async()=>{await ensureTs();return status();}};
}
