import { PublicKey } from '@solana/web3.js';
import { WSOL } from './detect.js';

// Account layouts from pump-fun/pump-public-docs, idl/pump.json and idl/pump_amm.json.
export const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const CURVE_ID=Buffer.from([23,183,248,55,96,216,172,96]),POOL_ID=Buffer.from([241,154,109,4,17,177,109,188]);
const TOKEN_PROGRAMS=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
export const positionPriceKey=(mode,mint,pos)=>JSON.stringify([mode,mint,String(pos.tokens),pos.solSpent,pos.openedAt]);
export const curveAddress=mint=>PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'),new PublicKey(mint).toBuffer()],PUMP)[0];
export function canonicalPool(mint){
  const base=new PublicKey(mint),creator=PublicKey.findProgramAddressSync([Buffer.from('pool-authority'),base.toBuffer()],PUMP)[0];
  return PublicKey.findProgramAddressSync([Buffer.from('pool'),Buffer.from([0,0]),creator.toBuffer(),base.toBuffer(),new PublicKey(WSOL).toBuffer()],PUMP_AMM)[0];
}
export function decodeCurve(info){
  const d=info?.data;if(!info?.owner?.equals?.(PUMP)||!Buffer.isBuffer(d)||d.length<49||!d.subarray(0,8).equals(CURVE_ID))return null;
  // Non-SOL quote curves need a currency conversion; never display their quote reserves as SOL.
  if(d.length>=115){const quote=new PublicKey(d.subarray(83,115));if(!quote.equals(PublicKey.default)&&quote.toBase58()!==WSOL)return null;}
  const tokens=d.readBigUInt64LE(8),sol=d.readBigUInt64LE(16);
  return tokens>0n&&sol>0n?{tokens,sol,complete:d[48]!==0}:null;
}
export function decodePool(info,mint){
  const d=info?.data;if(!info?.owner?.equals?.(PUMP_AMM)||!Buffer.isBuffer(d)||d.length<211||!d.subarray(0,8).equals(POOL_ID))return null;
  if(new PublicKey(d.subarray(43,75)).toBase58()!==mint||new PublicKey(d.subarray(75,107)).toBase58()!==WSOL)return null;
  // Boost pools use additional virtual quote reserves; do not apply ordinary-pool maths to them.
  if(d.length>=261&&d.subarray(245,261).some(b=>b!==0))return null;
  return {base:new PublicKey(d.subarray(139,171)),quote:new PublicKey(d.subarray(171,203))};
}
function reserve(info,mint){
  const d=info?.data;if(!TOKEN_PROGRAMS.has(info?.owner?.toBase58?.())||!Buffer.isBuffer(d)||d.length<165||new PublicKey(d.subarray(0,32)).toBase58()!==mint)return null;
  return d.readBigUInt64LE(64);
}

