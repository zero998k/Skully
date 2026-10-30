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
assert(decodePool(pool(),mint));const boosted=pool();boosted.data[245]=1;assert.equal(decodePool(boosted,mint).virtual,1n);
results.validatedOfficialLayoutsAndSolQuotes=true;

let time=10000,mode='paper',current={tokens:'100000000000000',solSpent:1,openedAt:'2026-01-01T00:00:00Z'},curveData=curve(),poolData=null,quoteCalls=0,busy=false,slotCallback,routeCallback;
const subscriptions=new Map(),removed=[],book={get mode(){return mode;},positions:{entries:()=>current?[[mint,current]]:[],has:m=>m===mint&&!!current,get:()=>current}};
const conn={onAccountChange:(key,fn)=>{const id=subscriptions.size+1;subscriptions.set(id,{key:key.toBase58(),fn});return id;},removeAccountChangeListener:async id=>{removed.push(id);subscriptions.delete(id);},
 onSlotChange:fn=>{slotCallback=fn;return 200;},removeSlotChangeListener:async()=>{},onLogs:(_key,fn)=>{routeCallback=fn;return 300;},removeOnLogsListener:async()=>{},
 getAccountInfoAndContext:async()=>({context:{slot:10},value:curveData}),getAccountInfo:async()=>poolData,
 getMultipleAccountsInfoAndContext:async()=>({context:{slot:20},value:[vault(mint,1000000000000000n),vault(WSOL,100_000_000_000n),poolData]})};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const push=(key,info,slot)=>{for(const s of subscriptions.values())if(s.key===key.toBase58())s.fn(info,{slot});};
let engine=createLivePrices({connection:conn,book,now:()=>time,isTrading:()=>busy,readQuote:async()=>{quoteCalls++;return{outAmount:'3000000000'};}});
engine.start();await flush();let p=engine.get(mint,current);assert.equal(p.marketWorth,5);assert.equal(p.priceStale,false);assert.equal(quoteCalls,0);
push(curveAddress(mint),curve(80_000_000_000n),11);p=engine.get(mint,current);assert.equal(p.marketWorth,10);assert(Math.abs(p.worth-8.8)<1e-8);assert.equal(p.priceStale,false);
push(curveAddress(mint),curve(1_000_000_000n),9);assert.equal(engine.get(mint,current).marketWorth,10);
time+=6100;assert.equal(engine.get(mint,current).priceStale,true);assert.equal(engine.get(mint,current).marketStale,true);
slotCallback({slot:12});assert.equal(engine.get(mint,current).priceStale,true);push(curveAddress(mint),curve(80_000_000_000n),12);assert.equal(engine.get(mint,current).priceStale,false);assert.equal(engine.get(mint,current).marketStale,false);
const old=current;current={...current,tokens:'50000000000000'};assert.equal(engine.get(mint,current),null);engine.sync();assert(removed.length>0);
mode='live';assert.equal(engine.get(mint,current),null);engine.stop();current=old;mode='paper';
results.curveTicksAreImmediateAndOlderSlotsCannotRewind=true;results.heartbeatLossAndPositionChangesInvalidatePrices=true;

curveData=null;poolData=pool();engine=createLivePrices({connection:conn,book,now:()=>time,readQuote:async()=>({outAmount:'3000000000'})});engine.start();await flush();
assert.equal(engine.get(mint,current).marketWorth,10);
push(baseVault,vault(mint,500000000000000n),21);assert.equal(engine.get(mint,current).marketStale,true);assert.equal(engine.get(mint,current).marketWorth,10);
push(quoteVault,vault(WSOL,200_000_000_000n),21);push(canonicalPool(mint),poolData,21);assert.equal(engine.get(mint,current).marketWorth,40);assert.equal(engine.get(mint,current).marketStale,false);
push(baseVault,vault(mint,250000000000000n),21);assert.equal(engine.get(mint,current).marketStale,true);
push(quoteVault,vault(WSOL,100_000_000_000n),21);push(canonicalPool(mint),poolData,21);assert.equal(engine.get(mint,current).marketWorth,40);assert.equal(engine.get(mint,current).marketStale,false);
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

