// Jupiter finds the best route for a swap on any Solana exchange.
// The current api.jup.ag endpoint supports keyless access; a free JUPITER_API_KEY raises its rate limit.

function settings() {
  const key = process.env.JUPITER_API_KEY?.trim();
  const base =
    process.env.JUPITER_API_URL?.trim() ||
    'https://api.jup.ag/swap/v1';
  const headers = { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) };
  return { base, headers };
}

const requestTimes=[];
let backgroundPausedUntil=0;
function noteRequest(background=false){
  const now=Date.now();while(requestTimes.length&&requestTimes[0]<=now-60_000)requestTimes.shift();
  requestTimes.push(now);
}
export function backgroundPriceReady(){
  const now=Date.now();while(requestTimes.length&&requestTimes[0]<=now-60_000)requestTimes.shift();
  const limit=process.env.JUPITER_API_KEY?.trim()?60:30;
  // Quotes, swaps and prices share the service's quota. Leave 20% for actual trading,
  // while the copy engine separately yields to in-flight trades. Foreground requests never wait here.
  return now>=backgroundPausedUntil&&requestTimes.length<Math.floor(limit*.8);
}

export async function getQuote({ inputMint, outputMint, amount, slippageBps, signal, background=false }) {
  if(background&&!backgroundPriceReady())throw Object.assign(new Error('Price refresh waiting for free capacity'),{retryAfterMs:2100});
  const { base, headers } = settings();
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
  });
  noteRequest(background);
  const res = await fetch(`${base}/quote?${params}`, { headers, signal: signal ?? AbortSignal.timeout(10_000) });
  if (!res.ok) throw await serviceError(res, 'quote');
  const quote = await res.json();
  if (!quote.outAmount) throw new Error(`Jupiter found no route: ${JSON.stringify(quote)}`);
  if(!/^\d+$/.test(String(quote.outAmount))||BigInt(quote.outAmount)<=0n)throw new Error('Jupiter returned an invalid output amount');
  if((quote.inputMint&&quote.inputMint!==inputMint)||(quote.outputMint&&quote.outputMint!==outputMint)||(quote.inAmount&&String(quote.inAmount)!==String(amount)))throw new Error('Jupiter quote does not match this token and trade amount');
  return quote;
}

async function serviceError(res, name) {
  const error = new Error(`Jupiter ${name} failed (${res.status}): ${await res.text()}`);
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
    const retry = Number(res.headers.get('retry-after')) * 1000;
    error.retryAfterMs = Math.max(5000, Number.isFinite(reset) ? reset : 0, Number.isFinite(retry) ? retry : 0);
    backgroundPausedUntil=Math.max(backgroundPausedUntil,Date.now()+error.retryAfterMs);
  }
  return error;
}

// A single reference-price request covers every open coin and its quote currency. This shares
// the tracker's background request budget with sell quotes; copying never waits for it.
export async function getMarketPrices(mints, signal) {
  if(!backgroundPriceReady())throw Object.assign(new Error('Price refresh waiting for free capacity'),{retryAfterMs:2100});
  const { base, headers } = settings();
  const url = new URL('/price/v3', base);
  url.searchParams.set('ids', [...new Set(mints)].slice(0, 50).join(','));
  noteRequest(true);
  const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(4000) });
  if (!res.ok) throw await serviceError(res, 'prices');
  return res.json();
}

/** Returns { swapTransaction (base64), lastValidBlockHeight } ready to sign. */
export async function buildSwap(quote, userPublicKey, maxPriorityLamports) {
  const { base, headers } = settings();
  noteRequest();
  const res = await fetch(`${base}/swap`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers,
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: maxPriorityLamports, priorityLevel: 'veryHigh' },
      },
    }),
  });
  if (!res.ok) throw await serviceError(res, 'swap');
  const body = await res.json();
  if (!body.swapTransaction) throw new Error(`Jupiter swap failed: ${JSON.stringify(body)}`);
  return body;
}
