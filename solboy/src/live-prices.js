import { PublicKey } from '@solana/web3.js';
import { WSOL } from './detect.js';

// Account layouts from pump-fun/pump-public-docs, idl/pump.json and idl/pump_amm.json.
export const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
// Meteora's official LbPair layout: active bin is a raw Y/X price, before fees
// and price impact. This is a market mark, never an executable sell quote.
export function decodeDlmmSol(info,mint){
  const d=info?.data;if(!info?.owner?.equals?.(DLMM)||!Buffer.isBuffer(d)||d.length<216||!d.subarray(0,8).equals(Buffer.from([33,11,49,98,181,101,177,13]))||d[82]!==0)return null;
  const x=new PublicKey(d.subarray(88,120)).toBase58(),y=new PublicKey(d.subarray(120,152)).toBase58(),step=d.readUInt16LE(80);
  if(!step||step>10000||!((x===mint&&y===WSOL)||(y===mint&&x===WSOL)))return null;
  const p=Math.pow(1+step/10000,d.readInt32LE(76)),ratio=x===mint?p:1/p;
  return Number.isFinite(ratio)&&ratio>0?ratio:null;
}
const CURVE_ID=Buffer.from([23,183,248,55,96,216,172,96]),POOL_ID=Buffer.from([241,154,109,4,17,177,109,188]);
const TOKEN_PROGRAMS=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
export const positionPriceKey=(mode,mint,pos)=>JSON.stringify([mode,mint,String(pos.tokens),pos.solSpent,pos.openedAt]);
export const curveAddress=mint=>PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'),new PublicKey(mint).toBuffer()],PUMP)[0];
export function canonicalPool(mint,quoteMint=WSOL){
  const base=new PublicKey(mint),creator=PublicKey.findProgramAddressSync([Buffer.from('pool-authority'),base.toBuffer()],PUMP)[0];
  return PublicKey.findProgramAddressSync([Buffer.from('pool'),Buffer.from([0,0]),creator.toBuffer(),base.toBuffer(),new PublicKey(quoteMint).toBuffer()],PUMP_AMM)[0];
}
function curveState(info){
  const d=info?.data;if(!info?.owner?.equals?.(PUMP)||!Buffer.isBuffer(d)||d.length<49||!d.subarray(0,8).equals(CURVE_ID))return null;
  const quote=d.length>=115?new PublicKey(d.subarray(83,115)):PublicKey.default;
  return {tokens:d.readBigUInt64LE(8),sol:d.readBigUInt64LE(16),complete:d[48]!==0,quoteMint:quote.equals(PublicKey.default)?WSOL:quote.toBase58()};
}
export function decodeCurve(info){
  const c=curveState(info);return c&&c.quoteMint===WSOL&&c.tokens>0n&&c.sol>0n?c:null;
}
export function decodePool(info,mint){
  const d=info?.data;if(!info?.owner?.equals?.(PUMP_AMM)||!Buffer.isBuffer(d)||d.length<211||!d.subarray(0,8).equals(POOL_ID))return null;
  if(new PublicKey(d.subarray(43,75)).toBase58()!==mint)return null;
  // Current PumpSwap retains fees in its vault and offsets them with a signed i128. Adding
  // the raw vault alone overstates price; nonzero virtual reserves are valid, including negatives.
  const virtual=d.length>=261?d.readBigUInt64LE(245)+(d.readBigInt64LE(253)<<64n):0n;
  return {base:new PublicKey(d.subarray(139,171)),quote:new PublicKey(d.subarray(171,203)),quoteMint:new PublicKey(d.subarray(75,107)).toBase58(),virtual};
}
function reserve(info,mint){
  const d=info?.data;if(!TOKEN_PROGRAMS.has(info?.owner?.toBase58?.())||!Buffer.isBuffer(d)||d.length<165||new PublicKey(d.subarray(0,32)).toBase58()!==mint)return null;
  return d.readBigUInt64LE(64);
}

