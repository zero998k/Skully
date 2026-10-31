// Read-only application audit. Every trade and network response below is synthetic.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const output=process.argv[2];
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(path.join(repo,'solboy/package.json'));
const {Keypair,PublicKey}=require('@solana/web3.js');
const {createBot}=await import(pathToFileURL(path.join(repo,'solboy/src/bot.js')));
const {Positions}=await import(pathToFileURL(path.join(repo,'solboy/src/positions.js')));
const {createRpcLimiter}=await import(pathToFileURL(path.join(repo,'solboy/src/rpc.js')));
const {checkWallet}=await import(pathToFileURL(path.join(repo,'solboy/src/config.js')));
const {createAccount}=await import(pathToFileURL(path.join(repo,'solboy/src/account.js')));
const {tokenNames}=await import(pathToFileURL(path.join(repo,'solboy/src/tokens.js')));
const base=JSON.parse(fs.readFileSync(path.join(repo,'solboy/test/e2e/config.base.json')));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'solboy-readonly-audit-'));
process.chdir(temp);
delete process.env.TELEGRAM_BOT_TOKEN;delete process.env.TELEGRAM_CHAT_ID;
process.env.JUPITER_API_URL='https://audit.invalid/jupiter';
const checks={};
const findings={push(finding){assert.equal(finding.reproduced,false,JSON.stringify(finding));checks[finding.id]=true;}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await sleep(5);}throw Error('Synthetic audit fixture timed out');};
let fixture,sequence=0,instance=0;
function setup(){
 const cfg={...base,wallets:base.wallets.map(x=>({...x})),dryRun:true,onlyFirstBuy:true,sellOnlyOnFullExit:true};
 const positions=new Positions(path.join(temp,'positions-'+(++instance)+'.json'));
 const f={cfg,positions,sourceLeft:0n,transactions:new Map()};
 const balance=n=>({value:n?[{account:{data:{parsed:{info:{tokenAmount:{amount:String(n)}}}}}}]:[]});
 const connection={
  getParsedAccountInfo:async()=>{f.safetyStarted=true;if(f.safetyGate)await f.safetyGate.promise;return{value:{data:{parsed:{info:{mintAuthority:null,freezeAuthority:null}}}}};},
  getParsedTokenAccountsByOwner:async()=>{if(f.sourceError)throw Error('Source RPC temporarily unavailable');return balance(f.sourceLeft);},
  getAccountInfo:async()=>null,
  getParsedTransaction:async sig=>{f.receiptReads=(f.receiptReads??0)+1;return f.transactions.get(sig)??null;},
  onLogs:()=>1,removeOnLogsListener:async()=>{},
 };
 f.connection=connection;f.book={positions,tradeLogFile:path.join(temp,'trades-'+instance+'.csv')};
 f.bot=createBot({cfg,connection,book:f.book});
 f.emit=(mint,side,opts={})=>{
  const b=Buffer.alloc(129);Buffer.from([189,219,127,211,78,230,97,238]).copy(b);new PublicKey(mint).toBuffer().copy(b,8);
  b.writeBigUInt64LE(1_500_000_000n,40);b.writeBigUInt64LE(opts.tokens??30_000_000_000_000n,48);b[56]=side==='buy'?1:0;
  new PublicKey(cfg.wallets[0].address).toBuffer().copy(b,57);b.writeBigUInt64LE(40_000_000_000n,97);b.writeBigUInt64LE(800_000_000_000_000n,105);
  return f.bot.handleSignature(cfg.wallets[0],opts.signature??'audit-'+(++sequence),Date.now(),['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]','Program data: '+b.toString('base64')],opts.slot??null);
 };
 fixture=f;return f;
}
globalThis.fetch=async(url)=>{
 const f=fixture;
 if(String(url).includes('/quote?')){
  if(f.quoteResponses?.length){const next=f.quoteResponses.shift();return next.status?new Response('Temporary quote outage',{status:next.status}):Response.json({outAmount:String(next.amount)});}
  if(f.quoteError)return new Response('Temporary quote outage',{status:503});
  return Response.json({outAmount:'1000'});
 }
 throw Error('Unexpected external request blocked in audit');
};
const mint=()=>Keypair.generate().publicKey.toBase58();
{
 const f=setup(),m=mint();await f.emit(m,'buy');
 f.quoteError=true;f.bot=createBot({cfg:f.cfg,connection:f.connection,book:f.book});
 const result=await f.bot.sellAll();
 findings.push({id:'sell-all-price-outage',reproduced:result.writtenOff===1&&!f.positions.has(m),expected:'A temporary pricing failure keeps the position and reports a failed sell.',observed:{...result,positionStillTracked:f.positions.has(m),recordedPnl:f.positions.todayPnl()}});
}
{
 const f=setup(),m=mint();await f.emit(m,'buy');
 let remaining=30_000_000_000_000n;
 for(let i=0;i<4;i++){const sold=remaining/2n;remaining-=sold;f.sourceLeft=remaining;await f.emit(m,'sell',{tokens:sold});}
 findings.push({id:'cumulative-full-exit',reproduced:f.positions.has(m),expected:'The 90% full-exit option recognises a cumulative 93.75% exit made in four steps.',observed:{sourceSoldPercent:93.75,positionStillTracked:f.positions.has(m),copiedExitQueued:!!f.positions.get(m)?.copiedExit}});
}
{
 const f=setup(),m=mint();await f.emit(m,'buy');
 f.bot=createBot({cfg:f.cfg,connection:f.connection,book:f.book});f.cfg.stopLossPct=20;
 f.quoteResponses=[{amount:25_000_000},{status:503},{amount:50_000_000}];
 await f.bot.checkExits();
 const intentKept=!!f.positions.get(m)?.queuedExit;
 await f.bot.checkExits();
 findings.push({id:'automatic-exit-intent-lost-after-error',reproduced:!intentKept&&f.positions.has(m),expected:'Retain and retry an automatic exit once it triggers, with rate-limit backoff and duplicate-submission protection.',observed:{stopLossPercent:f.cfg.stopLossPct,triggeredLossPercent:50,failedSellIntentSaved:intentKept,positionStillTrackedAfterPriceRecovered:f.positions.has(m)}});
}
{
 const f=setup(),m=mint();f.safetyGate=gate();const buy=f.emit(m,'buy');await until(()=>f.safetyStarted);
 f.positions.recordPnl(-1);f.safetyGate.resolve();await buy;
 findings.push({id:'daily-limit-during-buy-checks',reproduced:f.positions.has(m),expected:'Recheck the daily loss limit immediately before submission.',observed:{dailyLossLimitSol:f.cfg.dailyLossLimitSol,todayPnl:f.positions.todayPnl(),newPositionOpened:f.positions.has(m)}});
}
{
 const f=setup(),m=mint();f.safetyGate=gate();const previous=f.cfg.buyAmountSol,buy=f.emit(m,'buy');await until(()=>f.safetyStarted);
 f.cfg.buyAmountSol=.001;f.safetyGate.resolve();await buy;
 findings.push({id:'buy-size-changed-during-checks',reproduced:(f.positions.get(m)?.solSpent??0)>f.cfg.buyAmountSol,expected:'Cancel or rebuild a pending buy if the owner lowers its allowed size before submission.',observed:{previousSetting:previous,newSetting:f.cfg.buyAmountSol,simulatedAmountSpent:f.positions.get(m)?.solSpent}});
}
{
 let accepted=false;
 try{accepted=checkWallet({address:mint(),buyAmountSol:'Infinity'},[]).buyAmountSol===Infinity;}catch{}
 findings.push({id:'nonfinite-wallet-amount',reproduced:accepted,expected:'Reject non-finite wallet buy amounts.',observed:{infiniteAmountAccepted:accepted}});
}
{
 const f=setup(),m=mint();await f.emit(m,'buy');
 const {EventEmitter}=await import('node:events');f.connection._rpcWebSocket=new EventEmitter();f.historyRequests=[];
 const blockTime=Math.floor(Date.now()/1000),rows=Array.from({length:100},(_,i)=>({signature:'recent-reference-'+i,slot:1000-i,blockTime,err:null}));
 for(const row of rows)f.transactions.set(row.signature,{meta:{err:null,fee:0,preBalances:[1e9],postBalances:[1e9]},transaction:{message:{accountKeys:[f.cfg.wallets[0].address]}}});
 f.transactions.set('older-source-exit',{meta:{err:null,fee:0,preBalances:[1e9],postBalances:[1.5e9],preTokenBalances:[{mint:m,owner:f.cfg.wallets[0].address,uiTokenAmount:{amount:'30000000000000',decimals:6}}],postTokenBalances:[{mint:m,owner:f.cfg.wallets[0].address,uiTokenAmount:{amount:'0',decimals:6}}]},transaction:{message:{accountKeys:[f.cfg.wallets[0].address]}}});
 f.connection.getSignaturesForAddress=async(_address,options)=>{f.historyRequests.push(options);return options.before?[{signature:'older-source-exit',slot:899,blockTime,err:null}]:rows;};
 const interval=globalThis.setInterval;globalThis.setInterval=()=>({unref(){}});
 try{f.bot.start();}finally{globalThis.setInterval=interval;}
 f.connection._rpcWebSocket.emit('close');f.connection._rpcWebSocket.emit('open');await until(()=>f.receiptReads>=100);await sleep(10);
 findings.push({id:'reconnect-history-first-page-only',reproduced:f.historyRequests.length===1&&f.positions.has(m),expected:'Continue through the disconnect window or explicitly report incomplete recovery.',observed:{historyRequests:f.historyRequests,referencesChecked:f.receiptReads,positionStillTracked:f.positions.has(m),olderExitPageRequested:f.historyRequests.some(x=>x.before)}});
}
{
 const oldFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({ok:true});};
 try{
  const rpc=createRpcLimiter(20);
  await Promise.allSettled(Array.from({length:40},()=>rpc.fetch('https://audit.invalid/rpc',{signal:AbortSignal.timeout(20)})));
  const started=Date.now();let recovered=false,error;
  try{await rpc.fetch('https://audit.invalid/rpc',{signal:AbortSignal.timeout(400)});recovered=true;}catch(e){error=e.name;}
  findings.push({id:'rpc-cancelled-queue-reservations',reproduced:!recovered,expected:'Expired queued requests release their slots so a fresh trade can proceed.',observed:{newRequestRecovered:recovered,newRequestElapsedMs:Date.now()-started,error,actualRequestsSent:calls}});
 }finally{globalThis.fetch=oldFetch;}
}
// A latched stop-loss survives restart, respects backoff, and retries exactly once.
{
 const f=setup(),m=mint();await f.emit(m,'buy');
 f.bot=createBot({cfg:f.cfg,connection:f.connection,book:f.book});f.cfg.stopLossPct=20;
 f.quoteResponses=[{amount:25_000_000},{status:503}];await f.bot.checkExits();
 const attempts=f.positions.get(m).queuedExit.attempts;
 await f.bot.checkExits(true);assert.equal(f.positions.get(m).queuedExit.attempts,attempts);
 f.positions=new Positions(f.positions.file);f.book.positions=f.positions;
 f.bot=createBot({cfg:f.cfg,connection:f.connection,book:f.book});
 f.positions.update(m,{queuedExit:{...f.positions.get(m).queuedExit,nextAttemptAt:0}});
 f.quoteResponses=[{amount:50_000_000}];await f.bot.checkExits(true);await until(()=>!f.positions.has(m));
 await f.bot.checkExits(true);
 const log=fs.readFileSync(f.book.tradeLogFile,'utf8');assert.equal(log.split('\n').filter(line=>line.includes('PAPER sell')).length,1);
 checks.automaticExitSurvivesRestartAndRetriesOnce=true;
}
// Ignored partial sells are persisted and cannot be counted twice after restart.
{
 const f=setup(),m=mint();await f.emit(m,'buy');f.sourceLeft=15_000_000_000_000n;
 await f.emit(m,'sell',{tokens:f.sourceLeft,signature:'saved-half-exit'});
 assert.equal(f.positions.get(m).sourceRemainingFraction,.5);
 f.positions=new Positions(f.positions.file);f.book.positions=f.positions;f.bot=createBot({cfg:f.cfg,connection:f.connection,book:f.book});
 await f.emit(m,'sell',{tokens:f.sourceLeft,signature:'saved-half-exit'});
 assert.equal(f.positions.get(m).sourceRemainingFraction,.5);checks.partialExitProgressDeduplicatesAcrossRestart=true;
}
// New source purchases reset the cumulative exit baseline, never forcing an early sell.
{
 const f=setup(),m=mint();await f.emit(m,'buy');
 let remaining=30_000_000_000_000n;
 for(let i=0;i<3;i++){const sold=remaining/2n;remaining-=sold;f.sourceLeft=remaining;await f.emit(m,'sell',{tokens:sold});}
 assert.equal(f.positions.get(m).sourceRemainingFraction,.125);
 f.sourceLeft=30_000_000_000_000n;await f.emit(m,'buy');
 f.sourceLeft=15_000_000_000_000n;await f.emit(m,'sell',{tokens:f.sourceLeft});
 assert(f.positions.has(m));assert.equal(f.positions.get(m).sourceRemainingFraction,.5);checks.sourceTopupResetsCumulativeExitBaseline=true;
}
// Older partial notifications use their receipt when a newer exit overtakes them.
{
 const f=setup(),m=mint();await f.emit(m,'buy');f.cfg.sellOnlyOnFullExit=false;f.sourceLeft=0n;
 const tb=n=>({mint:m,owner:f.cfg.wallets[0].address,uiTokenAmount:{amount:String(n),decimals:6}});
 f.transactions.set('older-half',{meta:{err:null,fee:0,preBalances:[1e9],postBalances:[1.5e9],preTokenBalances:[tb(30_000_000_000_000n)],postTokenBalances:[tb(15_000_000_000_000n)]},transaction:{message:{accountKeys:[f.cfg.wallets[0].address]}}});
 await Promise.all([f.emit(m,'sell',{tokens:15_000_000_000_000n,signature:'older-half',slot:10}),f.emit(m,'sell',{tokens:15_000_000_000_000n,signature:'newer-full',slot:11})]);
 assert(!f.positions.has(m));const log=fs.readFileSync(f.book.tradeLogFile,'utf8');assert.equal(log.split('\n').filter(line=>line.includes('PAPER sell')).length,2);checks.overtakenPartialUsesItsOwnReceipt=true;
}
// Wallet-specific buy sizes get the same final check as the default amount.
{
 const f=setup(),m=mint();await f.emit(m,'buy');f.sourceLeft=7_500_000_000_000n;
 await f.emit(m,'sell',{tokens:f.sourceLeft,signature:'second-half',slot:12});
 const tb=n=>({mint:m,owner:f.cfg.wallets[0].address,uiTokenAmount:{amount:String(n),decimals:6}});
 f.transactions.set('late-first-half',{meta:{err:null,fee:0,preBalances:[1e9],postBalances:[1.5e9],preTokenBalances:[tb(30_000_000_000_000n)],postTokenBalances:[tb(15_000_000_000_000n)]},transaction:{message:{accountKeys:[f.cfg.wallets[0].address]}}});
 await f.emit(m,'sell',{tokens:15_000_000_000_000n,signature:'late-first-half',slot:11});assert.equal(f.positions.get(m).sourceRemainingFraction,.25);
 f.sourceLeft=3_750_000_000_000n;await f.emit(m,'sell',{tokens:f.sourceLeft,slot:13});assert(f.positions.has(m));
 f.sourceLeft=1_875_000_000_000n;await f.emit(m,'sell',{tokens:f.sourceLeft,slot:14});assert(!f.positions.has(m));checks.latePartialStillCountsTowardCumulativeExit=true;
}
{
 const f=setup(),m=mint();f.cfg.wallets[0].buyAmountSol=.1;f.safetyGate=gate();const buy=f.emit(m,'buy');await until(()=>f.safetyStarted);
 f.cfg.wallets[0].buyAmountSol=.001;f.safetyGate.resolve();await buy;assert(!f.positions.has(m));checks.changedWalletOverrideCancelsUnsentBuy=true;
}
{
 const f=setup(),m=mint();f.safetyGate=gate();const buy=f.emit(m,'buy');await until(()=>f.safetyStarted);
 f.cfg.maxOpenPositions=1;f.positions.open(mint(),{tokens:'1',solSpent:.01,openedAt:new Date().toISOString()});
 f.safetyGate.resolve();await buy;assert(!f.positions.has(m));checks.reducedPositionLimitCancelsUnsentBuy=true;
}
// A saved position catches a missed exit on startup without a socket reconnect.
{
 const f=setup(),m=mint();await f.emit(m,'buy');
 const tb=n=>({mint:m,owner:f.cfg.wallets[0].address,uiTokenAmount:{amount:String(n),decimals:6}});
 f.transactions.set('startup-full-exit',{meta:{err:null,fee:0,preBalances:[1e9],postBalances:[1.5e9],preTokenBalances:[tb(1000)],postTokenBalances:[tb(0)]},transaction:{message:{accountKeys:[f.cfg.wallets[0].address]}}});
 f.connection.getSignaturesForAddress=async()=>[{signature:'startup-full-exit',slot:100,blockTime:Math.floor(Date.now()/1000),err:null}];
 const interval=globalThis.setInterval;globalThis.setInterval=()=>({unref(){}});try{f.bot.start();}finally{globalThis.setInterval=interval;}
 await until(()=>!f.positions.has(m));checks.restartRecoversHeldPositionExit=true;
}
// Restart recovery covers only the time SolBoy was closed, not the whole life of an old position.
{
 const f=setup(),m=mint();await f.emit(m,'buy');
 const now=Date.now(),wasRunning=now-10*60_000;
 f.positions.update(m,{openedAt:new Date(now-2*86_400_000).toISOString()});const positionsBefore=fs.readFileSync(f.positions.file,'utf8');f.positions.markRunning(wasRunning);
 const tb=n=>({mint:m,owner:f.cfg.wallets[0].address,uiTokenAmount:{amount:String(n),decimals:6}});
 for(const signature of ['closed-gap-exit','while-running-exit'])f.transactions.set(signature,{meta:{err:null,fee:0,preBalances:[1e9],postBalances:[1.5e9],preTokenBalances:[tb(1000)],postTokenBalances:[tb(0)]},transaction:{message:{accountKeys:[f.cfg.wallets[0].address]}}});
 const fetched=[],read=f.connection.getParsedTransaction;f.connection.getParsedTransaction=sig=>{fetched.push(sig);return read(sig);};
 f.connection.getSignaturesForAddress=async()=>[{signature:'closed-gap-exit',slot:101,blockTime:Math.floor((now-5*60_000)/1000),err:null},{signature:'while-running-exit',slot:100,blockTime:Math.floor((now-30*60_000)/1000),err:null}];
 const interval=globalThis.setInterval;globalThis.setInterval=()=>({unref(){}});try{f.bot.start();}finally{globalThis.setInterval=interval;}
 assert(f.positions.runningAt()>wasRunning);
 assert.equal(fs.readFileSync(f.positions.file,'utf8'),positionsBefore);
 await until(()=>!f.positions.has(m));assert.deepEqual(fetched,['closed-gap-exit']);checks.restartRecoveryOnlyRechecksClosedTime=true;
}
// Existing queued requests honor a newly received provider backoff as well.
{
 const oldFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async url=>{calls.push({url:String(url),at:Date.now()});return calls.length===1?new Response('',{status:429,headers:{'retry-after':'1.2'}}):Response.json({ok:true});};
 try{
  const rpc=createRpcLimiter(20);
  await Promise.all([rpc.fetch('https://audit.invalid/first'),rpc.fetch('https://audit.invalid/queued')]);
  assert(calls.find(x=>x.url.endsWith('/queued')).at-calls[0].at>=1100);checks.queuedRpcRequestsHonorRetryAfter=true;
 }finally{globalThis.fetch=oldFetch;}
}
{
 const oldFetch=globalThis.fetch,calls=[];globalThis.fetch=async url=>{calls.push(String(url));return Response.json({ok:true});};
 try{
  const rpc=createRpcLimiter(20);
  await Promise.all([rpc.fetch('https://audit.invalid/first'),rpc.backgroundFetch('https://audit.invalid/background'),rpc.fetch('https://audit.invalid/trade')]);
  assert.deepEqual(calls.map(x=>x.split('/').at(-1)),['first','trade','background']);checks.rpcTradesKeepPriorityOverScans=true;
 }finally{globalThis.fetch=oldFetch;}
}
for(const n of [Infinity,NaN,0,-1])assert.throws(()=>createRpcLimiter(n));
for(const n of ['Infinity','NaN','0','-1','1e100'])assert.throws(()=>checkWallet({address:mint(),buyAmountSol:n},[]));
checks.invalidNumericInputsAreRejected=true;
// A crash immediately after saving a full exit retains both its ID and its target.
{
 const f=setup(),m=mint();await f.emit(m,'buy');const save=f.positions.save.bind(f.positions);let crash=true;
 f.positions.save=()=>{save();if(crash&&f.positions.get(m)?.sourceExitIds?.length){crash=false;throw Error('Simulated power interruption');}};
 await assert.rejects(f.emit(m,'sell',{signature:'atomic-full-exit'}),/power interruption/);
 f.positions=new Positions(f.positions.file);f.book.positions=f.positions;
 assert.equal(f.positions.get(m).copiedExit.targetRemaining,'0');assert.equal(f.positions.get(m).sourceExitIds.length,1);
 f.bot=createBot({cfg:f.cfg,connection:f.connection,book:f.book});await f.bot.checkExits(true);await until(()=>!f.positions.has(m));checks.exitProgressAndRetryTargetAreSavedAtomically=true;
}
// An older receipt cannot erase a newer queued source instruction.
{
 const f=setup(),m=mint();await f.emit(m,'buy');f.sourceError=true;
 await f.emit(m,'sell',{tokens:7_500_000_000_000n,signature:'queued-newer-half',slot:12});assert(f.positions.get(m).queuedSourceExit);
 f.sourceError=false;f.sourceLeft=7_500_000_000_000n;
 const tb=n=>({mint:m,owner:f.cfg.wallets[0].address,uiTokenAmount:{amount:String(n),decimals:6}});
 f.transactions.set('older-half-receipt',{meta:{err:null,fee:0,preBalances:[1e9],postBalances:[1.5e9],preTokenBalances:[tb(30_000_000_000_000n)],postTokenBalances:[tb(15_000_000_000_000n)]},transaction:{message:{accountKeys:[f.cfg.wallets[0].address]}}});
 await f.emit(m,'sell',{tokens:15_000_000_000_000n,signature:'older-half-receipt',slot:11});assert.equal(f.positions.get(m).queuedSourceExit.signature,'queued-newer-half');
 await f.bot.checkExits(true);await until(()=>f.positions.get(m)?.sourceRemainingFraction===.25);assert.equal(f.positions.get(m).queuedSourceExit,null);checks.olderReceiptCannotEraseNewerQueuedSourceExit=true;
}
// History recovery remains bounded and exposes a gap if the source exceeds that bound.
{
 const f=setup(),m=mint();await f.emit(m,'buy');let pages=0;
 f.connection.getSignaturesForAddress=async()=>Array.from({length:100},(_,i)=>{
  const signature='large-gap-'+(pages*100+i);f.transactions.set(signature,{meta:{err:null,fee:0,preBalances:[1e9],postBalances:[1e9]},transaction:{message:{accountKeys:[f.cfg.wallets[0].address]}}});
  if(i===99)pages++;return{signature,slot:10000-pages*100-i,blockTime:Math.floor(Date.now()/1000),err:null};
 });
 const interval=globalThis.setInterval;globalThis.setInterval=()=>({unref(){}});try{f.bot.start();}finally{globalThis.setInterval=interval;}
 await until(()=>f.bot.copyActivity().some(x=>x.status==='Recovery incomplete'));assert.equal(pages,10);checks.excessiveHistoryGapIsBoundedAndVisible=true;
}
// Slow balance display reads share one background request; an explicit balance
// verification stays urgent, and an older response cannot rewind the cache.
{
 const f=setup(),g=gate();let urgent=0,background=0;f.book.keypair=Keypair.generate();
 const account=createAccount({cfg:f.cfg,book:f.book,positionsFor:()=>f.positions,connection:{getBalance:async()=>{urgent++;return 2e9;}},balanceConnection:{getBalance:async()=>{background++;return g.promise;}}});
 const a=account.balance(),b=account.balance();assert.equal(background,1);assert.equal(urgent,0);
 assert.equal(await account.balance(true),2);g.resolve(1e9);assert.deepEqual(await Promise.all([a,b]),[2,2]);assert.equal(account.cachedBalance(),2);checks.balanceDisplayIsCoalescedBackgroundWork=true;
}
{
 const oldFetch=globalThis.fetch,g=gate(),m=mint();let calls=0;
 globalThis.fetch=async()=>{calls++;await g.promise;return Response.json([{baseToken:{address:m,symbol:'TEST'}}]);};
 try{const a=tokenNames([m]),b=tokenNames([m]);assert.equal(calls,1);g.resolve();const [first,second]=await Promise.all([a,b]);assert.equal(first(m),'$TEST');assert.equal(second(m),'$TEST');checks.tokenNameRequestsAreCoalesced=true;}finally{globalThis.fetch=oldFetch;}
}
{
 const f=setup();f.connection.getParsedTransaction=()=>new Promise(()=>{});const started=Date.now();
 await f.bot.handleSignature(f.cfg.wallets[0],'stalled-receipt');assert(Date.now()-started<4300);assert(f.bot.copyActivity().some(x=>x.status==='Waiting'));checks.stalledSourceReceiptHasABoundedWait=true;
}
{
 const f=setup(),m=mint();let foreground=0,background=0,available=false;
 const tx={meta:{err:null,fee:5000,preBalances:[2e9],postBalances:[1.5e9-5000],preTokenBalances:[],postTokenBalances:[{mint:m,owner:f.cfg.wallets[0].address,uiTokenAmount:{amount:'1000',decimals:6}}]},transaction:{message:{accountKeys:[f.cfg.wallets[0].address]}}};
 f.connection.rpcEndpoint='https://audit.invalid/rpc';
 f.bot=createBot({cfg:f.cfg,connection:f.connection,book:f.book,rpcFetch:async()=>{foreground++;return Response.json({result:available?tx:null});},backgroundRpcFetch:async()=>{background++;return Response.json({result:available?tx:null});}});
 await f.bot.handleSignature(f.cfg.wallets[0],'late-background-receipt');assert.equal(foreground,12);available=true;await sleep(2100);
 await f.bot.checkExits(true);await until(()=>f.positions.has(m));assert.equal(foreground,12);assert.equal(background,1);
 available=false;await f.bot.handleSignature(f.cfg.wallets[0],'reconnected-history',Date.now(),null,null,{seenAt:Date.now(),sequence:99,session:'recovery'});
 assert.equal(foreground,12);assert.equal(background,2);checks.delayedReceiptRetriesUseOneBackgroundRead=true;
}
// Recovery can find a sell before its older top-up notification. Receipt/balance
// quantities establish the new baseline and cannot trigger a premature 90% exit.
{
 const f=setup(),m=mint();await f.emit(m,'buy');f.sourceLeft=15_000_000_000_000n;
 await f.emit(m,'sell',{tokens:f.sourceLeft,slot:10});
 f.sourceLeft=22_500_000_000_000n;await f.emit(m,'sell',{tokens:f.sourceLeft,slot:12});assert.equal(f.positions.get(m).sourceRemainingFraction,.5);
 await f.emit(m,'buy',{slot:11});assert.equal(f.positions.get(m).sourceRemainingFraction,.5);
 for(const slot of [13,14]){f.sourceLeft/=2n;await f.emit(m,'sell',{tokens:f.sourceLeft,slot});assert(f.positions.has(m));}
 f.sourceLeft/=2n;await f.emit(m,'sell',{tokens:f.sourceLeft,slot:15});assert(!f.positions.has(m));checks.recoveredTopupUsesSourceQuantitiesWithoutEarlyExit=true;
}
// Switched-off wallets get no live feed (saving RPC usage) until switched on again.
const feeds=f=>{const live=new Map();let id=0;f.connection.onLogs=pk=>{live.set(++id,pk.toBase58());return id;};f.connection.removeOnLogsListener=async n=>{live.delete(n);};return()=>[...live.values()];};
const startWithSweep=f=>{const timers=[],interval=globalThis.setInterval;globalThis.setInterval=(fn,ms)=>{timers.push([fn,ms]);return{unref(){}};};try{f.bot.start();}finally{globalThis.setInterval=interval;}return()=>timers.filter(([,ms])=>ms===30_000).forEach(([fn])=>fn());};
{
 const f=setup(),off={label:'switched off',address:mint(),paused:true};f.cfg.wallets.push(off);const listening=feeds(f),sweep=startWithSweep(f);
 assert.deepEqual(listening(),[f.cfg.wallets[0].address]);
 delete off.paused;sweep();assert(listening().includes(off.address));
 off.paused=true;sweep();assert(!listening().includes(off.address));checks.switchedOffWalletHasNoLiveFeed=true;
}
{
 const f=setup(),m=mint(),w=f.cfg.wallets[0];await f.emit(m,'buy');const listening=feeds(f),sweep=startWithSweep(f);
 w.paused=true;sweep();assert(listening().includes(w.address));
 f.sourceLeft=0n;await f.emit(m,'sell');assert(!f.positions.has(m));assert(!listening().includes(w.address));checks.switchedOffWalletFeedStaysUntilHeldCoinSells=true;
}
{
 const f=setup(),m=mint(),off={label:'switched off',address:mint(),paused:true};f.cfg.wallets.push(off);
 f.safetyGate=gate();const buy=f.emit(m,'buy');await until(()=>f.safetyStarted);
 const reads=f.receiptReads??0;await f.bot.handleSignature(off,'switched-off-trade');
 assert.equal(f.receiptReads??0,reads);f.safetyGate.resolve();await buy;checks.switchedOffWalletTradeIsNeverDownloaded=true;
}
if(output)fs.writeFileSync(output,JSON.stringify(checks,null,2));
console.log('PASS: reliability regression tests',Object.keys(checks).length);
