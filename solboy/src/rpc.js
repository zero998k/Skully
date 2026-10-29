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

  let urgentWaiting = 0; // copy-trading requests queued right now
  async function waitForSlot() {
    const now = Date.now();
    const start = Math.max(now, nextSlot, pausedUntil);
    nextSlot = start + gap;
    if (start > now) await sleep(start - now);
  }

  // Background work (wallet scans) only takes a free slot: it waits while copy trading has requests queued or the
  // next slot is already taken, so a scan never delays a copy by more than one request.
  async function waitForBackgroundSlot(signal) {
    for (;;) {
      const now = Date.now();
      if (!urgentWaiting && nextSlot <= now && pausedUntil <= now) {
        nextSlot = now + gap;
        return;
      }
      await sleep(Math.max(gap, 20));
      signal?.throwIfAborted();
    }
  }

  async function limitedFetch(url, init = {}, background = false) {
    // Include queue time and rate-limit backoff in the deadline; a stopped RPC cannot hold a token lock forever.
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
    const abortableWait = promise => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    for (let attempt = 0; ; attempt++) {
      if (background) await abortableWait(waitForBackgroundSlot(signal));
      else {
        urgentWaiting++;
        try {
          await abortableWait(waitForSlot());
        } finally {
          urgentWaiting--;
        }
      }
      signal.throwIfAborted();
      const res = await fetch(url, { ...init, signal });
      if (res.status !== 429 || attempt >= 3) return res;
      if (Date.now() - lastWarning > 30_000) {
        lastWarning = Date.now();
        log('Free RPC plan limit reached, slowing down for a moment. This is normal with busy wallets.');
      }
      pausedUntil = Math.max(pausedUntil, Date.now() + 1000 * 2 ** attempt);
    }
  }

  return { fetch: (url, init) => limitedFetch(url, init), backgroundFetch: (url, init) => limitedFetch(url, init, true) };
}
