# Scout for iPad

A web app for the iPad: check a coin before you buy, plan the trade from your own rules, and get told when your plan says sell. You still buy and sell in Axiom. Scout reads public data only; it never trades and never connects to a wallet.

It lives in the `docs/` folder and is published by GitHub Pages at `https://zero998k.github.io/Skully/` once Pages is switched on. The Streamlit app in the repository root (`app.py`) is separate and unchanged.

## Switch it on (once)

1. On github.com, open this repository, then **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Pick the branch `claude/optimistic-dirac-wpykfb` and the folder `/docs`, then **Save**.
4. After a minute or two the page says **Your site is live at …**. That's the link.

## Put it on the iPad

1. Open the link in Safari.
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. From now on open Scout from its Home Screen icon. Safari tabs keep a separate journal.

## Updates

Every push to the branch above republishes the site within a minute or two. Scout checks for a new version when it opens and every 30 minutes, and shows an **Update now** banner. There is nothing to download or install.

## How it works

| Step | Screen | What happens |
| --- | --- | --- |
| 1 Find | Trade | Paste a CA or a DexScreener, Axiom or pump.fun link, or tap a coin on Radar. |
| 2 Check | Trade | Every rule of the chosen strategy is checked and explained: contract scan, developer and holders, money in the pool, chart and trading, fit and costs. Verdict: skip, doesn't fit, careful, or fits. |
| 3 Plan | Trade | Size from your risk rules (bankroll, risk per trade, biggest trade, today's loss room), target, stop, trailing stop, time limit, fees, and the win rate you'd need. |
| 4 Buy | Trade | You buy in Axiom, then log what you paid. Breaking a rule needs a written reason. |
| 5 Watch | Live | Price every 8 seconds, a price ladder and chart, and a full-screen alarm when the plan says sell (stop, trailing stop, target, time). |
| 6 Review | Journal | Result after fees, rule breaks, lessons, today's debrief, and plan-followed vs plan-broken results. |

- `docs/core.js`: the rules. Same strategies and math as the Mac Scout (`coach.py`, `trade_session.py`, `autopaper.py` in zero998k/skull-base).
- `docs/data.js`: DexScreener for prices and pools, RugCheck (Solana) and GoPlus (other chains) for contract scans, GeckoTerminal for Radar, candles, and as the backup when DexScreener can't be reached. A scan that can't be reached counts as unknown, never as safe.
- `docs/app.js`, `docs/app.css`, `docs/index.html`: the screens.
- What you log stays in the browser on that iPad (`localStorage` key `scout-ipad-v1`). The Rules page has backup and restore.
- Alerts only work while Scout is on screen: iPadOS pauses web apps in the background. When Scout comes back it fills the gap from one-minute candles and says if your stop was crossed while it was paused.

## Releasing a change

Bump the version in three places together (a test checks they match): `VERSION` in `docs/app.js`, `docs/version.json`, and the `?v=` on the four asset links in `docs/index.html`.

## Tests

```sh
node --test "scout-ipad-tests/*.test.cjs"          # rules, parity with the Mac Scout, release checks
node scout-ipad-tests/ui-smoke.cjs [screenshot-dir]  # clicks through every screen in Chromium with made-up data (needs Playwright)
```

GitHub Actions runs both on every push that touches `docs/` or the tests.