// Missing paired vault notifications recover from one consistent batched snapshot.
current=old;mode='paper';curveData=null;poolData=pool();
const recovering={...conn,getMultipleAccountsInfoAndContext:async()=>({context:{slot:30},value:[vault(mint,500000000000000n),vault(WSOL,200_000_000_000n),poolData]})};
engine=createLivePrices({connection:recovering,book,now:()=>time,readQuote:async()=>({outAmount:'3000000000'})});engine.start();await flush();
push(baseVault,vault(mint,250000000000000n),31);push(quoteVault,vault(WSOL,200_000_000_000n),32);assert(engine.get(mint,current).marketStale);
recovering.getMultipleAccountsInfoAndContext=async()=>({context:{slot:33},value:[vault(mint,500000000000000n),vault(WSOL,200_000_000_000n),poolData]});
time+=2200;slotCallback({slot:33});engine.tick();await flush();assert.equal(engine.get(mint,current).marketWorth,40);assert(!engine.get(mint,current).marketStale);engine.stop();results.missingVaultPairResyncsWithoutMixedPrices=true;
// A busy routed venue must not discard every completed sell quote forever.
poolData=null;let quoteNumber=0,finishBusyQuote;
engine=createLivePrices({connection:conn,book,now:()=>time,readQuote:()=>++quoteNumber===1?Promise.resolve({outAmount:'3000000000',routePlan:[{swapInfo:{ammKey:mint}}]}):new Promise(r=>finishBusyQuote=r)});
engine.start();await flush();engine.tick();await flush();time+=2200;slotCallback({slot:40});engine.tick();time+=1;routeCallback({err:null});finishBusyQuote({outAmount:'5000000000'});await flush();
assert.equal(engine.get(mint,current).worth,5);assert(engine.get(mint,current).priceStale);engine.stop();results.busyRouteQuotesStayVisibleButCannotTriggerStaleExits=true;
// A trade-event seed expires quickly, even if the WS connection itself remains alive.
busy=true;engine=createLivePrices({connection:conn,book,now:()=>time,isTrading:()=>busy,readQuote:async()=>({outAmount:'1'})});engine.start();engine.seedCurve(mint,{vSol:40,vTokens:800000000},42,time);assert.equal(engine.get(mint,current).marketWorth,5);
time+=1001;slotCallback({slot:43});assert(engine.get(mint,current).priceStale);engine.seedCurve(mint,{vSol:80,vTokens:800000000},41,time-2000);assert.equal(engine.get(mint,current).marketWorth,5);engine.stop();busy=false;results.entryPriceSeedIsImmediateAndExpiresWithoutARead=true;
// Signed virtual reserves, non-SOL quote conversion, and a completed zero-reserve curve.
const quotedMint=Keypair.generate().publicKey.toBase58();
const quotedPool=(virtual=-20_000_000_000n)=>{const p=pool();new PublicKey(quotedMint).toBuffer().copy(p.data,75);const raw=BigInt.asUintN(128,virtual);p.data.writeBigUInt64LE(raw&((1n<<64n)-1n),245);p.data.writeBigUInt64LE(raw>>64n,253);return p;};
assert.equal(decodePool(quotedPool(),mint).virtual,-20_000_000_000n);
assert.notEqual(canonicalPool(mint,quotedMint).toBase58(),canonicalPool(mint).toBase58());
curveData=curve(0n,0n,true);new PublicKey(quotedMint).toBuffer().copy(curveData.data,83);poolData=quotedPool();
let marketCalls=0,quoteRequests=0,asked=[];
const pricesFor=ids=>Object.fromEntries(ids.map(m=>[m,{usdPrice:m===WSOL?100:m===quotedMint?2:0.00001,decimals:m===quotedMint?8:m===WSOL?9:6,blockId:100}]));
const quotedConnection={...conn,getAccountInfo:async key=>key.equals(canonicalPool(mint,quotedMint))?poolData:null,
 getMultipleAccountsInfoAndContext:async()=>({context:{slot:100},value:[vault(mint,1000000000000000n),vault(quotedMint,100_000_000_000n),poolData]})};
engine=createLivePrices({connection:quotedConnection,book,now:()=>time,readMarket:async ids=>{marketCalls++;asked=ids;return pricesFor(ids);},readQuote:async()=>{quoteRequests++;return{outAmount:'1500000000',contextSlot:100};}});
engine.start();slotCallback({slot:100});await flush();engine.tick();await flush();
assert(asked.includes(quotedMint));assert.equal(engine.get(mint,current).marketWorth,1.6);assert(!engine.get(mint,current).marketStale);
assert.equal(engine.get(mint,current).solUsd,100);assert.equal(engine.get(mint,current).solUsdValidUntil,time+6000);results.referenceUsdUsesTheSameSolRateAsItsConversion=true;
assert.match(engine.get(mint,current).marketSource,/conversion/);assert.equal(marketCalls,1);assert.equal(quoteRequests,0);
time+=2100;slotCallback({slot:101});engine.tick();await flush();assert.equal(quoteRequests,1);assert.equal(marketCalls,1);
// All three account updates must agree; a pool fee change cannot be mixed with old vaults.
push(canonicalPool(mint,quotedMint),quotedPool(-40_000_000_000n),102);
push(baseVault,vault(mint,1000000000000000n),102);push(quoteVault,vault(quotedMint,100_000_000_000n),102);
assert.equal(engine.get(mint,current).marketWorth,1.2);assert(!engine.get(mint,current).marketStale);
push(canonicalPool(mint,quotedMint),quotedPool(500_000_000_000n),101);assert.equal(engine.get(mint,current).marketWorth,1.2);
engine.stop();results.nonSolPoolsUseDecimalsFreshConversionAndSignedVirtualReserves=true;
results.completedZeroReserveCurvesFindTheirActualQuotePool=true;