/** Only open positions are watched. Bootstrap reads use the background RPC lane; swaps never wait for this. */
export function createLivePrices({connection,book,readQuote,isTrading=()=>false,onCurve=()=>{},now=Date.now,quoteGap=2100,quoteMaxAge=3000,heartbeatMaxAge=6000}){
  const entries=new Map(),listeners=new Set();let timer=null,broadcastTimer=null,heartbeatAt=0,slotSub=null,sequence=0,lastBroadcast=0,quoteTask=null,nextQuoteAt=0,streamEpoch=0,lost=false;
  const current=e=>entries.get(e.mint)===e&&book.mode===e.mode&&book.positions.has(e.mint)&&positionPriceKey(book.mode,e.mint,book.positions.get(e.mint))===e.key;
  const streamHealthy=()=>heartbeatAt>0&&now()-heartbeatAt<heartbeatMaxAge;
  function view(e){
    const stream=streamHealthy()&&!e.resyncNeeded&&(!e.seedAt||now()-e.seedAt<1000),marketFresh=stream&&e.market!=null&&!e.poolPending&&!e.poolInvalid,curveFresh=stream&&e.curve&&!e.curve.complete&&!e.pool;
    const quoteFresh=e.quote&&now()-e.quote.at<=quoteMaxAge&&e.quote.at>=(e.invalidatedAt??0);
    // Pump curve return keeps the existing ~1% model. It is an estimate, not an executable fill promise.
    const curveWorth=curveFresh?Number(e.curve.sol*BigInt(e.pos.tokens)/(e.curve.tokens+BigInt(e.pos.tokens))*99n/100n)/1e9:null;
    const worth=curveFresh?curveWorth:e.quote?.worth??null;
    return {mint:e.mint,key:e.key,priceSequence:sequence,worth,marketWorth:e.market??null,priceAt:curveFresh?e.marketAt:e.quote?.at??null,
      marketAt:e.marketAt??null,priceSource:curveFresh?'Pump curve estimate':e.quote?'Jupiter sell quote':'Waiting for price',
      marketSource:e.marketSource??null,priceSlot:e.marketSlot??null,priceStale:!(curveFresh||quoteFresh),marketStale:!marketFresh,
      priceValidUntil:curveFresh?heartbeatAt+heartbeatMaxAge:quoteFresh?e.quote.at+quoteMaxAge:0,
      marketValidUntil:marketFresh?heartbeatAt+heartbeatMaxAge:0};
  }
  function broadcast(force=false){
    if(!force&&now()-lastBroadcast<1000)return;
    // A burst of swaps becomes at most 20 screen/exit updates per second, always using the newest state.
    if(force&&now()-lastBroadcast<50){if(!broadcastTimer){broadcastTimer=setTimeout(()=>{broadcastTimer=null;broadcast(true);},50-(now()-lastBroadcast));broadcastTimer.unref?.();}return;}
    lastBroadcast=now();const message={mode:book.mode,sequence:++sequence,prices:[...entries.values()].filter(current).map(view)};
    for(const fn of listeners)try{fn(message);}catch{}
  }
  function loseStream(){if(lost)return;lost=true;streamEpoch++;for(const e of entries.values()){e.resyncNeeded=true;e.bootstrapped=false;e.poolPending=true;for(const v of Object.values(e.vaults))v.dirty=false;}broadcast(true);}
  function heartbeat(){if(heartbeatAt&&now()-heartbeatAt>=heartbeatMaxAge)loseStream();heartbeatAt=now();lost=false;}
  function setCurve(e,info,slot,at=now()){
    if(!current(e)||slot<(e.curveSlot??0))return;
    e.curveVersion=(e.curveVersion??0)+1;
    const c=decodeCurve(info);if(!c){e.curve=null;e.market=null;e.invalidatedAt=at;broadcast(true);return;}
    e.seedAt=null;e.curveSlot=slot;e.curve=c;e.invalidatedAt=at;
    if(c.complete){if(!e.pool){e.market=null;e.marketAt=null;}e.discoverAt=0;broadcast(true);void discover(e);return;}
    e.resyncNeeded=false;e.market=Number(c.sol)*Number(e.pos.tokens)/Number(c.tokens)/1e9;e.marketAt=at;e.marketSlot=slot;e.marketSource='Pump curve · processed';
    onCurve(e.mint,{vSol:Number(c.sol)/1e9,vTokens:Number(c.tokens)/1e6});broadcast(true);
  }
  function subscribe(e,key,fn){
    try{const id=connection.onAccountChange(key,(info,ctx)=>{heartbeat();if(current(e))fn(info,ctx.slot);},'processed');e.accountSubs.push(id);}catch{}
  }
  async function discover(e){
    if(!current(e)||e.discovering||e.pool||now()-(e.discoverAt??-Infinity)<60_000||isTrading()||!streamHealthy())return;
    e.discovering=true;e.discoverAt=now();const epoch=streamEpoch;
    try{
      const pool=canonicalPool(e.mint),info=await connection.getAccountInfo(pool,'processed');
      if(!current(e)||epoch!==streamEpoch||!streamHealthy())return;const parsed=decodePool(info,e.mint);if(parsed)await watchPool(e,pool,parsed);
    }catch{}finally{e.discovering=false;}
  }
  async function watchPool(e,pool,parsed){
    if(!current(e)||e.pool)return;e.pool=pool.toBase58();
    subscribe(e,pool,(info)=>{e.poolGeneration=(e.poolGeneration??0)+1;const p=decodePool(info,e.mint);e.poolInvalid=!p||!p.base.equals(parsed.base)||!p.quote.equals(parsed.quote);if(e.poolInvalid){e.market=null;e.invalidatedAt=now();}broadcast(true);});
    const apply=(side,info,slot)=>{
      const n=reserve(info,side==='base'?e.mint:WSOL);if(n==null||!current(e)||slot<(e.vaults[side]?.slot??0))return;
      e.poolGeneration=(e.poolGeneration??0)+1;
      e.vaults[side]={n,slot,dirty:true};e.poolPendingAt??=now();e.invalidatedAt=now();e.poolPending=true;
      const a=e.vaults.base,b=e.vaults.quote;
      // Never combine reserves from different slots into a made-up intermediate price.
      if(a?.dirty&&b?.dirty&&a.slot===b.slot&&a.n>0n&&b.n>0n){a.dirty=false;b.dirty=false;e.poolPending=false;e.poolPendingAt=null;e.resyncNeeded=false;e.market=Number(b.n)*Number(e.pos.tokens)/Number(a.n)/1e9;e.marketAt=now();e.marketSlot=slot;e.marketSource='PumpSwap reserves · processed';}broadcast(true);
    };
    subscribe(e,parsed.base,(i,s)=>apply('base',i,s));subscribe(e,parsed.quote,(i,s)=>apply('quote',i,s));
    e.readPool=async()=>{if(e.readingPool)return;e.readingPool=true;e.lastPoolRead=now();const epoch=streamEpoch,generation=e.poolGeneration??0;try{
      const data=await connection.getMultipleAccountsInfoAndContext([parsed.base,parsed.quote],{commitment:'processed'});
      if(current(e)&&epoch===streamEpoch&&generation===(e.poolGeneration??0)){apply('base',data.value[0],data.context.slot);apply('quote',data.value[1],data.context.slot);}
    }catch{}finally{e.readingPool=false;}};await e.readPool();
  }
  async function bootstrap(e){
    e.bootstrapping=true;const epoch=streamEpoch,started=now(),version=e.curveVersion??0;
    try{
      const data=await connection.getAccountInfoAndContext(curveAddress(e.mint),{commitment:'processed'});
      if(current(e)&&epoch===streamEpoch){if(version===(e.curveVersion??0))setCurve(e,data.value,data.context.slot,started);if(e.pool&&e.resyncNeeded)await e.readPool?.();}
    }catch{}finally{e.bootstrapping=false;e.bootstrapped=epoch===streamEpoch;}
    if(current(e)&&!e.curve)void discover(e);
  }
  function cleanup(e){
    for(const id of e.accountSubs)Promise.resolve(connection.removeAccountChangeListener(id)).catch(()=>{});
    for(const id of e.logSubs)Promise.resolve(connection.removeOnLogsListener(id)).catch(()=>{});
  }
  function sync(){
    const active=new Map(book.positions.entries().map(([mint,pos])=>[mint,{pos,key:positionPriceKey(book.mode,mint,pos)}]));
    let changed=false;
    for(const [mint,e]of entries)if(active.get(mint)?.key!==e.key){cleanup(e);entries.delete(mint);changed=true;}
    for(const [mint,{pos,key}]of active)if(!entries.has(mint)){
      try{if(BigInt(pos.tokens??0)<=0n)continue;}catch{continue;}
      const e={mint,pos:{...pos},key,mode:book.mode,createdAt:now(),accountSubs:[],logSubs:[],vaults:{},quoteDue:0};entries.set(mint,e);changed=true;
      subscribe(e,curveAddress(mint),(info,slot)=>setCurve(e,info,slot));
    }
    if(entries.size&&slotSub==null){heartbeatAt=now();lost=false;try{slotSub=connection.onSlotChange(heartbeat);}catch{}}
    if(!entries.size&&slotSub!=null){Promise.resolve(connection.removeSlotChangeListener(slotSub)).catch(()=>{});slotSub=null;heartbeatAt=0;}
    if(changed)broadcast(true);
  }
  async function quoteOne(e){
    const started=now();nextQuoteAt=started+quoteGap;e.quoteDue=started+quoteGap;
    try{
      const q=await readQuote(e.mint,e.pos.tokens,AbortSignal.timeout(4000));
      if(!current(e))return;
      const worth=Number(q.outAmount)/1e9;if(!Number.isFinite(worth)||worth<0)throw Error('Invalid price');
      // Keep the newest completed quote visible even in an active pool. Its request timestamp and
      // invalidation still mark it delayed for auto-exits; busy trading must not starve the display.
      e.quote={worth,at:started};
      // A routed venue can invalidate its old quote on the next swap without downloading that transaction.
      if(!e.routesWatched){e.routesWatched=true;
        for(const route of (q.routePlan??[]).slice(0,3)){const key=route.swapInfo?.ammKey;if(!key)continue;
          try{const id=connection.onLogs(new PublicKey(key),logs=>{if(current(e)&&!logs.err){e.invalidatedAt=now();broadcast(true);}},'processed');e.logSubs.push(id);}catch{}}
      }
      broadcast(true);
    }catch{if(current(e)){e.quoteDue=now()+quoteGap;broadcast(true);}}
  }
  function tick(){
    if(heartbeatAt&&!streamHealthy())loseStream();
    sync();broadcast();
    if(isTrading())return;
    for(const e of entries.values())if(streamHealthy()&&!e.bootstrapped&&!e.bootstrapping)void bootstrap(e);
    for(const e of entries.values())if(e.poolPending&&e.readPool&&now()-(e.poolPendingAt??now())>=250&&now()-(e.lastPoolRead??0)>=2100)void e.readPool();
    if(quoteTask||now()<nextQuoteAt)return;
    const e=[...entries.values()].filter(e=>e.bootstrapped&&!(e.curve&&!e.curve.complete&&streamHealthy())&&now()>=e.quoteDue).sort((a,b)=>a.quoteDue-b.quoteDue)[0];
    if(e)quoteTask=quoteOne(e).finally(()=>{quoteTask=null;});
    for(const e of entries.values())if(!e.curve&&!e.pool)void discover(e);
  }
  return {
    start(){if(timer)return;timer=setInterval(tick,200);timer.unref?.();tick();},
    stop(){if(timer)clearInterval(timer);if(broadcastTimer)clearTimeout(broadcastTimer);timer=null;broadcastTimer=null;for(const e of entries.values())cleanup(e);entries.clear();if(slotSub!=null)Promise.resolve(connection.removeSlotChangeListener(slotSub)).catch(()=>{});},
    seedCurve(mint,curve,slot,observedAt=now()){
      if(now()-observedAt>=1000)return;
      sync();const e=entries.get(mint);if(!e||!current(e))return;
      // The copy notification already contains the post-trade reserves; don't show a blank price
      // while a free-plan background read waits for its turn. The normal subscription takes over.
      e.curve={sol:BigInt(Math.round(curve.vSol*1e9)),tokens:BigInt(Math.round(curve.vTokens*1e6)),complete:false};
      e.seedAt=observedAt;e.curveVersion=(e.curveVersion??0)+1;e.curveSlot=slot??0;
      e.market=curve.vSol*Number(e.pos.tokens)/1e6/curve.vTokens;e.marketAt=observedAt;e.marketSlot=slot??null;e.marketSource='Pump curve · trade event';
      broadcast(true);
    },
    sync,tick,get(mint,pos){const e=entries.get(mint);return e&&current(e)&&e.key===positionPriceKey(book.mode,mint,pos)?view(e):null;},
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  };
}
