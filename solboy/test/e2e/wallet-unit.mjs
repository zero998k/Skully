import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { personalPortfolio, createWalletPortfolio } from '../../src/wallet-portfolio.js';
const now=Date.now(),stamp=ms=>new Date(now-ms).toISOString(),address=Keypair.generate().publicKey.toBase58();
const mint=Keypair.generate().publicKey.toBase58(),unknown=Keypair.generate().publicKey.toBase58(),sold=Keypair.generate().publicKey.toBase58();
const positions=[[mint,{tokens:'1234567890123',solSpent:2,openedAt:stamp(10000),sourceLabel:'fixture'}]];
const trade=(action,token,sol,pnl='',time=stamp(1000))=>({action,token,sol:String(sol),pnl_sol:String(pnl),time});
const trades=[trade('PAPER sell',mint,1000,999),trade('buy',mint,2),trade('sell',sold,3,1)];
const chain={at:now-20000,holdings:[{mint,raw:'1234567890123',decimals:9},{mint:unknown,raw:'500000000',decimals:8},{mint:sold,raw:'50',decimals:0}],prices:[{mint,priceSol:.002,symbol:'TEST'}]};
const d=personalPortfolio({address,balance:3,positions,trades,chain,now});
assert.equal(d.realized,1);assert.equal(d.activity.length,2);assert.equal(d.periods.all.sells,1);
assert.equal(d.holdings.find(h=>h.mint===mint).amount,1234.567890123);
assert(Math.abs(d.totalSol-5.469135780246)<1e-9);
assert.equal(d.holdings.find(h=>h.mint===unknown).pnlSol,null);assert.equal(d.holdings.find(h=>h.mint===unknown).valueSol,null);
assert.equal(d.unknown,1);assert.equal(d.holdings.some(h=>h.mint===sold),false);
assert.equal(d.periods.all.bins[2],1);assert.equal(d.periods.all.curve.at(-1).pnl,1);
const old=personalPortfolio({address,balance:null,trades:[trade('sell',sold,2,1,stamp(10*86400_000))],now});
assert.equal(old.totalSol,null);assert.equal(old.periods[7].realized,0);assert.equal(old.periods[30].realized,1);
const results={realFundsExcludePaper:true,unknownPricesAndCostsStayUnknown:true,tokenDecimalsAndTotals:true,staleHoldingsCannotRestoreSold:true,periodsAndChartUseRealSells:true};

// A fresh scan returns immediately, shares in-flight work, and uses only the supplied background connection.
let release,calls=0;const programs=[],gate=new Promise(r=>release=r),oldFetch=globalThis.fetch,oldPrice=process.env.SOL_PRICE_URL;
process.env.SOL_PRICE_URL='https://wallet.unit.invalid/price';
globalThis.fetch=async url=>Response.json(String(url).includes('/price')?{'So11111111111111111111111111111111111111112':{usdPrice:150}}:[]);
try {
 const service=createWalletPortfolio({account:{address:()=>address},book:{positionsFor:mode=>{assert.equal(mode,'live');return{entries:()=>[]};}},readLiveTrades:()=>[],
  connection:{getParsedTokenAccountsByOwner:async(owner,filter)=>{programs.push(filter.programId.toBase58());calls++;await gate;return{value:[]};},getSignaturesForAddress:async()=>[]}});
 const start=performance.now();assert.equal(service.get({balance:3}).balance,3);assert(performance.now()-start<100);
 assert(service.get({balance:3,refresh:true}).scanning);assert.equal(calls,2);release();
 for(let i=0;i<50&&service.get({balance:3}).scanning;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(service.get({balance:3}).solUsd,150);service.get({balance:3});assert.equal(calls,2);
 assert.deepEqual(programs,['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);results.officialTokenPrograms=true;
 results.backgroundScanIsNonblockingAndCached=true;
}finally{globalThis.fetch=oldFetch;if(oldPrice===undefined)delete process.env.SOL_PRICE_URL;else process.env.SOL_PRICE_URL=oldPrice;}
console.log(JSON.stringify(results));
