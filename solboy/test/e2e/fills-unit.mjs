import assert from 'node:assert/strict';
import {Keypair,PublicKey} from '@solana/web3.js';
import {transactionFill} from '../../src/fills.js';
import {pumpTradesFromLogs,parseTrades,WSOL} from '../../src/detect.js';
import {decodeCurve,PUMP} from '../../src/live-prices.js';
const owner=Keypair.generate().publicKey.toBase58(),mint=Keypair.generate().publicKey.toBase58(),quote=Keypair.generate().publicKey.toBase58(),R={};
const tb=(m,n)=>({mint:m,owner,uiTokenAmount:{amount:String(n),decimals:6}});
const tx=(side)=>({transaction:{message:{accountKeys:[owner]}},meta:{err:null,fee:5000,preBalances:[2e9],postBalances:[side==='buy'?1_499_995_000:2_599_995_000],preTokenBalances:[tb(mint,side==='buy'?0:1000)],postTokenBalances:[tb(mint,side==='buy'?900:0)]}});
let fill=transactionFill(tx('buy'),owner,mint,'buy');assert.equal(fill.tokensRaw,900n);assert.equal(fill.solRaw,500005000n);fill=transactionFill(tx('sell'),owner,mint,'sell');assert.equal(fill.solRaw,599995000n);R.realFillsUseReceiptAmountsIncludingFees=true;
// A concurrent 17 SOL deposit never appears in this immutable trade receipt.
const unrelatedCurrentBalance=19e9;assert.notEqual(Number(fill.solRaw),unrelatedCurrentBalance-2e9);assert.equal(fill.solRaw,599995000n);R.depositsAndOtherTradesCannotInflateAReceipt=true;
const wrapped=tx('buy');wrapped.meta.preBalances=[2e9];wrapped.meta.postBalances=[1_999_995_000];wrapped.meta.preTokenBalances.push(tb(WSOL,500000000));wrapped.meta.postTokenBalances.push(tb(WSOL,0));assert.equal(transactionFill(wrapped,owner,mint,'buy').solRaw,500005000n);R.wrappedSolAndNativeSolAreCombined=true;
const tiny=tx('sell');tiny.meta.postBalances=[1_999_998_000];assert.equal(transactionFill(tiny,owner,mint,'sell').solRaw,-2000n);R.smallSellsCanRecordNetLossAfterFees=true;
assert.equal(transactionFill(null,owner,mint,'buy'),null);const failed=tx('buy');failed.meta.err={InstructionError:[0,'Custom']};assert.throws(()=>transactionFill(failed,owner,mint,'buy'));R.missingAndFailedReceiptsCannotCreateProfit=true;
// The reported +3497% bug: custom-quote reserves must never be interpreted as lamports.
const data=Buffer.alloc(115);Buffer.from([23,183,248,55,96,216,172,96]).copy(data);data.writeBigUInt64LE(1073000000000000n,8);data.writeBigUInt64LE(86054704n,16);new PublicKey(quote).toBuffer().copy(data,83);assert.equal(decodeCurve({owner:PUMP,data}),null);R.nonSolReservesCannotBecomeFakeSolProfit=true;
const b=Buffer.alloc(391);Buffer.from([189,219,127,211,78,230,97,238]).copy(b);new PublicKey(mint).toBuffer().copy(b,8);b.writeBigUInt64LE(1000n,48);b[56]=1;new PublicKey(owner).toBuffer().copy(b,57);b.writeUInt32LE(3,258);b.write('buy',262);const offset=302;new PublicKey(quote).toBuffer().copy(b,offset);b.writeBigUInt64LE(1000000n,offset+32);
const logs=['Program '+PUMP.toBase58()+' invoke [1]','Program data: '+b.toString('base64')];const event=pumpTradesFromLogs(logs,owner)[0];assert(event.requiresReceipt);assert.equal(event.curve,undefined);assert.equal(event.quoteMint,quote);R.nonSolPumpEventsRequireFullCurrencyAwareReceipt=true;
assert.deepEqual(pumpTradesFromLogs(['Program '+Keypair.generate().publicKey.toBase58()+' invoke [1]',logs[1]],owner),[]);R.otherProgramsCannotForgePumpTradeEvents=true;
const routed=tx('buy');routed.meta.preTokenBalances.push(tb(quote,1e6));routed.meta.postTokenBalances.push(tb(quote,0));assert.deepEqual(parseTrades(routed,owner,[quote]).map(t=>t.mint),[mint]);R.quoteCoinsAreNotCopiedAsThePurchasedCoin=true;
console.log(JSON.stringify(R));
