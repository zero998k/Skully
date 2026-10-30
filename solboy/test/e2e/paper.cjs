const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module');
const req=createRequire(path.join(__dirname,'../../package.json')),mint=()=>req('@solana/web3.js').Keypair.generate().publicKey.toBase58();
module.exports=async(p,F,E,APP)=>{
 const R={paperMath:JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'paper-unit.mjs')],{encoding:'utf8'}))};
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),until=async(fn,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return true;await sleep(25);}return false;};
 await p.setViewportSize({width:1440,height:1050});await p.evaluate(()=>api('/api/pause',{paused:false}));await p.evaluate(()=>api('/api/wallets/toggle',{key:'wallet1',paused:false}));
 for(const setting of ['takeProfitPct','stopLossPct'])await p.evaluate(setting=>api('/api/settings',{setting,value:null}),setting);
 await p.evaluate(()=>api('/api/settings',{setting:'buyAmountSol',value:.05}));await p.evaluate(()=>api('/api/sell-all',{}));await F('/set?mult=1');
 await p.click('#paperFundsTop');R.paperTopShortcut=await p.locator('#paperFunds').isVisible();
 await p.fill('#paperStartingSol','0.08');await p.click('#paperFundsForm button[type=submit]');
 R.paperStartingBalanceSaved=await until(()=>p.evaluate(()=>S.paperWallet?.enabled&&Math.abs(S.paperWallet.availableSol-.08)<1e-9));
 R.paperInvalidBalanceRejected=await p.evaluate(async()=>{const bad=await Promise.all([{}, {sol:null}].map(body=>api('/api/paper/balance',body).then(()=>false,error=>error.status===400)));return bad.every(Boolean)&&S.paperWallet.enabled&&Math.abs(S.paperWallet.availableSol-.08)<1e-9;});
 const a=mint(),b=mint();await F('/price/quote-delay?ms=500');await Promise.all([F('/emit?side=buy&mint='+a),F('/emit?side=buy&mint='+b)]);
 if(!await until(()=>p.evaluate(()=>S.inventory.length===1),10000))throw Error('Paper bankroll race did not open one funded position');await F('/price/quote-delay?ms=0');await sleep(700);await p.evaluate(()=>refresh());
 const held=await p.evaluate(()=>S.inventory[0].mint);R.paperBuyDebitsCash=await p.evaluate(()=>S.inventory.length===1&&Math.abs(S.paperWallet.availableSol-.03)<1e-9);
 R.paperInsufficientBuySkipped=await p.evaluate(()=>S.copyActivity.some(x=>/not enough paper SOL/i.test(x.reason))&&S.inventory.length===1);
 await p.fill('#paperStartingSol','2');await p.click('#paperFundsForm button[type=submit]');R.paperResetProtectsOpenTrades=await until(async()=>(await p.locator('#paperFundsError').innerText()).includes('Close your open paper'));
 await F('/set?mult=1.4');await p.evaluate(m=>api('/api/sell',{mint:m}),held);R.paperSellCreditsProceeds=await until(()=>p.evaluate(()=>!S.inventory.length&&Math.abs(S.paperWallet.availableSol-.1)<1e-9));
 // The paper file's balance is the exact debit/proceeds ledger, independent of chart references.
 const saved=JSON.parse(fs.readFileSync(path.join(APP,'data/positions-paper.json')));R.paperSellCreditsProceeds&&=saved.paperWallet.availableLamports==='100000000';
 await p.reload();await p.waitForFunction(()=>S?.paperWallet);R.paperBalanceSurvivesReload=await p.evaluate(()=>S.paperWallet.enabled&&Math.abs(S.paperWallet.availableSol-.1)<1e-9);
 await p.click('#paperFundsTop');await p.setViewportSize({width:390,height:900});R.paperPhoneFits=await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);await p.screenshot({path:E+'/18-paper-funds-phone.png',fullPage:true});await p.setViewportSize({width:1440,height:1050});
 // A rejected quote before a practice buy must return its reservation in full.
 const failed=mint();await F('/pp/noroute?mint='+failed);await F('/emit?side=buy&mint='+failed);await sleep(1000);await p.evaluate(()=>refresh());
 R.paperFailedBuyRefunds=await p.evaluate(m=>!S.inventory.some(x=>x.mint===m)&&Math.abs(S.paperWallet.availableSol-.1)<1e-9&&S.paperWallet.reservedSol===0,failed);
 await p.fill('#paperStartingSol','0');await p.click('#paperFundsForm button[type=submit]');await until(()=>p.evaluate(()=>S.paperWallet.availableSol===0));await F('/emit?side=buy&mint='+mint());await sleep(450);await p.evaluate(()=>refresh());R.paperZeroStopsBuys=await p.evaluate(()=>!S.inventory.length&&S.paperWallet.availableSol===0);
 await p.click('#paperUnlimited');R.paperUnlimitedRestored=await until(()=>p.evaluate(()=>!S.paperWallet.enabled));
 // One observed source sell fails, remains visible, and retries without another source event.
 const retry=mint();await F('/set?mult=1');await F('/emit?side=buy&mint='+retry);if(!await until(()=>p.evaluate(m=>S.inventory.some(x=>x.mint===m),retry)))throw Error('Retry test buy missing');
 await F('/price/quote-error?mint='+retry);await F('/emit?side=sell&mint='+retry);
 const card=p.locator('.slot').filter({has:p.locator('[data-sell="'+retry+'"]')});
 R.copiedSellRetryVisible=await until(async()=>await card.locator('[data-copied-sell-status]').innerText().then(t=>t.includes('Copied sell retry')&&t.includes('unavailable')));
 await p.screenshot({path:E+'/19-copied-sell-retry.png'});const started=Date.now();await F('/price/quote-error');
 R.copiedSellRecoveredOnce=await until(()=>p.evaluate(m=>!S.inventory.some(x=>x.mint===m)&&S.trades.filter(x=>x.token===m&&x.action.includes('sell')).length===1,retry),5000);R.copiedSellRecoveryMs=Date.now()-started;
 const base=new URL(p.url()).origin;R.paperApiPrivate=(await fetch(base+'/api/paper/balance',{method:'POST',headers:{'content-type':'application/json'},body:'{"sol":1}'})).status===403;
 await p.click('#paperFundsTop');await p.screenshot({path:E+'/20-paper-funds.png'});return R;
};