/** Only open positions are watched. Bootstrap reads use the background RPC lane; swaps never wait for this. */
export function createLivePrices({connection,book,readQuote,readMarket,canRequest=()=>true,quotePriority=()=>0,isTrading=()=>false,onCurve=()=>{},now=Date.now,quoteGap=2100,quoteMaxAge=3000,heartbeatMaxAge=6000,marketMaxAge=6000,marketMaxSlotLag=20}){
  const entries=new Map(),listeners=new Set();let timer=null,broadcastTimer=null,heartbeatAt=0,slotSub=null,sequence=0,lastBroadcast=0,quoteTask=null,nextQuoteAt=0,streamEpoch=0,lost=false,latestSlot=0,marketDue=0,marketTask=null,marketCursor=0;
  const marketPrices=new Map(),conversionRoutes=new Map();
  const current=e=>entries.get(e.mint)===e&&book.mode===e.mode&&book.positions.has(e.mint)&&positionPriceKey(book.mode,e.mint,book.positions.get(e.mint))===e.key;
  const streamHealthy=()=>heartbeatAt>0&&now()-heartbeatAt<heartbeatMaxAge;
  function reference(mint){
    const p=marketPrices.get(mint);
    return p&&now()-p.at<=marketMaxAge&&latestSlot>0&&p.slot>=latestSlot-marketMaxSlotLag&&p.slot<=latestSlot+32?p:null;
  }
  function marketView(e){
    const stream=streamHealthy()&&!e.resyncNeeded&&(!e.seedAt||now()-e.seedAt<1000);
    let worth=e.market??null,at=e.marketAt,slot=e.marketSlot,source=e.marketSource,validUntil=0;
    if(stream&&worth!=null&&!e.poolPending&&!e.poolInvalid)validUntil=heartbeatAt+heartbeatMaxAge;
    if(e.quoteMint&&e.quoteMint!==WSOL){
      const q=reference(e.quoteMint),sol=reference(WSOL);
      const c=e.conversions?.get(e.quoteMint),live=stream&&c?.ratio&&c.epoch===streamEpoch;
      if(live&&e.marketRaw!=null){worth=e.marketRaw*c.ratio/1e9;at=Math.min(e.marketAt,c.at);slot=Math.min(e.marketSlot,c.slot);source=(e.marketVenue??'PumpSwap')+' + Meteora conversion · processed';validUntil=!e.poolPending&&!e.poolInvalid?heartbeatAt+heartbeatMaxAge:0;
      }else if(q&&sol&&e.marketRaw!=null){worth=e.marketRaw/10**q.decimals*q.usd/sol.usd;at=Math.min(e.marketAt,q.at,sol.at);slot=Math.min(e.marketSlot,q.slot,sol.slot);source=(e.marketVenue??'PumpSwap')+' stream · refreshed quote/SOL conversion';
        validUntil=stream&&!e.poolPending&&!e.poolInvalid?Math.min(heartbeatAt+heartbeatMaxAge,q.at+marketMaxAge,sol.at+marketMaxAge):0;
      }else validUntil=0;
    }
    // Unsupported venues still get one batched market reference instead of waiting behind
    // a separate executable quote for each position. Missing/old oracle data never becomes live.
    if(!validUntil&&readMarket){
      const p=reference(e.mint),sol=reference(WSOL);
      if(p&&sol){worth=Number(e.pos.tokens)/10**p.decimals*p.usd/sol.usd;at=Math.min(p.at,sol.at);slot=Math.min(p.slot,sol.slot);source='Jupiter market reference · refreshed';
        validUntil=streamHealthy()?Math.min(p.at+marketMaxAge,sol.at+marketMaxAge):0;
      }
    }
    return {worth,at:at??null,slot:slot??null,source:source??null,validUntil};
  }
  function view(e){
    const market=marketView(e),stream=streamHealthy()&&!e.resyncNeeded&&(!e.seedAt||now()-e.seedAt<1000),curveFresh=stream&&e.curve&&!e.curve.complete&&!e.pool;
    const quoteFresh=e.quote&&now()-e.quote.at<=quoteMaxAge&&(e.quote.slot?e.quote.slot>=latestSlot-8:e.quote.at>=(e.invalidatedAt??0));
    const curveWorth=curveFresh?Number(e.curve.sol*BigInt(e.pos.tokens)/(e.curve.tokens+BigInt(e.pos.tokens))*99n/100n)/1e9:null;
    const worth=curveFresh?curveWorth:e.quote?.worth??null,solUsd=reference(WSOL);
    return {mint:e.mint,key:e.key,priceSequence:sequence,worth,marketWorth:market.worth,priceAt:curveFresh?e.marketAt:e.quote?.at??null,
      marketAt:market.at,priceSource:curveFresh?'Pump curve estimate':e.quote?'Jupiter sell quote':'Waiting for price',
      marketSource:market.source,priceSlot:curveFresh?e.marketSlot:e.quote?.slot??null,marketSlot:market.slot,marketSlotLag:market.slot?Math.max(0,latestSlot-market.slot):null,priceStale:!(curveFresh||quoteFresh),marketStale:!market.validUntil,
      solUsd:solUsd?.usd??null,solUsdAt:solUsd?.at??null,solUsdValidUntil:solUsd?solUsd.at+marketMaxAge:0,
      priceIssue:e.quoteError??(!canRequest()?'Price refresh waiting for free capacity':null),marketIssue:e.marketError??(!canRequest()?'Price refresh waiting for free capacity':null),
      priceValidUntil:curveFresh?heartbeatAt+heartbeatMaxAge:quoteFresh?e.quote.at+quoteMaxAge:0,
      marketValidUntil:market.validUntil};
  }
  function broadcast(force=false){
    if(!force&&now()-lastBroadcast<1000)return;
    // A burst of swaps becomes at most 20 screen/exit updates per second, always using the newest state.
    if(force&&now()-lastBroadcast<50){if(!broadcastTimer){broadcastTimer=setTimeout(()=>{broadcastTimer=null;broadcast(true);},50-(now()-lastBroadcast));broadcastTimer.unref?.();}return;}
    lastBroadcast=now();const message={mode:book.mode,sequence:++sequence,prices:[...entries.values()].filter(current).map(view)};
    for(const fn of listeners)try{fn(message);}catch{}
  }
  function loseStream(){if(lost)return;lost=true;streamEpoch++;for(const e of entries.values()){e.resyncNeeded=true;e.bootstrapped=false;e.poolPending=true;for(const v of Object.values(e.vaults))v.dirty=false;}broadcast(true);}
  function heartbeat(ctx){latestSlot=Math.max(latestSlot,ctx?.slot??0);if(heartbeatAt&&now()-heartbeatAt>=heartbeatMaxAge)loseStream();heartbeatAt=now();lost=false;}
  function setCurve(e,info,slot,at=now()){
    if(!current(e)||slot<(e.curveSlot??0))return;
    e.curveVersion=(e.curveVersion??0)+1;
    const state=curveState(info);e.curveQuote=state?.quoteMint;if(state){e.curveSlot=slot;e.seedAt=null;}
    if(state?.complete){e.curve=null;e.foreignCurve=null;if(!e.pool){e.market=null;e.marketRaw=null;e.marketAt=null;}e.discoverAt=-Infinity;broadcast(true);void discover(e);return;}
    if(state&&!state.complete&&state.quoteMint!==WSOL&&state.tokens>0n&&state.sol>0n){
      // These are quote-token reserves, never SOL. Stream the coin immediately and
      // convert only with a checked quote-currency/SOL reference of the correct decimals.
      e.curve=null;e.foreignCurve=state;e.quoteMint=state.quoteMint;e.marketVenue='Pump curve';
      e.marketRaw=Number(state.sol)*Number(e.pos.tokens)/Number(state.tokens);e.market=null;
      e.marketAt=at;e.marketSlot=slot;e.marketSource='Pump curve · conversion pending';
      e.resyncNeeded=false;e.poolPending=false;e.poolInvalid=false;broadcast(true);return;
    }
    e.foreignCurve=null;
    const c=decodeCurve(info);if(!c){e.curve=null;e.market=null;e.invalidatedAt=at;broadcast(true);return;}
    e.seedAt=null;e.curveSlot=slot;e.curve=c;e.invalidatedAt=at;
    e.resyncNeeded=false;e.poolPending=false;e.poolInvalid=false;e.quoteMint=WSOL;e.marketRaw=null;e.marketVenue='Pump curve';e.market=Number(c.sol)*Number(e.pos.tokens)/Number(c.tokens)/1e9;e.marketAt=at;e.marketSlot=slot;e.marketSource='Pump curve · processed';
    onCurve(e.mint,{vSol:Number(c.sol)/1e9,vTokens:Number(c.tokens)/1e6});broadcast(true);
  }
  function subscribe(e,key,fn){
    try{const id=connection.onAccountChange(key,(info,ctx)=>{heartbeat(ctx);if(current(e))fn(info,ctx.slot);},'processed');e.accountSubs.push(id);}catch{}
  }
  function observeRoute(q){
    for(const r of q?.routePlan??[]){const s=r.swapInfo;if(s?.label!=='Meteora DLMM'||!s.ammKey)continue;
      const mint=s.inputMint===WSOL?s.outputMint:s.outputMint===WSOL?s.inputMint:null;
      if(mint&&mint!==WSOL){try{new PublicKey(s.ammKey);new PublicKey(mint);}catch{continue;}conversionRoutes.delete(mint);conversionRoutes.set(mint,s.ammKey);}
    }
    while(conversionRoutes.size>200)conversionRoutes.delete(conversionRoutes.keys().next().value);
    for(const e of entries.values())watchConversions(e);
  }
  function watchConversions(e){
    if(!e.quoteMint||e.quoteMint===WSOL)return;
    const mint=e.quoteMint,address=conversionRoutes.get(mint);if(!address)return;
    e.conversions??=new Map();let c=e.conversions.get(mint);
    if(!c){
      c={address,slot:0,epoch:-1};e.conversions.set(mint,c);
      subscribe(e,new PublicKey(address),(info,slot)=>apply(info,slot));
    }
    function apply(info,slot){
      if(!current(e)||slot<c.slot)return;
      c.ratio=decodeDlmmSol(info,mint);c.slot=slot;c.at=now();c.epoch=streamEpoch;broadcast(true);
    }
    if(c.epoch!==streamEpoch&&!c.reading&&now()>=(c.retryAt??0)){
      c.reading=true;const epoch=streamEpoch;
      void connection.getAccountInfoAndContext(new PublicKey(c.address),{commitment:'processed'}).then(data=>{if(epoch===streamEpoch)apply(data.value,data.context.slot);}).catch(()=>{}).finally(()=>{c.reading=false;c.retryAt=now()+1000;});
    }
  }
  async function discover(e){
    if(!current(e)||e.discovering||e.pool||now()-(e.discoverAt??-Infinity)<60_000||!streamHealthy())return;
    e.discovering=true;e.discoverAt=now();const epoch=streamEpoch;
    try{
      const pool=canonicalPool(e.mint,e.curveQuote??WSOL),info=await connection.getAccountInfo(pool,'processed');
      if(!current(e)||epoch!==streamEpoch||!streamHealthy())return;const parsed=decodePool(info,e.mint);if(parsed)await watchPool(e,pool,parsed);
    }catch{e.discoverAt=now()-59000;}finally{e.discovering=false;}
  }
  async function watchPool(e,pool,parsed){
    if(!current(e)||e.pool)return;e.pool=pool.toBase58();e.quoteMint=parsed.quoteMint;e.marketVenue='PumpSwap';e.poolState={...parsed,slot:-1,dirty:false};
    const combine=()=>{
      const a=e.vaults.base,b=e.vaults.quote,p=e.poolState;
      if(a?.dirty&&b?.dirty&&p?.dirty&&a.slot===b.slot&&b.slot===p.slot&&a.n>0n&&b.n+p.virtual>0n&&!e.poolInvalid){
        a.dirty=false;b.dirty=false;p.dirty=false;e.poolPending=false;e.poolPendingAt=null;e.resyncNeeded=false;
        e.marketRaw=Number(b.n+p.virtual)*Number(e.pos.tokens)/Number(a.n);
        e.market=e.quoteMint===WSOL?e.marketRaw/1e9:null;e.marketAt=now();e.marketSlot=a.slot;e.marketSource='PumpSwap reserves · processed';
      }broadcast(true);
    };
    const pending=()=>{e.poolGeneration=(e.poolGeneration??0)+1;e.poolPendingAt??=now();e.invalidatedAt=now();e.poolPending=true;};
    const state=(info,slot)=>{
      if(slot<(e.poolState?.slot??0))return;
      pending();const p=decodePool(info,e.mint);e.poolInvalid=!p||!p.base.equals(parsed.base)||!p.quote.equals(parsed.quote)||p.quoteMint!==parsed.quoteMint;
      if(e.poolInvalid){e.market=null;e.marketRaw=null;}else e.poolState={...p,slot,dirty:true};combine();
    };
    const apply=(side,info,slot)=>{
      const n=reserve(info,side==='base'?e.mint:parsed.quoteMint);if(!current(e)||slot<(e.vaults[side]?.slot??0))return;
      pending();if(n==null){e.vaults[side]={slot,dirty:false};broadcast(true);return;}
      e.vaults[side]={n,slot,dirty:true};combine();
    };
    subscribe(e,pool,state);subscribe(e,parsed.base,(i,s)=>apply('base',i,s));subscribe(e,parsed.quote,(i,s)=>apply('quote',i,s));
    e.readPool=async()=>{if(e.readingPool)return;e.readingPool=true;e.lastPoolRead=now();const epoch=streamEpoch,generation=e.poolGeneration??0;try{
      const data=await connection.getMultipleAccountsInfoAndContext([parsed.base,parsed.quote,pool],{commitment:'processed'});
      if(current(e)&&epoch===streamEpoch&&generation===(e.poolGeneration??0)){state(data.value[2],data.context.slot);apply('base',data.value[0],data.context.slot);apply('quote',data.value[1],data.context.slot);}
    }catch{}finally{e.readingPool=false;}};await e.readPool();
  }
  async function bootstrap(e){
    e.bootstrapping=true;let completed=false;const epoch=streamEpoch,started=now(),version=e.curveVersion??0;
    try{
      const data=await connection.getAccountInfoAndContext(curveAddress(e.mint),{commitment:'processed'});completed=true;
      if(current(e)&&epoch===streamEpoch){if(version===(e.curveVersion??0))setCurve(e,data.value,data.context.slot,started);if(e.pool&&e.resyncNeeded)await e.readPool?.();}
    }catch{}finally{e.bootstrapping=false;e.bootstrapAttempted=true;e.bootstrapped=completed&&epoch===streamEpoch;e.bootstrapRetryAt=completed?0:now()+Math.min(500*2**Math.min(e.bootstrapFailures??0,4),5000);e.bootstrapFailures=completed?0:(e.bootstrapFailures??0)+1;}
    if(current(e)&&e.bootstrapped&&!e.curve&&!e.foreignCurve)void discover(e);
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
    if(changed){const keep=new Set([WSOL,...[...entries.values()].flatMap(e=>[e.mint,e.quoteMint])]);for(const mint of marketPrices.keys())if(!keep.has(mint))marketPrices.delete(mint);broadcast(true);}
  }
  async function quoteOne(e){
    const started=now();nextQuoteAt=started+quoteGap;e.quoteDue=started+quoteGap;
    try{
      const q=await readQuote(e.mint,e.pos.tokens,AbortSignal.timeout(4000));
      if(!current(e))return;
      observeRoute(q);
      const worth=Number(q.outAmount)/1e9;if(!Number.isFinite(worth)||worth<0)throw Error('Invalid price');
      // Quote age starts when requested, not when received. Use its chain slot to assess
      // recency; normal swap activity alone does not mean the quote service disconnected.
      const slot=Number(q.contextSlot)||null;
      if(slot&&(!Number.isSafeInteger(slot)||slot<0||(latestSlot>0&&slot>latestSlot+32)))throw Error('Invalid quote slot');
      if(slot&&e.quote?.slot&&slot<e.quote.slot)throw Error('Older quote ignored');
      e.quote={worth,at:started,slot};e.quoteError=null;
      // Route activity requests the next allowed refresh without flooding the free endpoint.
      if(!e.routesWatched){e.routesWatched=true;
        for(const route of (q.routePlan??[]).slice(0,3)){const key=route.swapInfo?.ammKey;if(!key)continue;
          try{const id=connection.onLogs(new PublicKey(key),(logs,ctx)=>{if(current(e)&&!logs.err){latestSlot=Math.max(latestSlot,ctx?.slot??0);e.invalidatedAt=now();e.quoteDue=Math.min(e.quoteDue,now());broadcast(true);}},'processed');e.logSubs.push(id);}catch{}}
      }
      broadcast(true);
    }catch(error){if(current(e)){e.quoteError=error.retryAfterMs?'Price service rate limited':'Sell quote unavailable';e.quoteDue=now()+Math.max(quoteGap,error.retryAfterMs??0);nextQuoteAt=Math.max(nextQuoteAt,e.quoteDue);broadcast(true);}}
  }
  async function refreshMarket(){
    const started=now(),all=[...entries.values()].filter(e=>current(e)&&(!e.curve||e.curve.complete)),targets=[],requested=new Set([WSOL]);
    // Keep a coin and its conversion together. Larger portfolios rotate through bounded batches,
    // so the provider's 50-ID limit never permanently excludes coins at the end of the list.
    const start=marketCursor%Math.max(1,all.length);
    for(let i=0;i<all.length;i++){
      const e=all[(start+i)%all.length],add=[e.mint,e.quoteMint].filter(m=>m&&!requested.has(m));
      if(requested.size+new Set(add).size>50)break;
      targets.push(e);for(const m of add)requested.add(m);
    }
    marketCursor=(start+targets.length)%Math.max(1,all.length);const ids=[...requested];
    nextQuoteAt=started+quoteGap;marketDue=started+quoteGap*2;
    try{
      const data=await readMarket(ids,AbortSignal.timeout(4000));
      for(const mint of ids){
        const p=data?.[mint],previous=marketPrices.get(mint);
        if(!p||!(p.usdPrice>0)||!Number.isFinite(p.usdPrice)||!Number.isInteger(p.decimals)||p.decimals<0||p.decimals>18||!Number.isSafeInteger(p.blockId)||p.blockId<=0||p.blockId<(previous?.slot??0))continue;
        marketPrices.set(mint,{usd:p.usdPrice,decimals:p.decimals,slot:p.blockId,at:started});
      }
      for(const e of targets)if(current(e))e.marketError=data?.[e.mint]?null:'No reliable market reference';
      broadcast(true);
    }catch(error){
      marketDue=now()+Math.max(quoteGap*2,error.retryAfterMs??0);nextQuoteAt=Math.max(nextQuoteAt,now()+(error.retryAfterMs??0));
      for(const e of targets)if(current(e))e.marketError=error.retryAfterMs?'Price service rate limited':'Market refresh unavailable';broadcast(true);
    }
  }
  function tick(){
    if(heartbeatAt&&!streamHealthy())loseStream();
    sync();broadcast();
    // Background RPC reads already yield in the RPC limiter. A different trade waiting
    // for confirmation must not leave a newly opened position without its price feed.
    for(const e of entries.values())if(streamHealthy()&&!e.bootstrapped&&!e.bootstrapping&&now()>=(e.bootstrapRetryAt??0))void bootstrap(e);
    for(const e of entries.values())if(e.poolPending&&e.readPool&&now()-(e.poolPendingAt??now())>=250&&now()-(e.lastPoolRead??0)>=2100)void e.readPool();
    for(const e of entries.values())if(e.bootstrapped&&!e.bootstrapping&&!e.curve&&!e.foreignCurve&&!e.pool)void discover(e);
    for(const e of entries.values())watchConversions(e);
    if(isTrading()||quoteTask||marketTask||now()<nextQuoteAt||!canRequest())return;
    if(readMarket&&now()>=marketDue&&[...entries.values()].some(e=>(e.bootstrapped||e.bootstrapAttempted)&&!e.curve&&(!e.pool||e.quoteMint!==WSOL))){
      marketTask=refreshMarket().finally(()=>{marketTask=null;});return;
    }
    const e=[...entries.values()].filter(e=>(e.bootstrapped||e.bootstrapAttempted)&&!(e.curve&&!e.curve.complete&&streamHealthy())&&now()>=e.quoteDue).sort((a,b)=>(quotePriority(b.pos,marketView(b).worth??NaN)-quotePriority(a.pos,marketView(a).worth??NaN))||a.quoteDue-b.quoteDue)[0];
    if(e)quoteTask=quoteOne(e).finally(()=>{quoteTask=null;});
  }
  return {
    start(){if(timer)return;timer=setInterval(tick,200);timer.unref?.();tick();},
    stop(){if(timer)clearInterval(timer);if(broadcastTimer)clearTimeout(broadcastTimer);timer=null;broadcastTimer=null;for(const e of entries.values())cleanup(e);entries.clear();marketPrices.clear();if(slotSub!=null)Promise.resolve(connection.removeSlotChangeListener(slotSub)).catch(()=>{});},
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
    observeRoute,sync,tick,get(mint,pos){const e=entries.get(mint);return e&&current(e)&&e.key===positionPriceKey(book.mode,mint,pos)?view(e):null;},
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  };
}
