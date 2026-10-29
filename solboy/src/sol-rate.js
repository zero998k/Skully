import {dexApi} from './endpoints.js';
import {WSOL} from './detect.js';
// One shared free USD quote. It never occupies a Solana RPC slot or blocks a trade.
export function createSolRate(){
 let price=null,at=0,task=null,timer;
 function refresh(){if(task)return task;task=(async()=>{try{
  const r=await fetch(process.env.SOL_PRICE_URL||`${dexApi()}/tokens/v1/solana/${WSOL}`,{signal:AbortSignal.timeout(5000)});if(!r.ok)return;
  const d=await r.json(),n=Number(Array.isArray(d)?d.find(p=>p.baseToken?.address===WSOL)?.priceUsd:d[WSOL]?.usdPrice??d.data?.[WSOL]?.price);
  if(n>0&&Number.isFinite(n)){price=n;at=Date.now();}
 }catch{}finally{task=null;}})();return task;}
 return{start(){void refresh();timer=setInterval(refresh,15000);timer.unref?.();},get:()=>({price,at,stale:!at||Date.now()-at>45000}),stop(){clearInterval(timer);}};
}
