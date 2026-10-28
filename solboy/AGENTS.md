# SolBoy: notes for AI coding agents (Codex, ChatGPT, Claude)

SolBoy is a Solana meme coin copy-trading app for a non-technical owner. It runs on the owner's Mac (and a
friend's Windows PC, and optionally a Linux server). It copies the buys and sells of wallets the owner picks,
in paper (practice) or real-money mode, shows a game-style dashboard in the browser, and has a built-in
assistant ("Ask SolBoy") on a free Groq key. (AI research reports were removed in 1.3.0, and the Pulse trading terminal in 1.9.0: the owner uses Axiom for finding coins.) The owner talks in short,
casual messages; explain results in plain English, no jargon.

## Layout

- `src/main.js` entry point of the packaged app: a tiny launcher that runs SolBoy as a child process and
  starts it again when it exits with code 75 (that is how one-click updates restart it). `src/index.js`
  is the app itself.
- `src/bot.js` copy trading (detect a watched wallet's trade, copy it, take profit / stop loss, copy rules).
  `src/detect.js` turns a transaction (or a Pump.fun trade event in its logs) into buys and sells; `bot.js` reads Pump.fun bonding curves from the chain to price coins Jupiter can't route yet. `src/jupiter.js` swaps. `src/rpc.js` rate limiter.
- `src/finder.js` Wallet Finder (Finder tab): a coin's early buyers, a wallet's profile + PnL calendar, linked wallets,
  and a copy replay. Reads the chain on `rpc.js`'s background lane so copy trading always goes first; saves scans in `data/finder`.
- `src/share.js` Share Finder link: a Cloudflare quick tunnel (cloudflared downloaded into `tools/`, ssh to
  localhost.run as backup). `server.js` serves only `/g/<token>` (the guest Finder page, `src/guest.html`, assembled
  by `npm run embed` from the dashboard's Finder code) to anything arriving through a tunnel.
- `src/assistant.js` Ask SolBoy (tools only *propose* changes; the owner clicks Do it).
- `src/settings.js` settings that can change while running (Quick settings, assistant, terminal `tp`/`sl`).
- `src/server.js` dashboard HTTP server and API. `src/dashboard.html` the whole dashboard (one file),
  baked into `src/dashboard-html.js` by `npm run embed` (generated, don't edit; also writes `src/version.js`).
- `src/ui.js` terminal menu. `src/account.js` SolBoy wallet, deposit, withdraw, paper/real switch.
- `src/update.js` one-click updates from GitHub releases. `src/auth.js` + `src/websetup.js` online server mode.
- `src/positions.js`, `src/book.js`, `src/stats.js` positions, daily PnL, reset, stats.
- `packaging/` START HERE guides and the server installer. `scripts/package.sh` makes the download zips.
  `scripts/install-mac.sh` is the one-line Mac installer.

## Commands

- `npm ci` then `npm start` runs from source (asks setup questions; needs a Helius key to reach Solana).
- `npm run build` builds all five apps into `dist/` (needs Bun 1.4.4).
- `test/e2e/run-all.sh` end-to-end tests of the real packaged app against fake Solana/Jupiter/DexScreener/
  Pump.fun/X/Groq/GitHub servers, with Playwright and a pty. Needs Linux x64, Bun, Python 3 and
  `npm i --no-save playwright && npx playwright install chromium`. About 10 minutes. Prints PASS/FAIL per
  feature and exits non-zero on any failure. Add checks to `test/e2e/full.cjs` + `check.cjs` for new features.

## Releasing (this is how the owner gets changes)

1. Make the change. Run `test/e2e/run-all.sh` and get all checks passing.
2. Bump `"version"` in `package.json` (and run `npm install --package-lock-only`), and put plain-English
   notes for the owner at the top of `RELEASE_NOTES.md` (shown in the dashboard's Update window).
3. Push. The workflow `.github/workflows/solboy-release.yml` (in the repo root) builds every app and
   publishes the GitHub release `solboy-v<version>`. Every running SolBoy then shows a yellow Update button.

A new version number publishes to the owner and friends immediately, so only bump it for tested work.
Pushes without a version bump just check that the build works.

## Rules

- Never commit `.env`, `config.json`, `data/`, keys or seed phrases. Never ask the owner for a private key.
- Don't change the update source (`zero998k/Skully` releases, tag prefix `solboy-v`, asset names,
  `SHA256SUMS`) or the launcher's restart code 75: older installed copies depend on them.
- Settings, keys, wallets and trades live in files next to the app; updates must never touch them.
- Keep it free: no paid APIs by default. Groq is the free AI.
- Real money: the assistant must never switch real-money mode on, withdraw or reveal keys.
- Keep the style: matte black with bright hot pink (#ff2d95) accents (losses and sells stay red), cartoony sticker look on the dashboard; works on a phone.
