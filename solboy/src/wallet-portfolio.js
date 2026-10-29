import { PublicKey } from '@solana/web3.js';
import { readTrades } from './log.js';
import { file } from './paths.js';
import { dexApi } from './endpoints.js';
import { parseTrades, WSOL } from './detect.js';

// Official SPL and Token Extensions program IDs: https://solana.com/docs/references/terminology
const PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const day = (time) => { const d = new Date(time); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const number = (n) => n !== null && n !== '' && Number.isFinite(Number(n)) ? Number(n) : null;
const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);

// Only the owner's LIVE book is supplied here. Practice profits never become wallet funds.
export function personalPortfolio({ address, balance, positions = [], trades = [], chain = {}, knownValues = [], now = Date.now() }) {
  const live = trades.filter(t => t.action === 'buy' || t.action === 'sell').map(t => ({
    side: t.action, mint: t.token, time: t.time, sol: number(t.sol) ?? 0,
    pnl: t.action === 'sell' ? number(t.pnl_sol) : null, wallet: t.copied_wallet, reason: t.reason, sig: t.tx || null,
  }));
  const grouped = new Map(), pos = new Map(positions), held = new Map((chain.holdings ?? []).map(h => [h.mint, { ...h }]));
  for (const t of live) {
    const g = grouped.get(t.mint) ?? { mint:t.mint, bought:0, sold:0, realized:0, buys:0, sells:0, openedAt:t.time, lastAt:t.time };
    if (t.side === 'buy') { g.bought += t.sol; g.buys++; } else { g.sold += t.sol; g.realized += t.pnl ?? 0; g.sells++; }
    g.lastAt = t.time; grouped.set(t.mint, g);
    // A cached chain scan must not resurrect a position sold after that scan.
    if (new Date(t.time).getTime() > (chain.at ?? 0)) {
      if (!pos.has(t.mint)) held.delete(t.mint);
      else held.set(t.mint, { ...(held.get(t.mint) ?? {}), mint:t.mint, raw:pos.get(t.mint).tokens });
    }
  }
  for (const [mint,p] of positions) if (!held.has(mint) && (!chain.at || new Date(p.openedAt).getTime() > chain.at)) held.set(mint,{mint,raw:p.tokens});
  const prices = new Map((chain.prices ?? []).map(p => [p.mint,p]));
  const holdings = [...held.values()].map(h => {
    const p = pos.get(h.mint), info = prices.get(h.mint) ?? {}, raw = String(h.raw ?? '0');
    const amount = h.decimals == null ? null : Number(raw) / 10 ** h.decimals;
    const known = knownValues.find(k => k.mint === h.mint && k.tokens === raw && p && k.paid === p.solSpent);
    const valueSol = amount != null && info.priceSol != null ? amount * info.priceSol : known?.worth ?? null;
    const cost = p && String(p.tokens) === raw ? p.solSpent : null;
    return { mint:h.mint, symbol:info.symbol ?? known?.name ?? null, name:info.name ?? null, image:info.image ?? null,
      raw, amount, valueSol, costSol:cost, pnlSol:cost != null && valueSol != null ? valueSol-cost : null,
      openedAt:p?.openedAt ?? grouped.get(h.mint)?.openedAt ?? null, source:p?.sourceLabel ?? null };
  }).filter(h => { try { return BigInt(h.raw) > 0n; } catch { return false; } }).sort((a,b)=>(b.valueSol??0)-(a.valueSol??0));
  const unknown = holdings.filter(h=>h.valueSol==null).length, unknownCost = holdings.filter(h=>h.costSol==null).length;
  const calendar = {}, periods = {};
  for (const t of live) if (t.pnl != null) { const key=day(t.time); calendar[key]=(calendar[key]??0)+t.pnl; }
  for (const days of [1,7,30,0]) {
    const list=live.filter(t=>!days || new Date(t.time).getTime()>=now-days*86400_000), sells=list.filter(t=>t.pnl!=null);
    let cumulative=0; const curve=sells.map(t=>({time:t.time,pnl:cumulative+=t.pnl}));
    const bins=[0,0,0,0,0];
    for(const t of sells){const cost=t.sol-t.pnl,roi=cost>0?t.pnl/cost*100:null;if(roi==null)continue;bins[roi>=500?0:roi>=200?1:roi>=0?2:roi>=-50?3:4]++;}
    // Keep chart payload bounded without changing the final total.
    const stride=Math.max(1,Math.ceil(curve.length/150));
    periods[days||'all']={realized:sum(sells,'pnl'),buys:list.filter(t=>t.side==='buy').length,sells:sells.length,
      wins:sells.filter(t=>t.pnl>0).length,volume:sum(list,'sol'),bins,
      curve:curve.filter((_,i)=>i%stride===0||i===curve.length-1)};
  }
  const history=[...grouped.values()].map(g=>{
    const h=holdings.find(h=>h.mint===g.mint),info=prices.get(g.mint)??{};
    return {...g,symbol:info.symbol??h?.symbol??null,name:info.name??h?.name??null,image:info.image??h?.image??null,
      holding:h?.valueSol??(h?null:0),pnl:g.realized+(h?.pnlSol??0),partial:Boolean(h&&h.pnlSol==null)};
  });
  return {address,balance,solUsd:chain.solUsd??null,chainAt:chain.at??null,scanning:Boolean(chain.scanning),error:chain.error??null,
    holdings,unknown,unknownCost,totalPartial:!chain.at||Boolean(chain.error)||unknown>0,totalSol:balance==null?null:balance+sum(holdings,'valueSol'),
    unrealized:holdings.some(h=>h.pnlSol!=null)?sum(holdings,'pnlSol'):holdings.length?null:0,
    realized:periods.all.realized,periods,calendar,history:history.sort((a,b)=>b.lastAt.localeCompare(a.lastAt)).slice(0,500),
    top:history.slice().sort((a,b)=>b.pnl-a.pnl).slice(0,100),activity:live.slice(-100).reverse(),
    transfers:chain.transfers??[],transferError:chain.transferError??null,transfersAt:chain.transfersAt??null,
    coverage:'Profit and cost figures cover real trades recorded by this SolBoy and may not include every network fee. External token costs are unknown; values are estimates before selling fees and price impact. Period filters apply to the chart and performance; holdings and history show all-time records.'};
}