// One background call refreshes twenty positions; it shares, rather than doubles, the quote budget.
curveData=null;poolData=null;const many=new Map(Array.from({length:20},()=>[Keypair.generate().publicKey.toBase58(),{...old}]));
const manyBook={mode:'paper',positions:{entries:()=>[...many],has:m=>many.has(m),get:m=>many.get(m)}};
marketCalls=0;quoteRequests=0;let missing=false,lag=0,fail=false;
engine=createLivePrices({connection:conn,book:manyBook,now:()=>time,readMarket:async ids=>{marketCalls++;asked=ids;if(fail)throw Object.assign(Error('429'),{retryAfterMs:20000});return Object.fromEntries(Object.entries(pricesFor(ids)).filter(([m])=>!missing||m===WSOL).map(([m,p])=>[m,{...p,blockId:200-lag}]));},readQuote:async()=>{quoteRequests++;return{outAmount:'3000000000',contextSlot:200};}});
engine.start();slotCallback({slot:200});await flush();engine.tick();await flush();
assert.equal(marketCalls,1);assert.equal(asked.length,21);for(const [m,p]of many){assert(Math.abs(engine.get(m,p).marketWorth-10)<1e-9);assert(!engine.get(m,p).marketStale);}
engine.tick();await flush();assert.equal(quoteRequests,0);time+=2100;slotCallback({slot:200});engine.tick();await flush();assert.equal(quoteRequests,1);assert.equal(marketCalls,1);
results.twentyCoinsRefreshTogetherWithinOneSharedFreeRequestBudget=true;
time+=2100;slotCallback({slot:200});missing=true;engine.tick();await flush();time+=2100;slotCallback({slot:200});
for(const [m,p]of many)assert(engine.get(m,p).marketStale);results.missingPricesNeverRefreshAnOldReference=true;
// A newly received response can still contain old chain data: receipt time cannot make it fresh.
lag=40;missing=false;time+=2100;engine.tick();await flush();for(const [m,p]of many)assert(engine.get(m,p).marketStale);
results.oldBlockchainPricesAreRejectedEvenWhenJustReceived=true;
fail=true;slotCallback({slot:200});time+=4200;slotCallback({slot:200});engine.tick();await flush();const callsBefore=marketCalls+quoteRequests;
for(let i=0;i<9;i++){time+=1000;slotCallback({slot:200});engine.tick();await flush();}
assert.equal(marketCalls+quoteRequests,callsBefore);engine.stop();results.rateLimitsBackOffBothBackgroundRequestTypes=true;

// Busy pools remain usable with a recent context slot, but old slots and slow responses do not.
current=old;quoteNumber=0;
engine=createLivePrices({connection:conn,book,now:()=>time,readQuote:()=>++quoteNumber===1?Promise.resolve({outAmount:'3000000000',contextSlot:300,routePlan:[{swapInfo:{ammKey:mint}}]}):new Promise(r=>finishBusyQuote=r)});
engine.start();slotCallback({slot:300});await flush();engine.tick();await flush();
time+=2200;slotCallback({slot:302});engine.tick();time+=10;routeCallback({err:null},{slot:302});finishBusyQuote({outAmount:'5000000000',contextSlot:302});await flush();
assert.equal(engine.get(mint,current).worth,5);assert(!engine.get(mint,current).priceStale);
routeCallback({err:null},{slot:303});assert(!engine.get(mint,current).priceStale);
slotCallback({slot:312});assert(engine.get(mint,current).priceStale);engine.stop();results.busyRecentQuotesStayFreshButLaggingSlotsCannotTriggerExits=true;

