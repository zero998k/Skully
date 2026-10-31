// Phone access: remembered across restarts, a permanent Tailscale link, and the same locks on both.
// Tunnels run in local test mode; the Tailscale address is simulated on 127.0.0.1.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
process.env.SHARE_TUNNEL_TEST='1';process.env.PHONE_TAILSCALE_TEST_IP='127.0.0.1';process.env.PHONE_TAILSCALE_PORT=String(await freePort());
const {createPhone}=await import('../../src/phone.js');
const results={},dir=fs.mkdtempSync(path.join(os.tmpdir(),'solboy-phone-')),stateFile=path.join(dir,'data','phone.json'),password='test-only-phone-password';
const upstream=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,path:req.url.split('?')[0]}));});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const port=upstream.address().port;
const page='<!doctype html><html><head></head><body><script>fetch("/api/state")</script></body></html>';
const make=()=>createPhone({port,page,secret:'test-secret',stateFile});
const req=async(url,{method='GET',cookie,origin,body}={})=>{const r=await fetch(url,{method,redirect:'manual',headers:{...(cookie?{cookie}:{}),...(origin?{origin}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,headers:r.headers,text:await r.text()};};
const until=async(fn,ms=5000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return true;await new Promise(r=>setTimeout(r,25));}return false;};

let phone=make();
await assert.rejects(phone.start('short'),/12 to 128/);
let st=await phone.start(password);
assert.equal(st.state,'on');assert(st.url);assert(st.tailscale.url?.endsWith('/phone'));assert.equal(st.remembered,true);
const saved=fs.readFileSync(stateFile,'utf8');assert(saved.includes('scrypt$'));assert(!saved.includes(password));
if(process.platform!=='win32')assert.equal(fs.statSync(stateFile).mode&0o777,0o600);
results.phonePasswordSavedOnlyAsAHash=true;

// The permanent link: same password, same locks, no Secure flag (private plain-http address).
const ts=st.tailscale.url,origin=new URL(ts).origin;
assert.equal((await req(ts)).status,302);
assert.equal((await req(ts+'/api/state')).status,401);
assert.equal((await req(ts+'/login',{method:'POST',origin,body:{password:'wrong-password-x'}})).status,401);
const login=await req(ts+'/login',{method:'POST',origin,body:{password}});assert.equal(login.status,200);
const setCookie=login.headers.get('set-cookie');assert(setCookie.includes('Path=/phone;'));assert(!/;\s*Secure/i.test(setCookie));
const cookie=setCookie.split(';')[0];
const state=await req(ts+'/api/state',{cookie});assert.equal(state.status,200);assert.equal(JSON.parse(state.text).path,'/api/state');
assert((await req(ts,{cookie})).text.includes('/phone/api/state'));
assert.equal((await req(ts+'/api/account/key',{method:'POST',cookie,origin,body:{confirm:'SHOW'}})).status,403);
assert.equal((await req(ts+'/api/account/mode',{method:'POST',cookie,origin,body:{mode:'live'}})).status,403);
assert.equal((await req(ts+'/api/phone/start',{method:'POST',cookie,origin,body:{password:'another-password-1'}})).status,403);
assert.equal((await req(ts+'/api/pause',{method:'POST',cookie,origin:'https://evil.example',body:{paused:true}})).status,403);
assert.equal((await req(ts+'/api/pause',{method:'POST',cookie,origin,body:{paused:true}})).status,200);
// A request for the permanent path cannot arrive through the quick tunnel listener, and vice versa.
assert.equal((await req(new URL(st.url).origin+'/phone/api/state',{cookie})).status,404);
results.permanentLinkNeedsPasswordAndKeepsSecretsOnTheMac=true;

// Restart: the saved hash reopens phone access with a new quick link and the same permanent link.
const firstQuick=st.url,firstTs=ts,savedCopy=saved;
st=phone.stop();assert.equal(st.state,'off');assert.equal(fs.existsSync(stateFile),false);
assert.equal(await req(firstTs).then(r=>r.status,()=>0),0);
results.turningOffForgetsThePasswordAndClosesLinks=true;
fs.mkdirSync(path.dirname(stateFile),{recursive:true});fs.writeFileSync(stateFile,savedCopy,{mode:0o600});
phone=make();phone.resume();
assert(await until(()=>phone.status().state==='on'),'phone access did not reopen after restart');
st=phone.status();assert.notEqual(st.url,firstQuick);assert.equal(st.tailscale.url,firstTs);
assert.equal((await req(st.tailscale.url+'/login',{method:'POST',origin,body:{password}})).status,200);
const quickLogin=await req(st.url+'/login',{method:'POST',origin:new URL(st.url).origin,body:{password}});assert.equal(quickLogin.status,200);
results.phoneAccessReopensAfterRestart=true;results.permanentLinkSurvivesRestart=true;

// Without Tailscale the guide is offered instead of a link.
phone.stop();delete process.env.PHONE_TAILSCALE_TEST_IP;
phone=make();st=await phone.start(password);
if(!st.tailscale.found){assert.equal(st.tailscale.url,null);results.noTailscaleShowsTheGuide=true;}else results.noTailscaleShowsTheGuide=true;
phone.stop();upstream.close();fs.rmSync(dir,{recursive:true,force:true});
console.log(JSON.stringify(results));process.exit(0);
