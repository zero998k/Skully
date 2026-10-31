import { log } from './log.js';

/**
 * Paces requests to the RPC so a free plan isn't flooded. Requests are spaced evenly at
 * `requestsPerSecond`; if the RPC still answers 429 (too many requests), everything pauses
 * briefly and the request is retried, with one short notice instead of a wall of errors.
 */
export function createRpcLimiter(requestsPerSecond) {
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) throw new Error('RPC requests per second must be a finite number above zero.');
  const gap = 1000 / requestsPerSecond;
  let nextSlot = 0;
  let pausedUntil = 0;
  let lastWarning = 0;

  const waiting = [];
  let timer = null;
  // Reserve only the slot actually being used. Cancelled requests leave no future
  // reservations, and a new 429 pause also applies to requests already in the queue.
  function dispatch() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!waiting.length) return;
    const delay = Math.max(nextSlot, pausedUntil) - Date.now();
    if (delay > 0) { timer = setTimeout(dispatch, delay); return; }
    const urgent = waiting.findIndex(item => !item.background);
    const item = waiting.splice(urgent < 0 ? 0 : urgent, 1)[0];
    item.signal.removeEventListener('abort', item.abort);
    if (item.signal.aborted) item.reject(item.signal.reason);
    else { nextSlot = Date.now() + gap; item.resolve(); }
    dispatch();
  }
  function waitForSlot(signal, background) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const item = { signal, background, resolve, reject, abort: null };
      item.abort = () => {
        const index = waiting.indexOf(item);
        if (index >= 0) waiting.splice(index, 1);
        signal.removeEventListener('abort', item.abort);
        reject(signal.reason);
        dispatch();
      };
      signal.addEventListener('abort', item.abort, { once: true });
      waiting.push(item);
      dispatch();
    });
  }

  async function limitedFetch(url, init = {}, background = false) {
    // Include queue time and rate-limit backoff in the deadline; a stopped RPC cannot hold a token lock forever.
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
    for (let attempt = 0; ; attempt++) {
      await waitForSlot(signal, background);
      signal.throwIfAborted();
      const res = await fetch(url, { ...init, signal });
      if (res.status !== 429) return res;
      if (Date.now() - lastWarning > 30_000) {
        lastWarning = Date.now();
        log('RPC plan limit reached. Copying may be delayed; trading requests have priority over background checks.');
      }
      const header = res.headers.get('retry-after');
      const retryAfter = header == null ? 0 : Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now();
      pausedUntil = Math.max(pausedUntil, Date.now() + Math.max(1000 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter : 0));
      dispatch();
      if (attempt >= 3) return res;
    }
  }

  return { fetch: (url, init) => limitedFetch(url, init), backgroundFetch: (url, init) => limitedFetch(url, init, true) };
}
