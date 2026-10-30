import {randomUUID} from 'node:crypto';

const SOL=1_000_000_000n;
function startingLamports(raw){
  const value=String(raw??'').trim();
  if(!/^\d+(?:\.\d{1,9})?$/.test(value))throw new Error('Enter a paper balance in SOL, with at most 9 decimal places.');
  const [whole,fraction='']=value.split('.'),amount=BigInt(whole)*SOL+BigInt(fraction.padEnd(9,'0'));
  if(amount>1_000_000n*SOL)throw new Error('Choose a paper balance from 0 to 1,000,000 SOL.');
  return amount;
}

/** Local practice funds only. Existing installations remain unlimited until the owner chooses a balance. */
export function createPaperWallet(book){
  const reserved=new Map(),store=()=>book.positionsFor('paper'),cash=()=>store().data.paperWallet;
  const held=()=>[...reserved.values()].reduce((sum,r)=>sum+r.amount,0n);
  const available=()=>cash()?.enabled?BigInt(cash().availableLamports)-held():null;
  return {
    status(){const c=cash(),free=available();return {enabled:!!c?.enabled,startingSol:c?.enabled?Number(c.startingLamports)/1e9:null,
      availableSol:free==null?null:Number(free)/1e9,reservedSol:Number(held())/1e9,startedAt:c?.startedAt??null};},
    setStartingBalance(raw){
      if(book.mode!=='paper')throw new Error('Switch to Paper mode before changing practice funds.');
      if(book.isTrading?.()||reserved.size)throw new Error('Wait for the current trade to finish before changing paper funds.');
      if(store().count())throw new Error('Close your open paper positions before starting or resetting the paper balance. Your history will be kept.');
      const amount=raw===null?null:startingLamports(raw),before=store().data.paperWallet;
      store().data.paperWallet=amount==null?null:{enabled:true,startingLamports:String(amount),availableLamports:String(amount),startedAt:new Date().toISOString()};
      try{store().save();}catch(error){store().data.paperWallet=before;throw error;}
      return this.status();
    },
    canSpend(amount){const free=available();return free==null||free>=BigInt(amount);},
    reserve(amount){
      if(book.mode!=='paper')throw new Error('Practice funds cannot be used for real-money trades.');
      if(!cash()?.enabled)return null;
      amount=BigInt(amount);if(amount<=0n||!this.canSpend(amount))throw new Error(`Not enough paper SOL: ${this.status().availableSol.toFixed(4)} SOL available. Choose a smaller buy or reset practice funds when your positions are closed.`);
      const id=randomUUID();reserved.set(id,{amount});return id;
    },
    release(id){if(id)reserved.delete(id);},
    commitBuy(id,mint,pos,amount){
      if(book.mode!=='paper')throw new Error('Practice funds cannot be used for real-money trades.');
      if(!cash()?.enabled){store().open(mint,pos);return;}
      amount=BigInt(amount);if(!id||reserved.get(id)?.amount!==amount)throw new Error('Paper buy has no matching cash reservation.');
      store().settlePaper(mint,pos,-amount);reserved.delete(id);
    },
    settleSell(mint,pos,proceeds,pnl){
      if(book.mode!=='paper'||!cash()?.enabled)return false;
      store().settlePaper(mint,pos,BigInt(proceeds),pnl);return true;
    },
  };
}
