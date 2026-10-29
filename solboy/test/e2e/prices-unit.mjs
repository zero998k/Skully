import assert from 'node:assert/strict';
import {PublicKey,Keypair} from '@solana/web3.js';
import {createLivePrices,decodeCurve,decodePool,curveAddress,canonicalPool,PUMP,PUMP_AMM} from '../../src/live-prices.js';
import {WSOL} from '../../src/detect.js';
const results={},mint=Keypair.generate().publicKey.toBase58();
const curve=(sol=40_000_000_000n,tokens=800_000_000_000_000n,complete=false)=>{const data=Buffer.alloc(115);Buffer.from([23,183,248,55,96,216,172,96]).copy(data);data.writeBigUInt64LE(tokens,8);data.writeBigUInt64LE(sol,16);data[48]=Number(complete);return{owner:PUMP,data};};
const baseVault=Keypair.generate().publicKey,quoteVault=Keypair.generate().publicKey;
const pool=()=>{const data=Buffer.alloc(261);Buffer.from([241,154,109,4,17,177,109,188]).copy(data);new PublicKey(mint).toBuffer().copy(data,43);new PublicKey(WSOL).toBuffer().copy(data,75);baseVault.toBuffer().copy(data,139);quoteVault.toBuffer().copy(data,171);return{owner:PUMP_AMM,data};};
const vault=(m,n)=>{const data=Buffer.alloc(165);new PublicKey(m).toBuffer().copy(data);data.writeBigUInt64LE(n,64);return{owner:new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),data};};
assert(decodeCurve(curve()));assert.equal(decodeCurve({...curve(),owner:PUMP_AMM}),null);
const bad=curve();bad.data[0]=0;assert.equal(decodeCurve(bad),null);
const usd=curve();Keypair.generate().publicKey.toBuffer().copy(usd.data,83);assert.equal(decodeCurve(usd),null);
assert(decodePool(pool(),mint));const boosted=pool();boosted.data[245]=1;assert.equal(decodePool(boosted,mint),null);
results.validatedOfficialLayoutsAndSolQuotes=true;

let time=10000,mode='paper',current={tokens:'100000000000000',solSpent:1,openedAt:'2026-01-01T00:00:00Z'},curveData=curve(),poolData=null,quoteCalls=0,busy=false,slotCallback;
const subscriptions=new Map(),removed=[],book={get mode(){return mode;},positions:{entries:()=>current?[[mint,current]]:[],has:m=>m===mint&&!!current,get:()=>current}};
const conn={onAccountChange:(key,fn)=>{const id=subscriptions.size+1;subscriptions.set(id,{key:key.toBase58(),fn});return id;},removeAccountChangeListener:async id=>{removed.push(id);subscriptions.delete(id);},
 onSlotChange:fn=>{slotCallback=fn;return 200;},removeSlotChangeListener:async()=>{},onLogs:()=>300,removeOnLogsListener:async()=>{},
 getAccountInfoAndContext:async()=>({context:{slot:10},value:curveData}),getAccountInfo:async()=>poolData,
 getMultipleAccountsInfoAndContext:async()=>({context:{slot:20},value:[vault(mint,1000000000000000n),vault(WSOL,100_000_000_000n)]})};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const push=(key,info,slot)=>{for(const s of subscriptions.values())if(s.key===key.toBase58())s.fn(info,{slot});};
let engine=createLivePrices({connection:conn,book,now:()=>time,isTrading:()=>busy,readQuote:async()=>{quoteCalls++;return{outAmount:'3000000000'};}});
engine.start();await flush();let p=engine.get(mint,current);assert.equal(p.marketWorth,5);assert.equal(p.priceStale,false);assert.equal(quoteCalls,0);
push(curveAddress(mint),curve(80_000_000_000n),11);p=engine.get(mint,current);assert.equal(p.marketWorth,10);assert(Math.abs(p.worth-8.8)<1e-8);assert.equal(p.priceStale,false);
push(curveAddress(mint),curve(1_000_000_000n),9);assert.equal(engine.get(mint,current).marketWorth,10);
time+=6100;assert.equal(engine.get(mint,current).priceStale,true);assert.equal(engine.get(mint,current).marketStale,true);
slotCallback({slot:12});assert.equal(engine.get(mint,current).priceStale,true);push(curveAddress(mint),curve(80_000_000_000n),12);assert.equal(engine.get(mint,current).priceStale,false);
const old=current;current={...current,tokens:'50000000000000'};assert.equal(engine.get(mint,current),null);engine.sync();assert(removed.length>0);
mode='live';assert.equal(engine.get(mint,current),null);engine.stop();current=old;mode='paper';
results.curveTicksAreImmediateAndOlderSlotsCannotRewind=true;results.heartbeatLossAndPositionChangesInvalidatePrices=true;

