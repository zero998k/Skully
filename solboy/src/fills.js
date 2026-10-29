import { WSOL } from './detect.js';

/** A fill is this transaction's changes, never a quote or the wallet's balance across other trades. */
export function transactionFill(tx, owner, mint, side) {
  if (!tx?.meta) return null;
  const meta=tx.meta;
  if (meta.err) throw Object.assign(new Error('Transaction failed on-chain'),{onChainFailure:true});
  const msg=tx.transaction?.message??{},keys=(msg.accountKeys??msg.staticAccountKeys??[]).map(k=>String(k.pubkey??k));
  if(keys.length<meta.preBalances.length&&meta.loadedAddresses)keys.push(...(meta.loadedAddresses.writable??[]),...(meta.loadedAddresses.readonly??[]));
  const index=keys.indexOf(owner);if(index<0)return null;
  const total=(list,m)=>(list??[]).filter(b=>b.owner===owner&&b.mint===m).reduce((n,b)=>n+BigInt(b.uiTokenAmount.amount),0n);
  const tokens=total(meta.postTokenBalances,mint)-total(meta.preTokenBalances,mint);
  const sol=BigInt(meta.postBalances[index])-BigInt(meta.preBalances[index])+total(meta.postTokenBalances,WSOL)-total(meta.preTokenBalances,WSOL);
  if(side==='buy'&&(tokens<=0n||sol>=0n)||side==='sell'&&tokens>=0n)return null;
  return {tokensRaw:tokens<0n?-tokens:tokens,solRaw:side==='buy'?-sol:sol,feeRaw:BigInt(index===0?meta.fee??0:0)};
}
