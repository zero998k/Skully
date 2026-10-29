// Real bot code, isolated temporary files and fake connections. No real RPC or keys.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PublicKey, Keypair, TransactionMessage, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
const output=process.argv[2];
const cfg=JSON.parse(fs.readFileSync(new URL('./config.base.json',import.meta.url)));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'solboy-speed-unit-'));
process.chdir(dir);
delete process.env.TELEGRAM_BOT_TOKEN;delete process.env.TELEGRAM_CHAT_ID;
process.env.JUPITER_API_URL='https://unit.invalid/jupiter';
process.env.PUMPPORTAL_API_URL='https://unit.invalid/pump';
const { createBot }=await import('../../src/bot.js');
const { Positions }=await import('../../src/positions.js');
const { getQuote }=await import('../../src/jupiter.js');
const positions=new Positions(path.join(dir,'positions.json'));
const owner=Keypair.generate();
const source=cfg.wallets[0].address;
Object.assign(cfg,{onlyFirstBuy:true,sellOnlyOnFullExit:true,dailyLossLimitSol:100});
const receipts=new Map();let buildMint;
let onLogs,quotes=0,sends=0,held=0n,balance=1_000_000_000n,route=false,fail=false,latestBlockhashCalls=0,lastConfirm=null,lastUrl;
const connection={
 onLogs:(_key,fn)=>{onLogs=fn;return 1;},removeOnLogsListener:async()=>{},
 getParsedAccountInfo:async()=>({value:{data:{parsed:{info:{mintAuthority:null,freezeAuthority:null}}}}}),
 getParsedTokenAccountsByOwner:async(key)=>({value:key.toBase58()===source||!held?[]:[{account:{data:{parsed:{info:{tokenAmount:{amount:String(held)}}}}}}]}),
 getBalance:async()=>Number(balance),
 getParsedTransaction:async sig=>receipts.get(sig)??null,
 getLatestBlockhash:async()=>{latestBlockhashCalls++;throw Error('Unnecessary blockhash lookup');},
 sendRawTransaction:async(raw)=>{sends++;const tx=VersionedTransaction.deserialize(raw),sig=bs58.encode(tx.signatures[0]),buy=tx.message.compiledInstructions[0].data[0]===1,pre=held,preSol=balance;
 if(!fail){if(buy){held+=1000n;balance-=50_005_000n;}else{held=0n;balance+=99_995_000n;}}
 const tb=n=>({mint:buildMint,owner:owner.publicKey.toBase58(),uiTokenAmount:{amount:String(n),decimals:6}});
 receipts.set(sig,{meta:{err:fail?{InstructionError:[0,'Custom']}:null,fee:5000,preBalances:[Number(preSol)],postBalances:[Number(balance)],preTokenBalances:[tb(pre)],postTokenBalances:[tb(held)]},transaction:{message:{accountKeys:[owner.publicKey.toBase58()]}}});return sig;},
 confirmTransaction:async(strategy,commitment)=>{lastConfirm={strategy,commitment};await new Promise(r=>setTimeout(r,10));return {context:{slot:1},value:{err:fail?{InstructionError:[0,'Custom']}:null}};},
};
globalThis.fetch=async(url,init)=>{
 lastUrl=String(url);
 if(lastUrl.endsWith('/trade-local')){
  const body=JSON.parse(init.body);buildMint=body.mint;const user=new PublicKey(body.publicKey);
  const message=new TransactionMessage({payerKey:user,recentBlockhash:'11111111111111111111111111111111',instructions:[new TransactionInstruction({programId:new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),keys:[{pubkey:user,isSigner:true,isWritable:true}],data:Buffer.from([body.action==='buy'?1:2])})]}).compileToV0Message();
  return new Response(new VersionedTransaction(message).serialize());
 }
 if(lastUrl.includes('/quote?')){quotes++;return route?Response.json({outAmount:'1000'}):new Response('Could not find any route',{status:400});}
 throw Error('Unexpected network request in isolated test: '+lastUrl);
};
const bot=createBot({cfg,connection,book:{positions,keypair:owner,tradeLogFile:path.join(dir,'trades.csv')}});
const interval=globalThis.setInterval;globalThis.setInterval=()=>({unref(){}});bot.start();globalThis.setInterval=interval;
const wait=async(fn)=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('Bot did not finish test trade');};
let number=0;
const emit=(mint,side)=>{
 const b=Buffer.alloc(129);Buffer.from([189,219,127,211,78,230,97,238]).copy(b);
 new PublicKey(mint).toBuffer().copy(b,8);b.writeBigUInt64LE(1_500_000_000n,40);b.writeBigUInt64LE(30_000_000_000_000n,48);b[56]=side==='buy'?1:0;new PublicKey(source).toBuffer().copy(b,57);
 b.writeBigUInt64LE(40_000_000_000n,97);b.writeBigUInt64LE(800_000_000_000_000n,105);
 onLogs({signature:'test-'+(++number),err:null,logs:['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]','Program log: Instruction: '+side, 'Program data: '+b.toString('base64')]});
};
const results={};
const mint=Keypair.generate().publicKey.toBase58();emit(mint,'buy');await wait(()=>positions.has(mint));
assert.equal(bot.copySpeed().paper,true);assert.equal(bot.copySpeed().confirmed,null);results.paperIsNotConfirmed=true;
await bot.valueOf(mint,positions.get(mint).tokens);const count=quotes;emit(mint,'sell');await wait(()=>!positions.has(mint));assert.equal(quotes,count);results.noRouteCacheSkipsRedundantQuote=true;
emit(mint,'buy');await wait(()=>positions.has(mint));await bot.valueOf(mint,positions.get(mint).tokens);
await new Promise(r=>setTimeout(r,2100));route=true;const previous=quotes;void bot.sellNow(mint);await wait(()=>!positions.has(mint));assert.equal(quotes,previous+1);results.expiredRouteCacheRechecks=true;
cfg.dryRun=false;route=false;const liveMint=Keypair.generate().publicKey.toBase58();emit(liveMint,'buy');await wait(()=>positions.has(liveMint)&&!positions.get(liveMint).pendingBuy);
let timing=bot.copySpeed();assert.equal(timing.side,'buy');assert.equal(timing.paper,false);assert(timing.confirmed>=timing.last&&timing.complete>=timing.confirmed);
assert.equal(typeof lastConfirm.strategy,'string');assert.equal(lastConfirm.commitment,'confirmed');assert.equal(latestBlockhashCalls,0);results.confirmedBuyWithoutExtraLookup=true;
emit(liveMint,'sell');await wait(()=>!positions.has(liveMint));timing=bot.copySpeed();assert.equal(timing.side,'sell');assert(timing.confirmed>=timing.last);results.sellsAreTimed=true;
fail=true;const before=sends;const badMint=Keypair.generate().publicKey.toBase58();emit(badMint,'buy');await wait(()=>sends>before);await new Promise(r=>setTimeout(r,70));
assert.equal(positions.has(badMint),false);assert.equal(sends,before+1);results.failedConfirmationDoesNotOpenOrDuplicate=true;
route=true;delete process.env.JUPITER_API_URL;delete process.env.JUPITER_API_KEY;
await getQuote({inputMint:'So11111111111111111111111111111111111111112',outputMint:mint,amount:'1000',slippageBps:100});assert.equal(new URL(lastUrl).origin,'https://api.jup.ag');results.currentFreeJupiterEndpoint=true;
fs.writeFileSync(output,JSON.stringify(results,null,2));console.log('PASS: isolated speed, route-cache and confirmation-safety tests');
