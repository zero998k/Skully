// Before/after comparisons must use the same machine, fake chain and round count.
const fs=require('node:fs'), assert=require('node:assert/strict');
const [a,b]=process.argv.slice(2).map(p=>JSON.parse(fs.readFileSync(p)));
assert(a.simulated&&b.simulated&&a.rounds===b.rounds);
assert(Boolean(a.walletOpen)===Boolean(b.walletOpen),'Use the same open page for both speed runs');
for(const name of Object.keys(a.cases)){
 for(const metric of ['buy','sell','buyVisible','sellVisible']){
  const before=a.cases[name][metric],after=b.cases[name][metric];
  // Small scheduling/GC variation is expected; sustained slowdown is not.
  assert(after.medianMs<=before.medianMs*1.05+10,`${name} ${metric}: median regression ${before.medianMs} -> ${after.medianMs}`);
  assert(after.p95Ms<=before.p95Ms*1.15+50,`${name} ${metric}: p95 regression ${before.p95Ms} -> ${after.p95Ms}`);
  console.log(`PASS  simulated speed: ${name} ${metric}: median ${before.medianMs} -> ${after.medianMs} ms`);
 }
}
assert(b.cases['live-pump'].buyVisible.medianMs<1000,'Simulated live Pump buy not visible under one second');
console.log('PASS  simulated speed: Pump buy visible below one second; no sustained regression in tested paths.');
