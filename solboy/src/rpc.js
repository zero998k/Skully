import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Paces requests to the RPC so a free plan isn't flooded. Requests are spaced evenly at
 * `requestsPerSecond`; if the RPC still answers 429 (too many requests), everything pauses
 * briefly and the request is retried, with one short notice instead of a wall of errors.
 */
export function createRpcLimiter(requestsPerSecond) {
  const gap = 1000 / requestsPerSecond;
  let nextSlot = 0;
  let pausedUntil = 0;
  let lastWarning = 0;

  async function waitForSlot() {
    const now = Date.now();
    const start = Math.max(now, nextSlot, pausedUntil);
    nextSlot = start + gap;
    if (start > now) await sleep(start - now);
  }

  async function limitedFetch(url, init) {
    for (let attempt = 0; ; attempt++) {
      await waitForSlot();
      const res = await fetch(url, init);
      if (res.status !== 429 || attempt >= 3) return res;
      if (Date.now() - lastWarning > 30_000) {
        lastWarning = Date.now();
        log('Free RPC plan limit reached, slowing down for a moment. This is normal with busy wallets.');
      }
      pausedUntil = Math.max(pausedUntil, Date.now() + 1000 * 2 ** attempt);
    }
  }

  return { fetch: limitedFetch };
}