// This connection uses rpc.backgroundFetch. Nothing here runs on /api/state or the copy-trading path.
export function createWalletPortfolio({ connection, book, account, readLiveTrades = () => readTrades(file('data/trades-live.csv')) }) {
  let chain={holdings:[],prices:[],at:0,transfers:[]}, task=null, attemptedAt=0;
  const parsedCache=new Map();
  const json=async(url)=>{const r=await fetch(url,{signal:AbortSignal.timeout(6000)});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();};
  async function scan(address) {
    const startedAt=Date.now();
    chain.scanning=true; chain.error=null;
    try {
      const owner=new PublicKey(address),byMint=new Map();
      const results=await Promise.all(PROGRAMS.map(p=>connection.getParsedTokenAccountsByOwner(owner,{programId:new PublicKey(p)})));
      for(const result of results)for(const a of result.value){const i=a.account.data.parsed?.info,t=i?.tokenAmount;if(!i||!t)continue;
        const prev=byMint.get(i.mint);byMint.set(i.mint,{mint:i.mint,raw:String(BigInt(prev?.raw??'0')+BigInt(t.amount)),decimals:t.decimals});}
      const holdings=[...byMint.values()].filter(h=>BigInt(h.raw)>0n),prices=[];
      let solUsd=null;
      try {
        const d=await json(process.env.SOL_PRICE_URL||`${dexApi()}/tokens/v1/solana/${WSOL}`);
        solUsd=Array.isArray(d)?number(d.find(p=>p.baseToken?.address===WSOL)?.priceUsd):number(d[WSOL]?.usdPrice??d.data?.[WSOL]?.price);
        if(!(solUsd>0))solUsd=null;
      }catch{}
      // Very dusty wallets remain usable: unpriced assets stay visible instead of being reported as zero.
      const recentMints=readLiveTrades().slice(-100).reverse().map(t=>t.token);
      const mints=[...new Set([...holdings.map(h=>h.mint),...recentMints])].slice(0,120);
      for(let i=0;i<mints.length;i+=30){try{
        const pairs=await json(`${dexApi()}/tokens/v1/solana/${mints.slice(i,i+30).join(',')}`),best=new Map();
        for(const p of Array.isArray(pairs)?pairs:[]){const mint=p.baseToken?.address;if(!mint||!mints.includes(mint))continue;
          if(best.has(mint)&&Number(best.get(mint).liquidity?.usd??0)>=Number(p.liquidity?.usd??0))continue;best.set(mint,p);}
        for(const [mint,p]of best){const native=number(p.priceNative),usd=number(p.priceUsd);prices.push({mint,symbol:p.baseToken.symbol,name:p.baseToken.name,image:p.info?.imageUrl??null,
          priceSol:mint===WSOL?1:(solUsd&&usd!=null?usd/solUsd:p.quoteToken?.address===WSOL?native:null)});}
      }catch{}}
      if(holdings.some(h=>h.mint===WSOL)&&!prices.some(p=>p.mint===WSOL))prices.push({mint:WSOL,symbol:'WSOL',name:'Wrapped SOL',priceSol:1});
      chain={...chain,holdings,prices,solUsd,at:startedAt,error:null,scanning:true};
    } catch {chain.error='Could not refresh on-chain holdings. Showing the last snapshot and SolBoy records.';}
    try {
      const sigs=await connection.getSignaturesForAddress(new PublicKey(address),{limit:12}),transfers=[];
      for(const s of sigs.filter(s=>!s.err)){
        if(!parsedCache.has(s.signature))parsedCache.set(s.signature,await connection.getParsedTransaction(s.signature,{maxSupportedTransactionVersion:1}));
        const tx=parsedCache.get(s.signature);if(!tx||tx.meta?.err||parseTrades(tx,address).length)continue;
        for(const ix of [...(tx.transaction?.message?.instructions??[]),...(tx.meta?.innerInstructions??[]).flatMap(x=>x.instructions??[])]){
          const i=ix.parsed?.info;if(ix.program!=='system'||ix.parsed?.type!=='transfer'||!i||i.source===i.destination)continue;
          if(i.source!==address&&i.destination!==address)continue;
          transfers.push({side:i.destination===address?'in':'out',sol:Number(i.lamports)/1e9,other:i.destination===address?i.source:i.destination,
            time:(tx.blockTime??s.blockTime)?new Date((tx.blockTime??s.blockTime)*1000).toISOString():null,sig:s.signature});
        }
      }
      while(parsedCache.size>100)parsedCache.delete(parsedCache.keys().next().value);
      chain.transfers=transfers;chain.transfersAt=Date.now();chain.transferError=null;
    }catch{chain.transferError='Recent transfers could not be refreshed.';}
    chain.scanning=false;
  }
  return {
    get({balance=null,knownValues=[],refresh=false}={}) {
      const address=account.address();
      if(address&&!task&&(Date.now()-attemptedAt>(refresh?10_000:60_000))){attemptedAt=Date.now();task=scan(address).finally(()=>{task=null;});}
      return personalPortfolio({address,balance,positions:book.positionsFor('live').entries(),trades:readLiveTrades(),chain,knownValues});
    },
  };
}
