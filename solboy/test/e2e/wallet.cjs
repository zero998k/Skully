const {execFileSync}=require('node:child_process');
const path=require('node:path');
module.exports=async(p,BASE,E)=>{
 const R={walletMath:JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'wallet-unit.mjs')],{encoding:'utf8'}))};
 await p.setViewportSize({width:1600,height:1050});await p.click('[data-tab=account]');
 await p.waitForFunction(()=>typeof PW!=='undefined'&&PW.data?.address&&PW.data.periods.all.sells>=2,{timeout:20000});
 R.personalWalletHeader=await p.locator('#personalPortfolio h1').innerText();
 R.personalWalletRealOnly=await p.evaluate(()=>S.mode==='paper'&&PW.data.activity.every(t=>['buy','sell'].includes(t.side))&&PW.data.balance===S.account.balance&&PW.data.realized!==S.summary.totalPnl);
 await p.click('[data-wallet-unit=SOL]');R.walletSolUnits=(await p.locator('#walletAvailable').innerText()).includes('SOL');
 await p.click('[data-wallet-range="1"]');R.walletPeriod=await p.evaluate(()=>PW.range==='1'&&PW.data.periods[1].sells>=2);
 await p.click('[data-wallet-tab=history]');R.walletHistory=await p.locator('#walletRows tbody tr').count();
 await p.fill('#walletSearch','no-such-coin-fixture');R.walletSearch=(await p.locator('#walletRows').innerText()).includes('No matching coins');
 await p.fill('#walletSearch','');await p.locator('#walletSearch').blur();
 await p.click('[data-wallet-tab=top]');R.walletTop=await p.locator('#walletRows tbody tr').count();
 await p.click('[data-wallet-activity=transfers]');R.walletTransfers=await p.locator('#walletActivity').innerText();
 R.walletPrivate=(await fetch(BASE+'/api/account/portfolio')).status===403;
 const shared=await p.evaluate(()=>api('/api/share/start',{}));
 try { R.walletGuestBlocked=(await fetch(shared.url+'/api/account/portfolio')).status===404; }
 finally { await p.evaluate(()=>api('/api/share/stop',{})); }
 await p.click('[data-wallet-tab=history]');await p.click('[data-wallet-activity=activity]');
 await p.screenshot({path:E+'/13-personal-wallet.png',fullPage:true});
 await p.setViewportSize({width:390,height:900});await p.screenshot({path:E+'/14-personal-wallet-phone.png',fullPage:true});
 R.walletPhoneOverflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 return R;
};