curveData=null;poolData=pool();engine=createLivePrices({connection:conn,book,now:()=>time,readQuote:async()=>({outAmount:'3000000000'})});engine.start();await flush();
assert.equal(engine.get(mint,current).marketWorth,10);
push(baseVault,vault(mint,500000000000000n),21);assert.equal(engine.get(mint,current).marketStale,true);assert.equal(engine.get(mint,current).marketWorth,10);
push(quoteVault,vault(WSOL,200_000_000_000n),21);assert.equal(engine.get(mint,current).marketWorth,40);assert.equal(engine.get(mint,current).marketStale,false);
push(baseVault,vault(mint,250000000000000n),21);assert.equal(engine.get(mint,current).marketStale,true);
push(quoteVault,vault(WSOL,100_000_000_000n),21);assert.equal(engine.get(mint,current).marketWorth,40);assert.equal(engine.get(mint,current).marketStale,false);
engine.stop();results.poolTicksNeverMixDifferentSlotsOrHalfUpdates=true;

poolData=null;curveData=null;
engine=createLivePrices({connection:conn,book,now:()=>time,readQuote:async()=>({outAmount:'3000000000'})});engine.start();await flush();engine.tick();await flush();
assert.equal(engine.get(mint,current).priceStale,false);assert(engine.get(mint,current).priceValidUntil>time);time+=3100;assert.equal(engine.get(mint,current).priceStale,true);engine.stop();results.quoteExpiryMatchesWhatTheScreenReceives=true;
quoteCalls=0;let resolveQuote;
engine=createLivePrices({connection:conn,book,now:()=>time,isTrading:()=>busy,readQuote:()=>{quoteCalls++;return new Promise(r=>resolveQuote=r);}});
busy=true;engine.start();await flush();assert.equal(quoteCalls,0);busy=false;engine.tick();await flush();engine.tick();assert.equal(quoteCalls,1);
time+=4000;resolveQuote({outAmount:'4000000000'});await flush();assert.equal(engine.get(mint,current).priceStale,true);
time+=2200;slotCallback({slot:30});engine.tick();await flush();engine.tick();assert.equal(quoteCalls,2);const previousPosition=current;current=null;engine.sync();resolveQuote({outAmount:'9000000000'});await flush();current={...previousPosition,openedAt:'2026-01-02T00:00:00Z'};assert.equal(engine.get(mint,current),null);engine.stop();
let releaseBootstrap;current={...current,tokens:'100000000000000'};
const lateConnection={...conn,getAccountInfoAndContext:()=>new Promise(r=>releaseBootstrap=r)};
engine=createLivePrices({connection:lateConnection,book,now:()=>time,readQuote:async()=>({outAmount:'1'})});engine.start();push(curveAddress(mint),curve(80_000_000_000n),50);
releaseBootstrap({context:{slot:50},value:curve()});await flush();assert.equal(engine.get(mint,current).marketWorth,10);engine.stop();results.streamBeatsLateBootstrapWithinSameSlot=true;
current={...current,tokens:'0'};engine=createLivePrices({connection:conn,book,now:()=>time,readQuote:async()=>{throw Error('Must not price an unknown token balance');}});engine.start();await flush();assert.equal(engine.get(mint,current),null);engine.stop();
results.slowQuotesUseRequestTimeAndCannotResurrectPositions=true;results.backgroundQuotesYieldToTradesAndAreRateBounded=true;results.unknownTokenBalancesAreNeverPricedAsTotalLoss=true;
console.log(JSON.stringify(results));
