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

export async function getQuote({ inputMint, outputMint, amount, slippageBps }) {
  const { base, headers } = settings();
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
  });
  const res = await fetch(`${base}/quote?${params}`, { headers });
  if (!res.ok) throw new Error(`Jupiter quote failed (${res.status}): ${await res.text()}`);
  const quote = await res.json();
  if (!quote.outAmount) throw new Error(`Jupiter found no route: ${JSON.stringify(quote)}`);
  return quote;
}

/** Returns { swapTransaction (base64), lastValidBlockHeight } ready to sign. */
export async function buildSwap(quote, userPublicKey, maxPriorityLamports) {
  const { base, headers } = settings();
  const res = await fetch(`${base}/swap`, {
    method: 'POST',
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
  if (!res.ok) throw new Error(`Jupiter swap failed (${res.status}): ${await res.text()}`);
  const body = await res.json();
  if (!body.swapTransaction) throw new Error(`Jupiter swap failed: ${JSON.stringify(body)}`);
  return body;
}
