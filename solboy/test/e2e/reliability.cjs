// Packaged application regressions; all services and funds are fake.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module');
const req=createRequire(path.join(__dirname,'../../package.json'));
const mint=()=>req('@solana/web3.js').Keypair.generate().publicKey.toBase58();
module.exports=async(p,F,E)=>{
 const output=path.join(E,'reliability.json');
 execFileSync(process.execPath,[path.join(__dirname,'reliability-unit.mjs'),output],{encoding:'utf8',timeout:30000});
 const R={reliability:JSON.parse(fs.readFileSync(output,'utf8'))};
 R.venues=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'venues-unit.mjs')],{encoding:'utf8',timeout:60000}));
 R.phoneUnit=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'phone-unit.mjs')],{encoding:'utf8',timeout:60000}).trim().split('\n').pop());
 R.realityUnit=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'reality-unit.mjs')],{encoding:'utf8',timeout:120000}).trim().split('\n').pop());
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(fn,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return true;await sleep(25);}return false;};
 const setting=(setting,value)=>p.evaluate(x=>api('/api/settings',x),{setting,value});
 const position=m=>p.evaluate(m=>S.inventory.find(x=>x.mint===m),m);
 await p.setViewportSize({width:1440,height:1050});await p.click('[data-tab=history]');
 for(const key of ['takeProfitPct','stopLossPct'])await setting(key,null);
 await setting('sellOnlyOnFullExit',true);await p.evaluate(()=>api('/api/pause',{paused:false}));
 await p.evaluate(()=>api('/api/sell-all',{}));await F('/set?mult=1');

 const cumulative=mint();await F('/emit?side=buy&mint='+cumulative);
 if(!await until(()=>position(cumulative)))throw Error('Cumulative-exit test buy missing');
 let kept=true,sourcePre=1000000;
 for(const pct of ['50.0','75.0','87.5']){
  await F('/emit?side=sell&frac=.5&mint='+cumulative+'&pre='+sourcePre);sourcePre/=2;
  if(!await until(async()=>(await p.locator('.feed').innerText()).includes(pct+'% cumulatively')))throw Error('Partial-exit progress did not reach dashboard');
  kept&&=!!await position(cumulative);
 }
 await F('/emit?side=sell&frac=.5&mint='+cumulative+'&pre='+sourcePre);
 R.cumulativeExitSellsOnce=kept&&await until(()=>p.evaluate(m=>!S.inventory.some(x=>x.mint===m)&&S.trades.filter(x=>x.token===m&&x.action.includes('sell')).length===1,cumulative));

 const outage=mint();await F('/emit?side=buy&mint='+outage);if(!await until(()=>position(outage)))throw Error('Sell-all outage test buy missing');
 const pnl=await p.evaluate(()=>S.summary.totalPnl);await F('/price/quote-error?mint='+outage);
 const all=await p.evaluate(()=>api('/api/sell-all',{}));await p.evaluate(()=>refresh());
 R.sellAllOutageKeepsPosition=all.writtenOff===0&&all.failed.length===1&&!!await position(outage);
 R.sellAllOutageDoesNotInventLoss=await p.evaluate(({mint,pnl})=>S.summary.totalPnl===pnl&&!S.trades.some(x=>x.token===mint&&x.action.includes('sell')),{mint:outage,pnl});
 await F('/price/quote-error');await p.evaluate(m=>api('/api/sell',{mint:m}),outage);await until(()=>p.evaluate(m=>!S.inventory.some(x=>x.mint===m),outage));

 const automatic=mint();await F('/set?mult=1');await F('/emit?side=buy&mint='+automatic);
 if(!await until(async()=>{const x=await position(automatic);return x&&!x.priceStale;},65000))throw Error('Automatic-exit test price missing');
 await F('/price/quote-error?mint='+automatic+'&after=1');await F('/set?mult=.5');await setting('stopLossPct',20);
 const card=p.locator('.slot').filter({has:p.locator('[data-sell="'+automatic+'"]')});
 R.automaticExitRetryVisible=await until(async()=>await card.locator('[data-auto-sell-status]').innerText().then(t=>t.includes('Automatic sell retry')&&t.includes('unavailable')),18000);
 await p.screenshot({path:E+'/23-automatic-sell-retry.png'});
 await F('/set?mult=1');await F('/price/quote-error');
 R.automaticExitRecoveredOnce=await until(()=>p.evaluate(m=>!S.inventory.some(x=>x.mint===m)&&S.trades.filter(x=>x.token===m&&x.action.includes('sell')).length===1,automatic),10000);
 await setting('stopLossPct',null);
 R.invalidWalletAmountRejected=await p.evaluate(address=>api('/api/wallets/add',{address,label:'invalid budget',buyAmountSol:'Infinity'}).then(()=>false,e=>e.status===400&&e.message.includes('finite')),mint());
 const slow=mint();await F('/price/metadata-delay?ms=4000');await F('/set?mult=1');await F('/emit?side=buy&mint='+slow);
 if(!await until(()=>position(slow)))throw Error('Slow-metadata test buy missing');
 R.stateDuringMetadataDelayMs=await p.evaluate(async()=>{const at=performance.now();await api('/api/state');return performance.now()-at;});
 R.slowMetadataCannotBlockDashboard=R.stateDuringMetadataDelayMs<750;
 await F('/price/metadata-delay?ms=0');await p.evaluate(m=>api('/api/sell',{mint:m}),slow);
 return R;
};
