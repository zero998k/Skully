// Realistic paper trading: trades land after the natural delay at the live price, pay real fees,
// fail only past the slippage limit, and are logged three ways. Every account and trade is synthetic.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(path.join(repo,'solboy/package.json'));
const {Keypair,PublicKey}=require('@solana/web3.js');
const load=f=>import(pathToFileURL(path.join(repo,'solboy/src',f)));
const {createBot}=await load('bot.js');
const {Positions}=await load('positions.js');
const {readTrades,recordTrade}=await load('log.js');
const {summarize,reality}=await load('stats.js');
const {createPaperReality}=await load('paper-reality.js');
const base=JSON.parse(fs.readFileSync(path.join(repo,'solboy/test/e2e/config.base.json')));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'solboy-reality-'));
process.chdir(temp);delete process.env.TELEGRAM_BOT_TOKEN;delete process.env.TELEGRAM_CHAT_ID;
process.env.JUPITER_API_URL='https://reality.invalid/jupiter';
globalThis.fetch=async()=>{throw Error('Unexpected external request blocked in reality test');};
const results={},PUMP=new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const curveAccount=(sol,tokens)=>{const d=Buffer.alloc(49);Buffer.from([23,183,248,55,96,216,172,96]).copy(d);d.writeBigUInt64LE(tokens,8);d.writeBigUInt64LE(sol,16);return{owner:PUMP,data:d};};
const SOL0=40_000_000_000n,TOK0=800_000_000_000_000n;
let instance=0,sequence=0;
function setup(extra={}){
 const cfg={...base,wallets:base.wallets.map(x=>({...x})),dryRun:true,onlyFirstBuy:false,sellOnlyOnFullExit:true,paperRealism:'home',...extra};
 const dir=path.join(temp,'run'+(++instance));fs.mkdirSync(dir);
 const positions=new Positions(path.join(dir,'positions.json'));
 const f={cfg,positions,curve:[SOL0,TOK0],balances:[],curveReads:0};
 const balance=n=>({value:n?[{account:{data:{parsed:{info:{tokenAmount:{amount:String(n)}}}}}}]:[]});
 f.connection={
  getParsedAccountInfo:async()=>({value:{data:{parsed:{info:{mintAuthority:null,freezeAuthority:null}}}}}),
  getParsedTokenAccountsByOwner:async()=>{const next=f.balances.length>1?f.balances.shift():f.balances[0]??{slot:null,amount:0n};return{...(next.slot?{context:{slot:next.slot}}:{}),...balance(next.amount)};},
  getAccountInfo:async()=>{f.curveReads++;return curveAccount(...f.curve);},
  getRecentPrioritizationFees:async()=>Array.from({length:20},()=>({slot:1,prioritizationFee:100})),
  onLogs:()=>1,removeOnLogsListener:async()=>{},
 };
 f.book={positions,tradeLogFile:path.join(dir,'trades-paper.csv')};
 f.bot=createBot({cfg,connection:f.connection,book:f.book});
 f.emit=(mint,side,opts={})=>{
  const b=Buffer.alloc(129);Buffer.from([189,219,127,211,78,230,97,238]).copy(b);new PublicKey(mint).toBuffer().copy(b,8);
  b.writeBigUInt64LE(1_500_000_000n,40);b.writeBigUInt64LE(opts.tokens??30_000_000_000_000n,48);b[56]=side==='buy'?1:0;
  new PublicKey(cfg.wallets[0].address).toBuffer().copy(b,57);b.writeBigUInt64LE(SOL0,97);b.writeBigUInt64LE(TOK0,105);
  return f.bot.handleSignature(cfg.wallets[0],'reality-'+(++sequence),Date.now(),['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]','Program data: '+b.toString('base64')],opts.slot??null);
 };
 return f;
}
const mint=()=>Keypair.generate().publicKey.toBase58();
const near=(a,b,eps=1e-6)=>Math.abs(Number(a)-Number(b))<eps;

