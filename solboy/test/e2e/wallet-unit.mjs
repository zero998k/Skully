import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { personalPortfolio, createWalletPortfolio, walletPerformance } from '../../src/wallet-portfolio.js';
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

// Deliberately shuffled sells include losses, a flat result, leap day and an unassigned source.
const fixedNow=new Date(2024,2,2,12).getTime(),at=(d,h=12)=>new Date(2024,1,d,h).toISOString();
const sample=[trade('sell',mint,3,2,at(29,10)),trade('buy',mint,1,'',at(28)),trade('sell',mint,1,-1,at(29,11)),
 trade('sell',mint,1,0,at(29,12)),trade('sell',mint,2,1,at(29,13)),trade('sell',mint,1,-2,at(30)),
 trade('PAPER sell',mint,1000,999,at(29)),trade('sell',mint,99,99,new Date(fixedNow+86400_000).toISOString())];
sample[0].copied_wallet=address;sample[1].copied_wallet=address;
const detail=personalPortfolio({address,balance:0,trades:sample,now:fixedNow}),stats=detail.periods.all.insights;
assert.equal(detail.realized,0);assert.equal(detail.detailTrades.length,6);
assert.equal(detail.calendar['2024-02-29'],2);assert.equal(detail.calendarDays.find(d=>d.date==='2024-02-29').sells,4);
assert.equal(detail.calendarDays.find(d=>d.date==='2024-03-01').pnl,-2);assert.equal(detail.today,'2024-03-02');
assert.equal(stats.grossProfit,3);assert.equal(stats.grossLoss,3);assert.equal(stats.profitFactor,1);
assert.equal(stats.averageWin,1.5);assert.equal(stats.averageLoss,-1.5);assert.equal(stats.drawdown,2);
assert.equal(stats.soldCost,8);assert.equal(stats.returnPct,0);assert.equal(stats.bestWinStreak,1);assert.equal(stats.bestLossStreak,1);
assert.equal(stats.breakEven,1);assert.equal(stats.activeDays,3);assert.equal(stats.greenDays,1);assert.equal(stats.redDays,1);
assert.equal(stats.bestDay.date,'2024-02-29');assert.equal(stats.worstDay.date,'2024-03-01');
assert.equal(stats.sources.find(s=>s.wallet===address).pnl,2);assert.equal(stats.sources.find(s=>s.wallet===null).pnl,-2);
assert.equal(detail.periods[1].sells,1);assert.equal(detail.periods[1].insights.grossLoss,2);
const none=walletPerformance([]);assert.equal(none.profitFactor,null);assert.equal(none.averageWin,null);assert.equal(none.drawdown,null);
assert.equal(walletPerformance([{side:'sell',sol:2,pnl:1,time:at(29)}]).profitFactor,null);
const iterator=personalPortfolio({address,balance:0,positions:new Map(positions).entries(),now});assert.equal(iterator.holdings.length,1);
results.calendarHandlesLeapDayAndRealRecords=true;results.scorecardDrawdownAndReturns=true;results.sourceAttributionAndPeriodIsolation=true;results.emptyStatsStayUnknownAndPositionIteratorsWork=true;

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