// Conversion failure must not mistake an arbitrary quote currency for lamports/SOL.
curveData=curve(0n,0n,true);new PublicKey(quotedMint).toBuffer().copy(curveData.data,83);poolData=quotedPool();
engine=createLivePrices({connection:quotedConnection,book,now:()=>time,readMarket:async()=>({}),readQuote:async()=>{throw Error('No route');}});
engine.start();slotCallback({slot:100});await flush();engine.tick();await flush();assert.equal(engine.get(mint,current).marketWorth,null);assert(engine.get(mint,current).marketStale);assert(engine.get(mint,current).priceStale);engine.stop();results.unknownQuoteConversionNeverCreatesFakeSolProfits=true;

// When several quotes compete, a reference crossing a configured stop gets the next free turn.
curveData=null;poolData=null;const urgentMint=[...many.keys()].at(-1);for(const [m,p]of many)p.solSpent=m===urgentMint?1:100;
let allow=false,selected=null;
engine=createLivePrices({connection:conn,book:manyBook,now:()=>time,canRequest:()=>allow,quotePriority:(p,w)=>w>p.solSpent?1:0,
 readMarket:async ids=>Object.fromEntries(Object.entries(pricesFor(ids)).map(([m,p])=>[m,{...p,blockId:400}])),readQuote:async m=>{selected=m;return{outAmount:'3000000000',contextSlot:400};}});
engine.start();slotCallback({slot:400});await flush();engine.tick();await flush();assert.equal(selected,null);allow=true;engine.tick();await flush();time+=2100;slotCallback({slot:400});engine.tick();await flush();assert.equal(selected,urgentMint);engine.stop();
results.thresholdQuotesGetPriorityAndBackgroundCapacityNeverBlocksStreams=true;

// The app permits fifty positions: rotate, rather than silently truncate, the final token.
curveData=null;poolData=null;const fifty=new Map(Array.from({length:50},()=>[Keypair.generate().publicKey.toBase58(),{...old}]));
const fiftyBook={mode:'paper',positions:{entries:()=>[...fifty],has:m=>fifty.has(m),get:m=>fifty.get(m)}},covered=new Set();let batchSizes=[];
engine=createLivePrices({connection:conn,book:fiftyBook,now:()=>time,readMarket:async ids=>{batchSizes.push(ids.length);ids.forEach(m=>covered.add(m));return Object.fromEntries(Object.entries(pricesFor(ids)).map(([m,p])=>[m,{...p,blockId:500}]));},readQuote:async()=>({outAmount:'3000000000',contextSlot:500})});
engine.start();slotCallback({slot:500});await flush();engine.tick();await flush();time+=2100;slotCallback({slot:500});engine.tick();await flush();time+=2100;slotCallback({slot:500});engine.tick();await flush();
assert(batchSizes.length>=2&&batchSizes.every(n=>n<=50));for(const m of fifty.keys())assert(covered.has(m));engine.stop();results.fiftyPositionsRotateWithoutDroppingTheLastCoin=true;

// An initial RPC failure is retried; the independent quote fallback can still price the position.
current=old;curveData=curve();poolData=null;let setupReads=0;
const flaky={...conn,getAccountInfoAndContext:async()=>{if(++setupReads===1)throw Error('Temporary price RPC error');return{context:{slot:600},value:curveData};}};
engine=createLivePrices({connection:flaky,book,now:()=>time,readQuote:async()=>({outAmount:'3000000000',contextSlot:600})});engine.start();slotCallback({slot:600});await flush();engine.tick();await flush();assert.equal(engine.get(mint,current).worth,3);assert(!engine.get(mint,current).priceStale);
time+=600;slotCallback({slot:600});engine.tick();await flush();assert.equal(setupReads,2);assert.equal(engine.get(mint,current).marketWorth,5);assert(!engine.get(mint,current).marketStale);engine.stop();results.initialPriceRpcFailureRetriesAndDoesNotBlockTheIndependentFallback=true;
// Other positions waiting on a trade must not starve background chain-price setup.
curveData=null;poolData=pool();busy=true;quoteCalls=0;
engine=createLivePrices({connection:conn,book,now:()=>time,isTrading:()=>busy,readQuote:async()=>{quoteCalls++;return{outAmount:'1'};}});engine.start();slotCallback({slot:600});await flush();assert.equal(engine.get(mint,current).marketWorth,10);assert(!engine.get(mint,current).marketStale);assert.equal(quoteCalls,0);engine.stop();busy=false;results.priceSetupContinuesWhileAnotherTradeWaitsButQuoteTrafficYields=true;
// A temporary pool-discovery failure also recovers without waiting for the next quote turn.
curveData=curve(0n,0n,true);let poolReads=0;
const flakyPool={...conn,getAccountInfo:async()=>{if(++poolReads===1)throw Error('Temporary pool lookup error');return poolData;}};
engine=createLivePrices({connection:flakyPool,book,now:()=>time,readQuote:async()=>({outAmount:'3000000000',contextSlot:600})});engine.start();slotCallback({slot:600});await flush();engine.tick();await flush();assert.equal(poolReads,1);time+=1100;slotCallback({slot:600});engine.tick();await flush();assert.equal(poolReads,2);assert.equal(engine.get(mint,current).marketWorth,10);engine.stop();results.failedPoolDiscoveryRecoversIndependentlyOfQuoteScheduling=true;

