// Compare the same packaged app and simulated chain load before/after a speed change.
// No public RPC, real funds, user settings or installed SolBoy are used.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '../../package.json'));
const { chromium } = require('playwright');
const { Keypair } = req('@solana/web3.js');
const bs58 = req('bs58');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(10); } throw Error('Timed out waiting for benchmark trade'); };
const F = p => fetch('http://127.0.0.1:18900' + p, { method: 'POST' }).then(r => r.json());
const groupStop = p => { if (p) try { process.kill(-p.pid, 'SIGTERM'); } catch {} };
const summary = rows => { const a = [...rows].sort((x,y)=>x-y); return { medianMs: +a[Math.floor(a.length/2)].toFixed(1), p95Ms: +a[Math.min(a.length-1,Math.floor(a.length*.95))].toFixed(1), samples: rows.length }; };
(async()=>{
 const [binary, output] = process.argv.slice(2); const rounds=Number(process.env.BENCH_ROUNDS || 8);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'solboy-latency-'));
 const fake=spawn(process.execPath,[path.join(__dirname,'fake.cjs')],{detached:true,stdio:'ignore'});
 let app,browser; const report={simulated:true,rounds,walletOpen:Boolean(process.env.BENCH_WALLET),cases:{}};
 try {
  await until(()=>F('/state').then(()=>true).catch(()=>false));
  browser=await chromium.launch();
  for(const [name,live,fast] of (process.env.BENCH_STREAM_ONLY ? [['paper-pump',false,true]] : [['paper-pump',false,true],['paper-routed',false,false],['live-pump',true,true]])){
   const folder=path.join(dir,name);fs.mkdirSync(folder);const exe=path.join(folder,'SolBoy');fs.copyFileSync(binary,exe);fs.chmodSync(exe,0o755);
   const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'config.base.json')));cfg.dryRun=!live;cfg.dashboard.port=18778;cfg.dailyLossLimitSol=100;cfg.priceCheckSeconds=60;
   fs.writeFileSync(path.join(folder,'config.json'),JSON.stringify(cfg));
   const secret=bs58.encode(Keypair.generate().secretKey); // isolated fake-chain fixture only
   fs.writeFileSync(path.join(folder,'.env'),fs.readFileSync(path.join(__dirname,'env.base'),'utf8')+'\nPRIVATE_KEY='+secret+'\n');
   await F('/set?sol=50&mult=1');
   app=spawn(exe,[],{detached:true,stdio:['pipe','ignore','ignore'],env:{...process.env,PORT:'18778'}});
   const page=await browser.newPage({viewport:{width:1440,height:1000}});
   await until(()=>fetch('http://localhost:18778/').then(()=>true).catch(()=>false));
   await page.goto('http://localhost:18778/');await page.waitForFunction(()=>typeof S!=='undefined'&&S?.account);
   if(process.env.BENCH_WALLET)await page.click('[data-tab=account]');
   await sleep(600);
   if(process.env.BENCH_STREAM_ONLY){report.stream=await require('./stream.cjs')(page,F);console.log(report.stream);await page.close();groupStop(app);app=null;await sleep(700);continue;}
   const rows={buy:[],sell:[],buyVisible:[],sellVisible:[]};
   const posFile=path.join(folder,'data',`positions-${live?'live':'paper'}.json`);
   const count=()=>{try{return Object.keys(JSON.parse(fs.readFileSync(posFile)).open).length;}catch{return -1;}};
   for(let i=0;i<rounds;i++){
    let start=performance.now();const trade=await F(fast?'/emit-pump?side=buy&sol=1.5':'/emit?side=buy');
    await until(()=>count()===1);rows.buy.push(performance.now()-start);
    await page.waitForFunction(()=>S.inventory.length===1);rows.buyVisible.push(performance.now()-start);
    start=performance.now();await F(fast?`/emit-pump?side=sell&mint=${trade.mint}&tokens=900000000000000000`:'/emit?side=sell');
    await until(()=>count()===0);rows.sell.push(performance.now()-start);
    await page.waitForFunction(()=>S.inventory.length===0);rows.sellVisible.push(performance.now()-start);
    await sleep(80);
   }
   report.cases[name]=Object.fromEntries(Object.entries(rows).map(([key,values])=>[key,summary(values)]));
   report.cases[name].timing=await page.evaluate(()=>S.copySpeed);
   console.log(name,JSON.stringify(report.cases[name]));
   await page.close();groupStop(app);app=null;await sleep(700);
  }
  fs.writeFileSync(output,JSON.stringify(report,null,2));
 }finally{groupStop(app);groupStop(fake);if(browser)await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