// 1. A buy waits for its natural landing, then pays real fees and the first-time token account.
{
 const f=setup(),m=mint(),start=Date.now();await f.emit(m,'buy');const took=Date.now()-start;
 const pos=f.positions.get(m),[row]=readTrades(f.book.tradeLogFile);
 assert(pos,'realistic buy opened a position');assert(took>=500,`buy landed after a real delay (${took}ms)`);assert(f.curveReads>=1,'price was read again at landing');
 const fees=(5000+1_000_000+2_039_280)/1e9;
 assert(near(pos.solSpent,0.05+fees),`cost includes fees: ${pos.solSpent}`);
 assert.equal(row.realism,'home');assert(near(row.perfect_sol,0.05));assert(near(row.home_sol,0.05+fees));assert(near(row.pro_sol,0.05+fees+0.001));
 assert(Number(row.lag_ms)>=500);assert(near(row.fees_sol,fees));
 assert.deepEqual(Object.keys(pos.reality).sort(),['home','perfect','pro']);
 results.realisticBuyWaitsForNaturalLandingAndPaysFees=true;

 // 2. The coin dips 5% while the copied wallet's sell lands: the sell still fills, at the later price.
 f.curve=[SOL0*95n/100n,TOK0*100n/95n];f.balances=[{amount:0n}];
 await f.emit(m,'sell',{tokens:30_000_000_000_000n});
 assert(!f.positions.has(m),'full copied sell closed the position');
 const sell=readTrades(f.book.tradeLogFile).at(-1);
 assert.equal(sell.action,'PAPER sell');assert(Number(sell.home_pnl)<Number(sell.perfect_pnl),'lag cost shows');assert(Number(sell.pro_pnl)<Number(sell.perfect_pnl),'pro still pays fees');
 assert(near(sell.home_pnl,sell.pnl_sol),'home drives the wallet');
 const card=reality(readTrades(f.book.tradeLogFile));
 assert.equal(card.trades,1);assert(card.perfect>card.home);assert(card.fees>0);assert(card.lagMedianMs>=500);
 results.realisticSellUsesLandingPriceAndLogsThreeWays=true;results.realityCheckSummarisesThePerfectHomeAndProGap=true;
}
// 3. The price runs away past the slippage limit during the lag: the buy fails like a real one, and pays its fee.
{
 const f=setup(),m=mint();f.curve=[SOL0*16n/10n,TOK0*10n/16n];
 await f.emit(m,'buy');
 assert(!f.positions.has(m),'failed buy opened nothing');
 const [row]=readTrades(f.book.tradeLogFile);assert.equal(row.action,'PAPER failed buy');assert(/would have failed for real/.test(row.reason));
 assert(near(f.positions.todayPnl(),-(5000+1_000_000)/1e9),'a failed trade still pays its network fee');
 const s=summarize(readTrades(f.book.tradeLogFile));assert.equal(s.buys,0);assert.equal(s.sells,0);assert(near(s.totalPnl,-(5000+1_000_000)/1e9));
 assert.equal(reality(readTrades(f.book.tradeLogFile)).failedBuys,1);
 results.priceMovePastSlippageFailsLikeARealTrade=true;
}
// 4. A wider slippage limit lets the same move through: the limit is applied exactly as set.
{
 const f=setup({buySlippageBps:5000}),m=mint();f.curve=[SOL0*12n/10n,TOK0*10n/12n];
 await f.emit(m,'buy');assert(f.positions.has(m),'25% move fits a 50% limit');
 const row=readTrades(f.book.tradeLogFile)[0];assert(Number(row.home_sol)>0);assert(BigInt(f.positions.get(m).tokens)<BigInt(f.positions.get(m).reality.perfect.tokens),'later price means fewer coins');
 results.slippageLimitIsAppliedExactlyAsSet=true;
}
// 5. Perfect keeps the old instant paper fills: no waiting, no fees, no extra price reads.
{
 const f=setup({paperRealism:'perfect'}),m=mint(),start=Date.now();await f.emit(m,'buy');
 assert(Date.now()-start<400);assert.equal(f.curveReads,0);assert(near(f.positions.get(m).solSpent,0.05));assert.equal(readTrades(f.book.tradeLogFile)[0].realism,'');
 results.perfectModeKeepsInstantPaperFills=true;
}
// 6. 🚀 drives the wallet: decision price, fees plus the tip; the 🏠 comparison is still recorded.
{
 const f=setup({paperRealism:'pro',proTipSol:0.002}),m=mint();await f.emit(m,'buy');
 const row=readTrades(f.book.tradeLogFile)[0],fees=(5000+1_000_000+2_039_280)/1e9;
 assert.equal(row.realism,'pro');assert(near(f.positions.get(m).solSpent,0.05+fees+0.002));assert(near(row.home_sol,0.05+fees));
 results.proSetupEstimateDrivesTheWalletWhenChosen=true;
}
// 7. A dev's full sell read from an RPC node a moment behind no longer looks like a 50% sell.
{
 const f=setup({paperRealism:'perfect',sellOnlyOnFullExit:true}),m=mint();await f.emit(m,'buy',{slot:100});
 f.balances=[{slot:120,amount:30_000_000_000_000n},{slot:121,amount:0n}];
 await f.emit(m,'sell',{tokens:30_000_000_000_000n,slot:121});
 assert(!f.positions.has(m),'the stale read was retried and the full exit copied');
 results.staleBalanceNoLongerHalvesADevFullSell=true;
}
// 8. Real-money landings, once measured, replace the estimate; older trade logs gain the new columns.
{
 const file=path.join(temp,'reality-calibration.json'),r=createPaperReality({cfg:{dryRun:false},file});
 for(const ms of [700,800,900,1000,1100])r.noteLanding(ms);assert.equal(r.measuredLandings(),5);
 const again=createPaperReality({cfg:{dryRun:true,paperRealism:'home',priorityFeeMaxLamports:1_000_000},file,random:()=>0});
 const t0=Date.now(),landed=await again.land({side:'buy',mint:mint(),amount:50_000_000n,state0:{kind:'quote',amount:50_000_000n,out:1000n},readState:async()=>({kind:'quote',amount:50_000_000n,out:1000n}),via:'jupiter',slippageBps:2500,sentAt:t0,seenAt:t0});
 assert.equal(landed.landingSource,'your real trades');assert.equal(landed.landingMs,400,'the shortest measured landing, minus the confirmation slot, never under one slot');
 const old=path.join(temp,'old.csv');fs.writeFileSync(old,'time,action,token,copied_wallet,sol,pnl_sol,reason,tx\n"2026-10-30T00:00:00.000Z","PAPER sell","m","w","1","0.5","x",""\n');
 recordTrade(old,{action:'PAPER buy',mint:'n',wallet:'w',sol:0.05,realism:'home',lag_ms:'900'});
 const rows=readTrades(old);assert.equal(rows.length,2);assert.equal(rows[0].pnl_sol,'0.5');assert.equal(rows[0].realism,'');assert.equal(rows[1].lag_ms,'900');
 results.realLandingTimesCalibratePaper=true;results.olderTradeLogsKeepWorking=true;
}
console.log(JSON.stringify(results));process.exit(0);
