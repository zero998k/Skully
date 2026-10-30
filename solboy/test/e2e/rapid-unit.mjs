// Real copy engine with controllable fake receipts, confirmation and RPC visibility. Never real funds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PublicKey, Keypair, TransactionMessage, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import {EventEmitter} from 'node:events';
const output=process.argv[2],dir=fs.mkdtempSync(path.join(os.tmpdir(),'solboy-rapid-'));
process.chdir(dir);delete process.env.TELEGRAM_BOT_TOKEN;delete process.env.TELEGRAM_CHAT_ID;
process.env.JUPITER_API_URL='https://unit.invalid/jupiter';process.env.PUMPPORTAL_API_URL='https://unit.invalid/pump';
const {createBot}=await import('../../src/bot.js'),{Positions}=await import('../../src/positions.js'),{createAccount}=await import('../../src/account.js');
const base=JSON.parse(fs.readFileSync(new URL('./config.base.json',import.meta.url)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const until=async fn=>{for(let i=0;i<1500;i++){if(fn())return;await sleep(5);}throw Error('Timed out waiting for test trade');};
let instance=0,signature=0,fixture;
const event=(mint,side,tokens=30_000_000_000_000n)=>{
 const b=Buffer.alloc(129);Buffer.from([189,219,127,211,78,230,97,238]).copy(b);new PublicKey(mint).toBuffer().copy(b,8);
 b.writeBigUInt64LE(1_500_000_000n,40);b.writeBigUInt64LE(tokens,48);b[56]=side==='buy'?1:0;new PublicKey(base.wallets[0].address).toBuffer().copy(b,57);
 b.writeBigUInt64LE(40_000_000_000n,97);b.writeBigUInt64LE(800_000_000_000_000n,105);
 return ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]','Program data: '+b.toString('base64')];
};
const accounts=n=>({value:n?[{account:{data:{parsed:{info:{tokenAmount:{amount:String(n)}}}}}}]:[]});
function receipt(owner,mint,side,tokens=1000n){
 const pre=side==='buy'?0n:tokens,post=side==='buy'?tokens:0n;
 return {meta:{err:null,fee:5000,preBalances:[2e9],postBalances:[side==='buy'?1.9e9-5000:2.1e9-5000],
 preTokenBalances:[{mint,owner,uiTokenAmount:{amount:String(pre),decimals:6}}],postTokenBalances:[{mint,owner,uiTokenAmount:{amount:String(post),decimals:6}}]},transaction:{message:{accountKeys:[owner]}}};
}
function setup(live=false){
 const cfg={...base,wallets:base.wallets.map(x=>({...x})),dryRun:!live,onlyFirstBuy:true,sellOnlyOnFullExit:true,dailyLossLimitSol:1000,maxOpenPositions:20};
 const positions=new Positions(path.join(dir,`positions-${++instance}.json`)),owner=Keypair.generate(),held=new Map(),txs=new Map(),statuses=new Map();
 const f={cfg,positions,owner,held,txs,statuses,sends:[],quotes:0,balance:2e9,confirmationMs:10,sourceLeft:0n,visibilityReads:0,route:false};
 const connection={
  getParsedAccountInfo:async(_mint,commitment)=>{f.safetyCommitment=commitment;if(f.missingMintReads-->0)return{value:null};if(f.safetyGate)await f.safetyGate.promise;return{value:{data:{parsed:{info:{mintAuthority:null,freezeAuthority:null}}}}};},
  getParsedTokenAccountsByOwner:async(key,{mint})=>{if(key.toBase58()===cfg.wallets[0].address){if(f.sourceError)throw Error('Source RPC temporarily unavailable');return accounts(f.sourceLeft);}if(f.visibilityReads-->0)return accounts(0n);return accounts(held.get(mint.toBase58())??0n);},
  getBalance:async()=>f.balance,
  getParsedTransaction:async sig=>{f.sourceDownloads=(f.sourceDownloads??0)+1;const value=txs.get(sig);return value?.promise?await value.promise:value??null;},
  getSignatureStatuses:async sigs=>({value:sigs.map(sig=>statuses.get(sig)??null)}),isBlockhashValid:async()=>({value:f.blockhashValid??true}),
  getAccountInfo:async()=>null,
  sendRawTransaction:async raw=>{const tx=VersionedTransaction.deserialize(raw),ix=tx.message.compiledInstructions[0],side=ix.data[0]===1?'buy':'sell',mint=tx.message.staticAccountKeys[ix.accountKeyIndexes[1]].toBase58(),sig=bs58.encode(tx.signatures[0]);
    const previousHeld=held.get(mint)??0n;f.sends.push({side,mint,at:Date.now(),sig});
    if(!f.failOnChain){if(side==='buy')held.set(mint,(held.get(mint)??0n)+1000n);else{held.set(mint,0n);f.balance+=100_000_000;}}
    const verified=receipt(owner.publicKey.toBase58(),mint,side);
    if(side==='sell'&&f.partialSell){verified.meta.postTokenBalances[0].uiTokenAmount.amount='500';held.set(mint,500n);}
    if(side==='sell'&&f.sellFillTokens){const left=previousHeld-f.sellFillTokens;verified.meta.preTokenBalances[0].uiTokenAmount.amount=String(previousHeld);verified.meta.postTokenBalances[0].uiTokenAmount.amount=String(left);held.set(mint,left);}
    txs.set(sig,verified);
    statuses.set(sig,{err:f.failOnChain?{InstructionError:[0,'Custom']}:null,confirmationStatus:f.confirmationUnknown?'processed':'confirmed'});
    if(f.sendError)throw Error('RPC connection dropped after send');return sig;
  },
  confirmTransaction:async()=>{if(f.confirmGate)await f.confirmGate.promise;await sleep(f.confirmationMs);if(f.confirmationUnknown)throw Error('Signature subscription disconnected');return{value:{err:f.failOnChain?{InstructionError:[0,'Custom']}:null}};},
 };
 f.connection=connection;f.book={positions,keypair:owner,tradeLogFile:path.join(dir,`trades-${instance}.csv`)};f.bot=createBot({cfg,connection,book:f.book});
 f.emit=(mint,side,opts={})=>f.bot.handleSignature(cfg.wallets[0],opts.sig??`source-${++signature}`,opts.at??Date.now(),opts.routed?null:event(mint,side,opts.tokens),opts.slot??null);
 fixture=f;return f;
}
globalThis.fetch=async(url,init={})=>{
 const f=fixture,u=String(url);init.signal?.throwIfAborted();
 if(u.includes('/quote?')){f.quotes++;if(f.quoteError)throw Error('Quote server unavailable');const query=new URL(u).searchParams;f.quoteAmounts??=[];f.quoteAmounts.push(query.get('amount'));return f.route?Response.json({inputMint:query.get('inputMint'),outputMint:query.get('outputMint'),inAmount:query.get('amount'),outAmount:'1000'}):new Response('No route',{status:400});}
 if(u.endsWith('/trade-local')||u.endsWith('/swap')){
  if(f.buildGate)await f.buildGate.promise;if(f.buildError)throw Error('Trade builder unavailable');
  const body=JSON.parse(init.body),side=body.action??(body.quoteResponse.inputMint==='So11111111111111111111111111111111111111112'?'buy':'sell'),mint=body.mint??(side==='buy'?body.quoteResponse.outputMint:body.quoteResponse.inputMint),user=new PublicKey(body.publicKey??body.userPublicKey);
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:user,recentBlockhash:'11111111111111111111111111111111',instructions:[new TransactionInstruction({programId:new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),keys:[{pubkey:user,isSigner:true,isWritable:true},{pubkey:new PublicKey(mint),isSigner:false,isWritable:true}],data:Buffer.from([side==='buy'?1:2,++signature%255])})]}).compileToV0Message());
  return u.endsWith('/swap')?Response.json({swapTransaction:Buffer.from(tx.serialize()).toString('base64'),lastValidBlockHeight:100}):new Response(tx.serialize());
 }
 throw Error('Unexpected external request '+u);
};
const results={},samples=[];
// Repeated actual elapsed holds, including 3 and 5 seconds, both practice and simulated on-chain.
for(const live of [false,true])for(const hold of [25,100,500,1000,3000,5000])for(let round=0;round<2;round++){
 const f=setup(live),mint=Keypair.generate().publicKey.toBase58();
 const buy=f.emit(mint,'buy');await until(()=>live?f.sends.some(x=>x.side==='buy'):f.positions.has(mint));
 await sleep(hold);const start=Date.now();const sell=f.emit(mint,'sell');await Promise.all([buy,sell]);
 assert.equal(f.positions.has(mint),false);if(live)assert.deepEqual(f.sends.map(x=>x.side),['buy','sell']);
 samples.push({live,holdMs:hold,round,exitCompleteMs:Date.now()-start,sellSubmitMs:f.bot.copySpeed().last*1000});
}
results.repeatedRapidCyclesNoMissedOrDuplicateExits=true;
// Exit arrives during a much slower buy confirmation; source balance read overlaps that wait.
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();f.confirmGate=gate();const buy=f.emit(mint,'buy');await until(()=>f.sends.length===1);
 const sell=f.emit(mint,'sell');await sleep(50);f.confirmGate.resolve();await Promise.all([buy,sell]);assert.deepEqual(f.sends.map(x=>x.side),['buy','sell']);assert(!f.positions.has(mint));results.exitDuringBuyConfirmationIsKept=true;
}
for(const phase of ['safetyGate','buildGate']){
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();f[phase]=gate();const buy=f.emit(mint,'buy');await sleep(30);const sell=f.emit(mint,'sell');await sleep(15);f[phase].resolve();await Promise.all([buy,sell]);assert.equal(f.sends.length,0);assert(!f.positions.has(mint));
}results.alreadyExitedBuysAreCancelledBeforeSubmission=true;
{
 const f=setup(),mint=Keypair.generate().publicKey.toBase58(),sig='slow-routed-buy',g=gate();f.txs.set(sig,g);const buy=f.emit(mint,'buy',{routed:true,sig,slot:10});
 await f.emit(mint,'sell',{slot:11});g.resolve(receipt(f.cfg.wallets[0].address,mint,'buy'));await buy;assert(!f.positions.has(mint));results.slowOldReceiptCannotEnterAfterExit=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await Promise.all([f.emit(mint,'buy',{sig:'duplicate-buy'}),f.emit(mint,'buy',{sig:'duplicate-buy'})]);
 await Promise.all([f.emit(mint,'sell',{sig:'duplicate-sell'}),f.emit(mint,'sell',{sig:'duplicate-sell'})]);assert.deepEqual(f.sends.map(x=>x.side),['buy','sell']);results.duplicateNotificationsOnlyTradeOnce=true;
}
{
 const f=setup(),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy',{slot:10});await f.emit(mint,'sell',{slot:11});await f.emit(mint,'buy',{slot:13});await f.emit(mint,'sell',{slot:12});assert(f.positions.has(mint));await f.emit(mint,'sell',{slot:14});assert(!f.positions.has(mint));results.oldExitCannotSellNewEntry=true;
}
{
 const f=setup(),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.sourceLeft=30_000_000_000_000n;await f.emit(mint,'sell');assert(f.positions.has(mint));f.cfg.sellOnlyOnFullExit=false;const held=BigInt(f.positions.get(mint).tokens);await f.emit(mint,'sell');assert.equal(BigInt(f.positions.get(mint).tokens),held/2n);results.partialSellRulesPreserved=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();f.failOnChain=true;await f.emit(mint,'buy');await f.emit(mint,'sell');assert.equal(f.sends.length,1);assert(!f.positions.has(mint));results.failedBuyCannotCreatePhantomExit=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.positions.update(mint,{balanceAt:0});f.visibilityReads=3;await f.emit(mint,'sell');assert(!f.positions.has(mint));assert.equal(f.sends.length,2);results.briefBalanceVisibilityLagDoesNotLoseExit=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.positions.update(mint,{balanceAt:0});f.visibilityReads=10;await f.emit(mint,'sell');assert(f.positions.get(mint).queuedExit);assert.equal(f.sends.length,1);f.visibilityReads=0;await f.bot.checkExits();await until(()=>!f.positions.has(mint));assert.equal(f.sends.length,2);results.longerBalanceLagRetainsAndRetriesUnsentExit=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.buildError=true;await assert.rejects(f.bot.sellNow(mint),/builder unavailable/);assert(f.positions.has(mint));assert(!f.positions.get(mint).pendingSell);f.buildError=false;await Promise.all([f.bot.sellNow(mint),f.bot.sellNow(mint)]);assert.equal(f.sends.length,2);results.failedManualSellReportsErrorAndCanRetry=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.confirmationUnknown=true;await assert.rejects(f.bot.sellNow(mint),/confirmation is delayed/);assert(f.positions.get(mint).pendingSell);
 const saved=new Positions(f.positions.file);assert(saved.get(mint).pendingSell.sig);await assert.rejects(f.bot.sellNow(mint),/already submitted/);assert.equal(f.sends.length,2);
 const sig=f.positions.get(mint).pendingSell.sig;f.statuses.set(sig,{err:null,confirmationStatus:'confirmed'});await f.bot.sellNow(mint);assert(!f.positions.has(mint));assert.equal(f.sends.length,2);results.uncertainConfirmationPersistsAndReconcilesWithoutResend=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.sendError=true;await assert.rejects(f.bot.sellNow(mint),/confirmation is delayed/);assert(f.positions.get(mint).pendingSell);f.sendError=false;await f.bot.sellNow(mint);assert(!f.positions.has(mint));assert.equal(f.sends.length,2);results.sendResponseLossCannotDuplicateAcceptedSell=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');const q=f.quotes;await f.emit(mint,'sell');assert.equal(f.quotes,q);results.freshPumpSellsAvoidRedundantQuotes=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.confirmGate=gate();f.confirmationUnknown=true;
 const start=Date.now();await assert.rejects(f.bot.sellNow(mint),/confirmation is delayed/);assert(Date.now()-start<23000);assert(f.positions.get(mint).pendingSell);
 const sig=f.positions.get(mint).pendingSell.sig;await assert.rejects(f.bot.sellNow(mint),/already submitted/);assert.equal(f.sends.length,2);
 f.confirmationUnknown=false;f.confirmGate.resolve();f.statuses.set(sig,{err:null,confirmationStatus:'confirmed'});await f.bot.sellNow(mint);assert(!f.positions.has(mint));assert.equal(f.sends.length,2);results.hungConfirmationHasBoundedWaitAndSafeRecovery=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.confirmationUnknown=true;await assert.rejects(f.bot.sellNow(mint));
 const sig=f.positions.get(mint).pendingSell.sig;f.statuses.delete(sig);f.blockhashValid=false;
 await assert.rejects(f.bot.sellNow(mint),/did not land/);assert(!f.positions.get(mint).pendingSell);assert.equal(f.sends.length,2);
 f.confirmationUnknown=false;f.held.set(mint,1000n);await f.bot.sellNow(mint);assert.equal(f.sends.length,3);results.expiredUnlandedSellNeedsSeparateNewAttempt=true;
}
{
 const f=setup(),mint=Keypair.generate().publicKey.toBase58(),lines=[...event(mint,'buy'),...event(mint,'sell')];
 await f.bot.handleSignature(f.cfg.wallets[0],'atomic-roundtrip',Date.now(),lines,100);assert(!f.positions.has(mint));assert.equal(f.bot.copySpeed(),null);results.atomicSourceRoundTripDoesNotLeaveAnEntry=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.sourceError=true;await f.emit(mint,'sell');assert(f.positions.get(mint).queuedSourceExit);assert.equal(f.sends.length,1);
 f.sourceError=false;await f.bot.checkExits();await until(()=>!f.positions.has(mint));assert.equal(f.sends.length,2);results.sourceRpcFailureRetainsExitForRetry=true;
}
{
 const f=setup(),mint=Keypair.generate().publicKey.toBase58(),sig='receipt-arrives-late';
 await f.emit(mint,'buy',{routed:true,sig});assert(f.bot.copyActivity().some(x=>x.status==='Waiting'));
 f.route=true;f.txs.set(sig,receipt(f.cfg.wallets[0].address,mint,'buy'));await sleep(2100);await f.bot.checkExits();await until(()=>f.positions.has(mint));
 assert.equal(f.bot.copyActivity().filter(x=>x.status==='Copied').length,1);results.delayedSourceReceiptsAreRetriedWithoutDuplicateCopy=true;
}
{
 const f=setup(),mint=Keypair.generate().publicKey.toBase58(),sig='reconnect-buy';f.route=true;
 f.txs.set(sig,receipt(f.cfg.wallets[0].address,mint,'buy'));f.connection._rpcWebSocket=new EventEmitter();
 f.connection.onLogs=()=>1;f.connection.getSignaturesForAddress=async()=>[{signature:sig,slot:50,blockTime:Math.floor(Date.now()/1000),err:null}];
 const interval=globalThis.setInterval;globalThis.setInterval=()=>({unref(){}});f.bot.start();globalThis.setInterval=interval;
 f.connection._rpcWebSocket.emit('close');f.connection._rpcWebSocket.emit('open');await until(()=>f.positions.has(mint));
 f.connection._rpcWebSocket.emit('close');f.connection._rpcWebSocket.emit('open');await sleep(50);assert.equal(f.bot.copyActivity().filter(x=>x.status==='Copied').length,1);results.reconnectBackfillFindsMissedBuyAndDeduplicates=true;
}
{
 const f=setup(),a=Keypair.generate().publicKey.toBase58(),b=Keypair.generate().publicKey.toBase58(),w2={label:'second source',address:Keypair.generate().publicKey.toBase58()},sig='shared-source-transaction';f.cfg.wallets.push(w2);f.route=true;
 const tx=receipt(w2.address,b,'buy');f.txs.set(sig,tx);
 await f.emit(a,'buy',{sig});await f.bot.handleSignature(w2,sig,Date.now(),null,1);assert(f.positions.has(a)&&f.positions.has(b));results.oneTransactionCanCopyTwoDifferentWatchedWallets=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');const cost=f.positions.get(mint).solSpent;
 f.partialSell=true;await f.bot.sellNow(mint);assert.equal(f.positions.get(mint).tokens,'500');assert(Math.abs(f.positions.get(mint).solSpent-cost/2)<1e-10);results.partialActualFillKeepsRemainingTokensAndCost=true;
}
{
 const f=setup(),mint=Keypair.generate().publicKey.toBase58();f.safetyGate=gate();const buy=f.emit(mint,'buy');
 const account=createAccount({cfg:f.cfg,connection:f.connection,book:f.book,positionsFor:()=>f.positions});await assert.rejects(account.setMode('paper'),/trade is still/);assert(f.cfg.dryRun);f.safetyGate.resolve();await buy;results.inflightTradesCannotBeMovedBetweenPaperAndLiveBooks=true;
}
{
 const f=setup(),mint=Keypair.generate().publicKey.toBase58(),buySig='gap-buy',sellSig='gap-sell';f.route=true;
 f.txs.set(buySig,receipt(f.cfg.wallets[0].address,mint,'buy'));f.txs.set(sellSig,receipt(f.cfg.wallets[0].address,mint,'sell'));f.connection._rpcWebSocket=new EventEmitter();f.connection.onLogs=()=>1;
 f.connection.getSignaturesForAddress=async()=>[{signature:sellSig,slot:52,blockTime:Math.floor(Date.now()/1000),err:null},{signature:buySig,slot:51,blockTime:Math.floor(Date.now()/1000),err:null}];
 const interval=globalThis.setInterval;globalThis.setInterval=()=>({unref(){}});f.bot.start();globalThis.setInterval=interval;f.connection._rpcWebSocket.emit('close');f.connection._rpcWebSocket.emit('open');await until(()=>f.bot.copyActivity().some(x=>x.reason.includes('already exited')));assert(!f.positions.has(mint));results.reconnectDoesNotBuyAfterDeveloperAlreadyExited=true;
}
{
 const f=setup(),mint=Keypair.generate().publicKey.toBase58();f.missingMintReads=2;await f.emit(mint,'buy');assert(f.positions.has(mint));assert.equal(f.safetyCommitment,'processed');results.newDeveloperMintSafetyWaitsForProcessedAccount=true;
}
{
 const f=setup(),mint=Keypair.generate().publicKey.toBase58();f.cfg.wallets[0].paused=true;await f.emit(mint,'buy',{routed:true,sig:'off-source-no-download'});assert.equal(f.sourceDownloads??0,0);assert(!f.positions.has(mint));assert(f.bot.copyActivity().some(x=>x.reason.includes('switched off')));results.switchedOffSourcesDoNotConsumeCopyRpcSlots=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.visibilityReads=100;await f.emit(mint,'sell');assert(!f.positions.has(mint));assert.equal(f.sends.length,2);results.freshVerifiedFillsExitWithoutLaggingBalanceLookup=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();let confirmations=0;const previous=f.connection.confirmTransaction;f.connection.confirmTransaction=async(...args)=>{confirmations++;return previous(...args);};f.connection.onSignature=()=>1;f.connection.removeSignatureListener=async()=>{};
 await f.emit(mint,'buy');await f.emit(mint,'sell');assert.equal(confirmations,0);assert(!f.positions.has(mint));assert.equal(f.sends.length,2);results.confirmedReceiptAvoidsRedundantSignatureRpcPolling=true;
}
// A copied sell is a durable target balance, retained across errors and process restarts.
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.buildError=true;await f.emit(mint,'sell');assert(f.positions.get(mint).copiedExit?.lastError);assert.equal(f.sends.length,1);
 f.buildError=false;f.positions.update(mint,{copiedExit:{...f.positions.get(mint).copiedExit,nextAttemptAt:0}});await f.bot.checkExits(true);await until(()=>!f.positions.has(mint));assert.equal(f.sends.length,2);results.failedCopiedBuilderRetriesWithoutAnotherSourceSell=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.buildError=true;await f.emit(mint,'sell');
 f.positions=new Positions(f.positions.file);f.book.positions=f.positions;f.bot=createBot({cfg:f.cfg,connection:f.connection,book:f.book});f.buildError=false;f.route=true;
 f.positions.update(mint,{copiedExit:{...f.positions.get(mint).copiedExit,nextAttemptAt:0}});await f.bot.checkExits(true);await until(()=>!f.positions.has(mint));assert.equal(f.sends.length,2);results.failedCopiedExitSurvivesAppRestart=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.failOnChain=true;await f.emit(mint,'sell');assert(f.positions.get(mint).copiedExit);assert(!f.positions.get(mint).pendingSell);
 f.failOnChain=false;f.positions.update(mint,{copiedExit:{...f.positions.get(mint).copiedExit,nextAttemptAt:0}});await f.bot.checkExits(true);await until(()=>!f.positions.has(mint));assert.equal(f.sends.length,3);results.failedOnChainCopiedSellGetsOneNewAttempt=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.sendError=true;await f.emit(mint,'sell');assert(f.positions.get(mint).pendingSell);assert(f.positions.get(mint).copiedExit);
 f.sendError=false;await f.bot.checkExits(true);await until(()=>!f.positions.has(mint));assert.equal(f.sends.length,2);results.copiedSellResponseLossChecksTheAcceptedSignatureWithoutResend=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.confirmationUnknown=true;await f.emit(mint,'sell');const pending=f.positions.get(mint).pendingSell;assert(pending);
 f.statuses.delete(pending.sig);f.blockhashValid=false;f.confirmationUnknown=false;f.held.set(mint,1000n);await f.bot.checkExits(true);await until(()=>!f.positions.get(mint)?.pendingSell);
 f.positions.update(mint,{copiedExit:{...f.positions.get(mint).copiedExit,nextAttemptAt:0}});await f.bot.checkExits(true);await until(()=>!f.positions.has(mint));assert.equal(f.sends.length,3);results.expiredCopiedSellRetriesOnlyAfterHistoryAndExpiryChecks=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.cfg.sellOnlyOnFullExit=false;f.sourceLeft=30_000_000_000_000n;f.buildError=true;await f.emit(mint,'sell',{sig:'durable-half-exit'});assert.equal(f.positions.get(mint).copiedExit.targetRemaining,'500');
 // Another sale reduced the balance while the first attempt was waiting. Retry the missing 300, not half of 800.
 f.positions.update(mint,{tokens:'800',solSpent:f.positions.get(mint).solSpent*.8,copiedExit:{...f.positions.get(mint).copiedExit,nextAttemptAt:0}});f.held.set(mint,800n);f.sellFillTokens=300n;f.buildError=false;f.route=true;
 await f.bot.checkExits(true);await until(()=>f.sends.length===2&&!f.positions.get(mint)?.pendingSell);assert.equal(f.quoteAmounts.at(-1),'300');assert.equal(f.positions.get(mint).tokens,'500');assert.equal(f.positions.get(mint).copiedExit,null);
 f.positions=new Positions(f.positions.file);f.book.positions=f.positions;f.bot=createBot({cfg:f.cfg,connection:f.connection,book:f.book});await f.emit(mint,'sell',{sig:'durable-half-exit'});await f.bot.checkExits(true);assert.equal(f.sends.length,2);results.partialRetriesUseAnAbsoluteTargetAndDeduplicateAfterRestart=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.cfg.sellOnlyOnFullExit=false;f.buildError=true;f.sourceLeft=90_000_000_000_000n;await f.emit(mint,'sell');assert.equal(f.positions.get(mint).copiedExit.targetRemaining,'750');
 f.sourceLeft=30_000_000_000_000n;await f.emit(mint,'sell');assert.equal(f.positions.get(mint).copiedExit.targetRemaining,'375');results.consecutivePartialSourceSellsCombineWithoutLosingTheFirstExit=true;
}
{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.buildError=true;await f.emit(mint,'sell');const attempts=f.positions.get(mint).copiedExit.attempts;await f.bot.checkExits(true);assert.equal(f.positions.get(mint).copiedExit.attempts,attempts);
 f.cfg.followSells=false;f.positions.update(mint,{copiedExit:{...f.positions.get(mint).copiedExit,nextAttemptAt:0}});await f.bot.checkExits(true);assert.equal(f.sends.length,1);f.cfg.followSells=true;f.buildError=false;
 await Promise.all([f.bot.sellNow(mint),f.bot.checkExits(true)]);await until(()=>!f.positions.has(mint));assert.equal(f.sends.length,2);results.copyRetriesRespectBackoffFollowSettingsAndManualSellLocks=true;
}

{
 const f=setup(true),mint=Keypair.generate().publicKey.toBase58();await f.emit(mint,'buy');f.buildError=true;await f.emit(mint,'sell');f.quoteError=true;f.bot=createBot({cfg:f.cfg,connection:f.connection,book:f.book});
 const all=await f.bot.sellAll();assert.equal(all.writtenOff,0);assert(all.failed.length===1);assert(f.positions.get(mint).copiedExit);results.sellAllCannotWriteOffAPositionWithACopiedExitStillQueued=true;
}
const report={checks:results,simulated:true,samples,cycles:samples.length,maxSellSubmitMs:Math.max(...samples.map(x=>x.sellSubmitMs)),maxExitCompleteMs:Math.max(...samples.map(x=>x.exitCompleteMs))};
if(output)fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
