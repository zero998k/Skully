# Speed checks

`run-all.sh` exercises the packaged app against a fake chain. It checks submission versus confirmation timing, both buys and sells, failure handling, and live screen updates while a slower full-state response is stalled.

To compare performance before and after a change, keep a baseline packaged binary and run:

```
node test/e2e/latency.cjs /absolute/path/to/baseline/SolBoy /absolute/path/to/before.json
node test/e2e/latency.cjs /absolute/path/to/new/SolBoy /absolute/path/to/after.json
node test/e2e/compare-latency.cjs /absolute/path/to/before.json /absolute/path/to/after.json
```

Use the same machine and round count (`BENCH_ROUNDS`, default 8) for both. These tests use isolated temporary folders, fixture keys, a separate dashboard port and fake services. Never point them at a public RPC or the owner's running app. The runner stops only its own processes.

The comparison checks both median and p95 timings with a small allowance for scheduling/GC noise. The fake-chain execution test is useful for regressions; it does **not** establish a mainnet speed guarantee. Standard log notifications do not tell us exactly how long delivery took before they reached SolBoy, and paper trades have no on-chain confirmation.
