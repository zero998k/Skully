// Verify immediate trade updates and protection against older full-state responses.
module.exports = async (p, F) => {
 const R = {}, S = () => p.evaluate(() => S), sleep = ms => new Promise(r => setTimeout(r,ms));
 const until = async(fn,ms=2000) => { const end=Date.now()+ms; do { if(await fn())return true;await sleep(25); }while(Date.now()<end);return false; };
 const holdState = async () => {
  let held, resume;
  const old = await S(), paused = new Promise(resolve => { resume=resolve; });
  const handler=async route => { held=route; await paused; };
  await p.route('**/api/state*',handler);
  await p.evaluate(() => { refresh(); });
  if(!(await until(async()=>!!held,7000)))throw Error('The test did not intercept the state request');
  return async()=>{
   // Fulfil while our handler is still registered. Removing it first lets Playwright continue it.
   try { await held.fulfill({status:200,contentType:'application/json',body:JSON.stringify(old)}); }
   finally { resume();await p.unroute('**/api/state*',handler); }
   await sleep(120);
  };
 };
 let release=await holdState(),start=Date.now();
 const trade=await F('/emit-pump?side=buy&sol=1.5');
 R.streamBuyWhileStateStalled=await until(async()=>(await S()).inventory.some(x=>x.mint===trade.mint));
 R.streamBuyMs=Date.now()-start;await release();
 R.staleStateCannotHideBuy=(await S()).inventory.some(x=>x.mint===trade.mint);
 release=await holdState();start=Date.now();
 await F(`/emit-pump?side=sell&mint=${trade.mint}&tokens=900000000000000000`);
 R.streamSellWhileStateStalled=await until(async()=>!(await S()).inventory.some(x=>x.mint===trade.mint));
 R.streamSellMs=Date.now()-start;await release();
 R.staleStateCannotRestoreSold=!(await S()).inventory.some(x=>x.mint===trade.mint);
 R.paperSpeedLabel=await p.textContent('#copySpeed');
 return R;
};
