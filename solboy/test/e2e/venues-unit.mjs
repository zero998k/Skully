// Live market marks for coins that left Pump.fun: Raydium AMM v4, Raydium CPMM and Meteora DLMM.
// Pool layouts match accounts read from mainnet; every account here is synthetic.
import assert from 'node:assert/strict';
import {PublicKey,Keypair} from '@solana/web3.js';
import {createLivePrices,decodeRaydiumAmm,decodeRaydiumCpmm,decodeDlmmSol,RAY_AMM,RAY_CPMM,DLMM} from '../../src/live-prices.js';
import {WSOL} from '../../src/detect.js';
const results={},key=()=>Keypair.generate().publicKey;
const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const vault=(m,n)=>{const data=Buffer.alloc(165);new PublicKey(m).toBuffer().copy(data);data.writeBigUInt64LE(n,64);return{owner:TOKEN,data};};
function amm(mint,coinVault,solVault,{coinHeld=0n,solHeld=0n,coinIsBase=true}={}){
 const d=Buffer.alloc(752);d.writeBigUInt64LE(coinIsBase?coinHeld:solHeld,192);d.writeBigUInt64LE(coinIsBase?solHeld:coinHeld,200);
 (coinIsBase?coinVault:solVault).toBuffer().copy(d,336);(coinIsBase?solVault:coinVault).toBuffer().copy(d,368);
 new PublicKey(coinIsBase?mint:WSOL).toBuffer().copy(d,400);new PublicKey(coinIsBase?WSOL:mint).toBuffer().copy(d,432);return{owner:RAY_AMM,data:d};
}
function cpmm(mint,coinVault,solVault,{fees=[0n,0n,0n,0n]}={}){
 const d=Buffer.alloc(637);solVault.toBuffer().copy(d,72);coinVault.toBuffer().copy(d,104);new PublicKey(WSOL).toBuffer().copy(d,168);new PublicKey(mint).toBuffer().copy(d,200);
 [341,349,357,365].forEach((o,i)=>d.writeBigUInt64LE(fees[i],o));return{owner:RAY_CPMM,data:d};
}
function dlmm(mint,activeId,binStep=100){
 const d=Buffer.alloc(904);Buffer.from([33,11,49,98,181,101,177,13]).copy(d);d.writeInt32LE(activeId,76);d.writeUInt16LE(binStep,80);d[82]=0;
 new PublicKey(mint).toBuffer().copy(d,88);new PublicKey(WSOL).toBuffer().copy(d,120);return{owner:DLMM,data:d};
}
// Decoders: owner, mints and pending/fee amounts are all checked.
{
 const mint=key().toBase58(),cv=key(),sv=key();
 const a=decodeRaydiumAmm(amm(mint,cv,sv,{coinHeld:5n,solHeld:7n}),mint);assert(a.coinVault.equals(cv)&&a.solVault.equals(sv));assert.equal(a.coinHeld,5n);assert.equal(a.solHeld,7n);
 const flipped=decodeRaydiumAmm(amm(mint,cv,sv,{coinHeld:5n,solHeld:7n,coinIsBase:false}),mint);assert(flipped.coinVault.equals(cv)&&flipped.solVault.equals(sv));assert.equal(flipped.coinHeld,5n);
 assert.equal(decodeRaydiumAmm(amm(mint,cv,sv),key().toBase58()),null);assert.equal(decodeRaydiumAmm({...amm(mint,cv,sv),owner:RAY_CPMM},mint),null);
 const c=decodeRaydiumCpmm(cpmm(mint,cv,sv,{fees:[1n,2n,3n,4n]}),mint);assert(c.coinVault.equals(cv)&&c.solVault.equals(sv));assert.equal(c.solHeld,4n);assert.equal(c.coinHeld,6n);
 assert.equal(decodeRaydiumCpmm(cpmm(mint,cv,sv),key().toBase58()),null);
 assert(Math.abs(decodeDlmmSol(dlmm(mint,0),mint)-1)<1e-12);
 results.poolLayoutsCheckOwnerMintsAndHeldAmounts=true;
}
// Engine harness: a coin with no Pump curve whose sell route is a single pool.
function harness({mint,ammKey,accounts,readMarket}){
 let time=10000,slotCallback;const subs=new Map(),current={tokens:'1000000',solSpent:.001,openedAt:'2026-01-01T00:00:00Z'};
 const book={mode:'paper',positions:{entries:()=>[[mint,current]],has:m=>m===mint,get:()=>current}};
 const info=k=>accounts.get(k.toBase58())??null;
 const conn={onAccountChange:(k,fn)=>{const id=subs.size+1;subs.set(id,{key:k.toBase58(),fn});return id;},removeAccountChangeListener:async()=>{},
  onSlotChange:fn=>{slotCallback=fn;return 1;},removeSlotChangeListener:async()=>{},onLogs:()=>2,removeOnLogsListener:async()=>{},
  getAccountInfoAndContext:async k=>({context:{slot:40},value:info(k)}),getAccountInfo:async k=>info(k),
  getMultipleAccountsInfoAndContext:async keys=>({context:{slot:50},value:keys.map(info)})};
 const engine=createLivePrices({connection:conn,book,now:()=>time,readMarket,quoteGap:100,
  readQuote:async()=>({outAmount:'1000000',routePlan:[{swapInfo:{ammKey,inputMint:mint,outputMint:WSOL}}]})});
 const push=(k,i,slot)=>{for(const s of subs.values())if(s.key===k.toBase58())s.fn(i,{slot});};
 const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();await new Promise(r=>setTimeout(r,5));};
 const advance=async(ms=150)=>{time+=ms;slotCallback?.({slot:60});engine.tick();await flush();};
 return {engine,current,push,flush,advance,get:()=>engine.get(mint,current)};
}
for(const kind of ['amm','cpmm']){
 const mint=key().toBase58(),ammKey=key(),cv=key(),sv=key(),accounts=new Map();let marketCalls=0;
 const pool=kind==='amm'?amm(mint,cv,sv,{coinHeld:1_000_000n,solHeld:2_000_000n}):cpmm(mint,cv,sv,{fees:[1_000_000n,500_000n,1_000_000n,500_000n]});
 accounts.set(ammKey.toBase58(),pool);accounts.set(cv.toBase58(),vault(mint,101_000_000n));accounts.set(sv.toBase58(),vault(WSOL,202_000_000n));
 const h=harness({mint,ammKey:ammKey.toBase58(),accounts,readMarket:async()=>{marketCalls++;return{};}});
 h.engine.start();await h.flush();for(let i=0;i<8&&h.get()?.marketWorth==null;i++)await h.advance();
 // 100M coin units and 200M lamports tradable (held amounts removed): 1,000,000 units are worth 0.002 SOL.
 let p=h.get();assert(Math.abs(p.marketWorth-0.002)<1e-12,`${kind} initial ${p.marketWorth}`);assert(/Raydium/.test(p.marketSource));assert.equal(p.marketStale,false);
 const callsWhenLive=marketCalls;
 h.push(cv,vault(mint,51_000_000n),61);h.push(sv,vault(WSOL,402_000_000n),61);p=h.get();
 assert(Math.abs(p.marketWorth-0.008)<1e-12,`${kind} tick ${p.marketWorth}`);
 h.push(cv,vault(mint,26_000_000n),62);assert(Math.abs(h.get().marketWorth-0.008)<1e-12,'half update must wait for the other vault');
 h.push(sv,vault(WSOL,1_000_000n),55);h.push(cv,vault(mint,1_000_000n),55);assert(Math.abs(h.get().marketWorth-0.008)<1e-12,'older slots cannot rewind');
 for(let i=0;i<10;i++)await h.advance(300);assert.equal(marketCalls,callsWhenLive,'a streamed coin needs no market-reference requests');
 h.engine.stop();
}
results.raydiumPoolsStreamLiveWithoutHalfUpdates=true;results.streamedCoinsUseNoExtraPriceRequests=true;
{
 const mint=key().toBase58(),ammKey=key(),accounts=new Map([[ammKey.toBase58(),dlmm(mint,0)]]);
 const h=harness({mint,ammKey:ammKey.toBase58(),accounts});h.engine.start();await h.flush();for(let i=0;i<8&&h.get()?.marketWorth==null;i++)await h.advance();
 let p=h.get();assert(Math.abs(p.marketWorth-0.001)<1e-12,`dlmm ${p.marketWorth}`);assert(/Meteora DLMM/.test(p.marketSource));
 h.push(ammKey,dlmm(mint,70),63);p=h.get();assert(Math.abs(p.marketWorth-0.001*Math.pow(1.01,70))<1e-12);h.engine.stop();
 results.meteoraDlmmStreamsLive=true;
}
{
 // A route through some other pool, or a pool for a different coin, is never used.
 const mint=key().toBase58(),ammKey=key(),cv=key(),sv=key(),accounts=new Map([[ammKey.toBase58(),amm(key().toBase58(),cv,sv)]]);
 const h=harness({mint,ammKey:ammKey.toBase58(),accounts});h.engine.start();await h.flush();for(let i=0;i<6;i++)await h.advance();
 assert.equal(h.get().marketWorth,null);h.engine.stop();results.mismatchedPoolsAreIgnored=true;
}
console.log(JSON.stringify(results));