// A live non-SOL curve must stream its raw price; its own stale USD listing is not the source.
curveData=curve(40_000_000_000n);new PublicKey(quotedMint).toBuffer().copy(curveData.data,83);poolData=null;
engine=createLivePrices({connection:conn,book,now:()=>time,readMarket:async ids=>Object.fromEntries(Object.entries(pricesFor(ids)).map(([m,p])=>[m,{...p,blockId:700}])),readQuote:async()=>({outAmount:'3000000000',contextSlot:700})});
engine.start();slotCallback({slot:700});await flush();engine.tick();await flush();assert.equal(engine.get(mint,current).marketWorth,1);assert.match(engine.get(mint,current).marketSource,/Pump curve stream/);assert(!engine.get(mint,current).marketStale);
const updatedForeign=curve(80_000_000_000n);new PublicKey(quotedMint).toBuffer().copy(updatedForeign.data,83);push(curveAddress(mint),updatedForeign,701);assert.equal(engine.get(mint,current).marketWorth,2);assert(!engine.get(mint,current).marketStale);
time+=6100;slotCallback({slot:702});assert(engine.get(mint,current).marketStale);engine.stop();results.nonSolCurvesStreamWithCorrectCurrencyAndExpireWhenConversionIsStale=true;
engine=createLivePrices({connection:conn,book,now:()=>time,readMarket:async()=>({}),readQuote:async()=>{throw Error('No route');}});engine.start();slotCallback({slot:710});await flush();engine.tick();await flush();assert.equal(engine.get(mint,current).marketWorth,null);assert(engine.get(mint,current).marketStale);engine.stop();results.nonSolCurvesCannotPretendTheirRawQuoteUnitsAreSol=true;

// The real HTTP helpers share the service quota and reserve capacity for foreground trades.
const {getMarketPrices,getQuote,backgroundPriceReady}=await import('../../src/jupiter.js');
const originalFetch=globalThis.fetch,originalNow=Date.now,originalBase=process.env.JUPITER_API_URL,originalKey=process.env.JUPITER_API_KEY;
let networkTime=1000000,networkCount=0,lastMarketUrl,limited=false;
try{
 Date.now=()=>networkTime;process.env.JUPITER_API_URL='http://127.0.0.1:9/swap/v1';delete process.env.JUPITER_API_KEY;
 globalThis.fetch=async url=>{networkCount++;lastMarketUrl=new URL(url);return limited?new Response('{}',{status:429,headers:{'retry-after':'7'}}):new Response(JSON.stringify({outAmount:'1000'}),{status:200});};
 assert(backgroundPriceReady());for(let i=0;i<24;i++)await getMarketPrices([mint,mint,WSOL]);
 assert.equal(lastMarketUrl.pathname,'/price/v3');assert.equal(lastMarketUrl.searchParams.get('ids'),mint+','+WSOL);assert(!backgroundPriceReady());
 await getQuote({inputMint:mint,outputMint:WSOL,amount:'1000',slippageBps:100});assert.equal(networkCount,25);
 networkTime+=61000;assert(backgroundPriceReady());results.backgroundPricesReserveQuotaButNeverQueueABuyOrSell=true;
 limited=true;let error;try{await getMarketPrices([mint]);}catch(e){error=e;}assert.equal(error.retryAfterMs,7000);assert(!backgroundPriceReady());networkTime+=7100;assert(backgroundPriceReady());
 results.http429RetryAfterAppliesToTheWholeBackgroundFeed=true;
}finally{
 globalThis.fetch=originalFetch;Date.now=originalNow;
 if(originalBase===undefined)delete process.env.JUPITER_API_URL;else process.env.JUPITER_API_URL=originalBase;
 if(originalKey===undefined)delete process.env.JUPITER_API_KEY;else process.env.JUPITER_API_KEY=originalKey;
}

console.log(JSON.stringify(results));
