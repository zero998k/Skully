# SolBoy

Watches Solana wallets you choose. When one of them buys a token for SOL, the bot buys the same token for you. When they sell, it sells too.

It works on any exchange (Pump.fun, PumpSwap, Raydium, Meteora...) because it reads how the wallet's balances changed, then swaps through Jupiter.

**It starts in PAPER mode.** It pretends to trade, using real prices, and logs what it would have made or lost. No money moves until you switch it to live.

> ⚠️ Copy-trading meme coins loses money more often than not. You always buy after the wallet you copy, at a worse price. Some well-known wallets dump on purpose once copy bots pile in. Only use a **burner wallet** holding money you can afford to lose completely.

---

## How fast is it?

On the free setup, expect your trade to land **about 1–3 seconds after theirs**:

| Step | Roughly |
|---|---|
| Their trade confirms and your bot is told | 0.5–1 s |
| Bot reads the transaction and checks the token | 0.1–0.5 s |
| Jupiter prices the swap and builds it | 0.2–0.5 s |
| Your transaction lands on-chain | 0.5–1+ s |

The bot logs the delay on every trade (`~1.2s after their trade`), so you'll see your real numbers. To shave time:

- Set `skipIfMintAuthority` and `skipIfFreezeAuthority` to `false`. This skips the token check (~0.1–0.3 s) but removes a scam filter.
- Run it on a server instead of home Wi-Fi.
- Paid RPC plans are faster and have higher limits.

Under one second consistently needs paid infrastructure. Professional bots will usually still beat you.

---

## Setup (about 5 minutes)

1. Download the app for your computer and unzip it into its own folder, e.g. `Documents/CopyBot`. The bot saves its settings in that folder.
2. Double-click the app. The first time, it asks you:
   - **Your Helius API key.** Make a free account at <https://www.helius.dev> and copy the key from the dashboard. The app checks that it works.
   - **The wallets to copy.** Paste one per line, then press Enter on an empty line.
   - **SOL per trade.** Press Enter to use 0.05.
3. It starts in **paper mode** and watches the wallets. Leave the window open. Press **Ctrl+C** or close the window to stop.

From then on, double-clicking the app starts straight away.

**Windows** may say *"Windows protected your PC"*. Click **More info → Run anyway**. Some antivirus tools also flag apps they haven't seen before.

**Mac** may say the app *"can't be opened"* or that Apple can't check it. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to SolBoy. Then open it again.

Every trade is saved to `data/trades-paper.csv` in the app's folder. You can open it in Excel or Google Sheets.

### The dashboard (game mode)

When SolBoy starts, it opens a dashboard in your browser at **http://localhost:7777**. If you close the tab, type `d` in the terminal and press Enter to open it again. It runs on your Mac only; nobody else can see it.

| On screen | What it really means |
|---|---|
| **Score** | Total profit from closed trades |
| **HP bar** | How much of today's loss limit is left. At zero you're K.O.'d: SolBoy stops buying until tomorrow |
| **Accuracy** | Win rate |
| **Streak** | Wins (🔥) or losses (💀) in a row |
| **Level / XP** | Goes up every 10 closed trades |
| **Inventory** | Open positions, with **SELL NOW** and **CHART** buttons |
| **Kill feed** | Live activity. Filter it by trades, intel or alerts |
| **Power curve** | Your total profit over time. Hover to see each trade |
| **Intel** | AI research reports. Paste a token address and hit **SCAN** |
| **History / Wallets / Loadout** | Trade history, your wallets ranked by profit (add and remove them here) and settings. **Quick settings** in Loadout change take profit, stop loss, SOL per buy, daily loss limit, max tokens held and what AI research runs on. They work instantly, no restart |

**Buttons and keys:** **PAUSE COPYING** (or `P`) stops new buys while sells keep following the copied wallets. `S` toggles sound effects (off by default). `1`–`5` switch tabs, and `Esc` closes a report. The terminal keeps working as before, and trading speed is the same whether the dashboard is open or not.

To turn the dashboard off, set `"dashboard": { "enabled": false }` in `config.json`.

### Using the app

The window shows a menu at the top and live activity below it. Type a number and press **Enter**:

| Type | Screen | What you see |
|---|---|---|
| `1` | Open positions | Tokens you hold now: what you paid, what they're worth now, profit or loss |
| `2` | Trade history | Wins, losses, win rate, total profit, and your last 15 trades |
| `3` | Research reports | Every AI report, newest first. Type a report's number to read it |
| `4` | Wallet scoreboard | Each copied wallet's win rate and profit, best first, so you can drop the losers |
| `5` | Settings | Your settings in plain English, and where to change them |
| `account` | Account | Your SolBoy wallet address and balance |
| `tp 50` / `sl 25` | Take profit / stop loss | Sell everything at +50% / -25%. `tp off` or `sl off` turns it off. Works instantly |
| `m` | Menu | Shows the menu again |

Press **Enter** on any screen to go back. While a screen is open, new activity waits so it doesn't scroll over what you're reading. When you go back, it shows how many updates came in. To research any token, paste its token address (CA) and press Enter.

Buys show in green, sells in yellow. Profit is green and losses are red.

### Adding and removing wallets

Add as many as you like, any time, without restarting:

- **Dashboard:** click **+ Add wallet** (or press `A`), paste the address, optionally give it a nickname and its own SOL-per-trade, then click **Start copying**. It's saved for next time automatically.
- **Terminal:** type `add <address> <nickname>`, for example `add 5NU3oN4fNnx1CknHtaH8kGPHAaK4UJ3X4E2WdEyY3h1y whale2`.

To stop copying one, click **Remove** on the dashboard's **Wallets** tab, or type `remove <nickname>` in the terminal. If you still hold tokens you copied from it, SolBoy stops copying its new buys but keeps following its sells until those tokens are gone, then removes it completely. Changed your mind? Click **Undo** on that wallet.

Start with about 3–10 wallets on the free Helius plan, and use the Wallets tab to keep the winners and drop the losers.

### Changing settings later

Edit `config.json` in the app's folder with any text editor (Notepad or TextEdit), then restart the app. To add wallets, copy a line like this, and put a comma between entries:

```json
"wallets": [
  { "label": "whale1", "address": "WALLET_ADDRESS_1" },
  { "label": "whale2", "address": "WALLET_ADDRESS_2", "buyAmountSol": 0.1 }
]
```

`buyAmountSol` on a wallet is optional. It overrides the main amount for that wallet only. To run setup again from scratch, delete `config.json` and `.env`. On a Mac, `.env` is hidden: press Cmd+Shift+. to show it.

---

## Ask SolBoy (built-in AI assistant)

Click **Ask SolBoy** in the bottom corner of the dashboard (or press `/`). Ask anything:

- **Meme coins in general:** "What's trending on Solana?", "What is $WIF doing today?", "How do I spot a rug pull?", "What's a bonding curve?", "Is $40K liquidity on a $2M market cap bad?" It pulls **live market data** from DexScreener (free) whenever you ask about a specific coin or what's hot, and the answer shows a small 🔎 note when it did. The "trending" list is DexScreener's paid promotions, and SolBoy tells you so.
- **About your results:** "How am I doing?", "Which wallet should I drop?", "Why did my last trade lose?"
- **About trading:** "What's slippage?", "Is a 30% stop loss sensible for meme coins?"
- **To change things:** "Set a 30% stop loss", "Add 5NU3...h1y as whale3", "Pause copying", "Sell my $CATGPT"

The assistant sees your live SolBoy data, so it answers about *your* setup. When it suggests a change, a card shows exactly what will change, for example *Stop loss: off → -30%*. **Nothing happens until you click Do it.** It can't switch on real money, withdraw, or see your keys; those stay on the Account tab, under your control. Brand-new features need a new SolBoy version.

In the terminal, type `ask <your question>`.

**Choosing the brain** (the dropdown at the top of the panel):

| Brain | Smartness | Cost per question |
|---|---|---|
| Free (Groq) | Good for simple questions | $0, using your free Groq key |
| Claude Sonnet 5.5 | Very smart | ~1–3 cents |
| Claude Opus 5.5 | Excellent | ~2–6 cents |
| Claude Fable 5.1 | Anthropic's smartest | ~5–15 cents |

Claude models need your own Anthropic API key. Create one at <https://console.anthropic.com>, add a little credit (from $5), and paste the key into the assistant panel under "Want Claude-level smarts?". A claude.ai subscription can't be used here, because apps can only use Claude through an API key. Each friend uses their own key, so nobody pays for anyone else.

---

## Real money (optional)

Everything happens on the dashboard's **Account** tab (press `5`, or click the ◎ balance at the top).

1. **Create your SolBoy wallet.** Click **Create my SolBoy wallet**. It's a fresh wallet just for SolBoy, and its key is saved in `.env` next to the app, on your computer only.
2. **Deposit SOL.** Send SOL to the address shown, from Phantom, Solflare or an exchange, on the **Solana** network. Scan the QR code with Phantom on your phone, or click **Copy address**. A "Deposit received" alert pops up within about 30 seconds.
3. **Flip the switch to Real money.** Tick the box confirming you understand the risk. SolBoy won't switch until the wallet holds enough for at least one trade plus fees.
4. **Withdraw any time.** Paste your own Phantom address and an amount (or **Max**), then click **Withdraw**. Double-check the address: crypto transfers can't be undone.

Good to know:

- Paper and real-money trades are tracked separately. Switching back to Paper keeps your real-money positions for when you switch again.
- **Start small.** Only deposit what you're fine losing completely. Your daily loss limit (the HP bar) stops new buys after a bad day.
- **Back up / import into Phantom** shows the wallet's private key (type SHOW to reveal it). Anyone with that key can take the funds, so never share it, and never paste it into a website.
- **Never use your main wallet's key with SolBoy.** Use the SolBoy wallet and send it only what you want to trade.

---

## Run SolBoy online, 24/7, for free

SolBoy can run on a free Oracle Cloud server, so it keeps trading with your computer off. You use it through your own private HTTPS web address, with a password, from any browser, including your phone.

Download **SolBoy-for-Server.zip** and follow **START HERE (Server).txt** inside it (about 30 minutes, once). In short:

1. Make free Oracle Cloud and Tailscale accounts.
2. Create a free Ubuntu server.
3. Copy SolBoy to the server and run the installer. It sets SolBoy up to run all the time and restart itself.
4. Open your new `https://….ts.net` address, enter the setup code, and finish setup in the browser.

Online, SolBoy asks for your password to log in, and again for withdrawals, showing your key, and turning on real money. Run SolBoy in one place only: once the server works, close it on your computer.

---

## Sharing SolBoy with friends

SolBoy is free to share. Each friend runs their own copy, with their own free keys and their own SolBoy wallet. Nobody ever holds anyone else's money.

1. Send them the download for their computer: **SolBoy-Windows.zip** for Windows, or the Mac zip. The files are 40–55 MB, too big for a free Discord upload, so share them through Google Drive, Dropbox, WeTransfer or a GitHub release.
2. They unzip it, open the **START HERE** file, and follow the steps.
3. **Don't share your own folder.** Your `.env` holds your keys and wallet. Always share the fresh download.

**Windows note:** the first time, Windows may show "Windows protected your PC". Click **More info → Run anyway**. Some antivirus tools also flag new apps they haven't seen before. SolBoy isn't code-signed, because that costs money.

---

## Free AI token research (optional)

The moment a wallet you copy buys a token, AI writes a quick breakdown of it (at the same time as the copy, so it never slows the trade). That includes coins launched seconds ago:

- **AI overview (like GMGN's):** what the coin is, why it's pumping (or dumping) with the real numbers (price change, volume spike, buyers vs sellers, the post behind it), and the biggest risk. Straight to the point, no "maybe"s
- **Why now:** what triggered it
- **Imagery and audience:** the meme style and who's buying
- **Lifespan and copycat risk**
- **Red flags**
- **Bull vs bear verdict**

To research any token yourself, **paste its token address (CA) into the window and press Enter**. Use the token address, not a DexScreener pair link.

- **Free:** it uses Groq's free plan, with no credit card. Make an account at <https://console.groq.com/keys>, create an API key, and paste it when the app asks. Skipped it? Paste the key after `GROQ_API_KEY=` in `.env` and restart.
- **Free limits:** Groq's free plan has a daily cap, enough for many reports a day with a few wallets. If you hit it, SolBoy says so and research picks up again when it resets. Trading is never affected. To use less, set `on` to `"buys"` (below).
- **Speed:** Groq is one of the fastest AI services. Expect a full report in about 5–10 seconds, including 2–5 seconds to gather the token's data. Each report shows how long it took. It runs separately from trading and never slows a copy trade.
- **Saved:** reports go to `data/research/`, and to Telegram if you've set that up.
- **What it sees**, gathered at once in a few seconds:
  - **The X post the coin links to:** who posted it, what it says, likes and replies. This is often the whole narrative.
  - **Launchpad data** (Pump.fun): how many minutes old the coin is, market cap, bonding curve progress, replies.
  - **The creator's past coins:** how many they launched and how many went anywhere (serial launchers are a red flag).
  - **Copycats:** other tokens using the same ticker.
  - **The basics:** name, description, website, socials, DexScreener market data (price, liquidity, volume, buys and sells), and top holders.

  It can't scroll X or TikTok beyond the linked post. When it's guessing the trigger or audience, the line ends with "(inferred)". It's a quick read of the token, not a safety check.

Research settings live in `config.json` under `"research"`:

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `true` | `false` turns research off |
| `on` | `"detected"` | `"detected"` = every token a watched wallet buys, the moment they buy, even ones SolBoy skips. `"buys"` = only tokens SolBoy itself buys (uses your free limit slower). You can also switch this in the Loadout tab |
| `provider` | `"groq"` | `"groq"` (free, fastest), `"gemini"` (Google's free plan: key from <https://aistudio.google.com/apikey>, goes after `GEMINI_API_KEY=` in `.env`; lower free limits), or `"anthropic"` (Claude: paid, about 2–3 cents per report, needs `ANTHROPIC_API_KEY=` in `.env`) |
| `model` | `"auto"` | `"auto"` picks the best model the provider currently offers. You can name a specific model instead |
| `effort` | `"low"` | Only used with `"anthropic"`: `low`, `medium` or `high` |

---

## Settings (`config.json`)

The most-used ones (take profit, stop loss, SOL per buy, daily loss limit, max tokens held) are easiest to change in the dashboard: **Loadout tab → Quick settings → Save**. They work straight away. For everything else, edit `config.json` and restart SolBoy.

| Setting | Default | What it does |
|---|---|---|
| `dryRun` | `true` | `true` = paper trading, `false` = real money. Easier: use the switch on the Account tab |
| `wallets` | — | Wallets to copy (see step 4) |
| `buyAmountSol` | `0.05` | SOL to spend on each copied buy |
| `minSourceBuySol` | `0.1` | Ignore their buys smaller than this, often tests or dust |
| `maxOpenPositions` | `5` | Stop buying new tokens while holding this many |
| `buySlippageBps` | `1500` | Max price slippage on buys. 100 = 1%, so 1500 = 15% |
| `sellSlippageBps` | `2000` | Max slippage on sells (20%). Higher so sells don't fail when the price is crashing |
| `priorityFeeMaxLamports` | `1000000` | Most you'll pay in priority fee per trade (1,000,000 = 0.001 SOL). Higher lands faster |
| `followSells` | `true` | Sell when the copied wallet sells |
| `sellMode` | `"mirror"` | `"mirror"` = sell the same % they sold. `"all"` = sell everything when they sell anything |
| `takeProfitPct` | `null` | e.g. `100` = sell everything once you're up 100%. `null` = off |
| `stopLossPct` | `null` | e.g. `40` = sell everything once you're down 40%. `null` = off |
| `priceCheckSeconds` | `20` | How often to check take-profit and stop-loss |
| `dailyLossLimitSol` | `0.5` | Stop *buying* for the rest of the day (UTC) after losing this much. Sells still happen |
| `skipIfMintAuthority` | `true` | Skip tokens whose creator can still print more |
| `skipIfFreezeAuthority` | `true` | Skip tokens whose creator can freeze your tokens (a common honeypot trick) |
| `blocklist` | `[]` | Token addresses never to buy |
| `rpcRequestsPerSecond` | `8` | How fast the bot may ask Helius for data. The free plan allows about 10 per second. Lower it if you still see "limit reached" often |
| `maxCopyDelaySeconds` | `15` | Skip copying a buy if it took longer than this to load, because the price has likely moved. Sells are always copied |
| `research` | see above | AI token research settings |

If two of your wallets buy the same token, the bot only buys once. It then follows the sells of the wallet it copied first.

---

## Free-tier limits

- **How many wallets?** A handful (roughly 3–10) is comfortable on the free Helius plan. Very active wallets that trade constantly use more of your free requests. If you see `429` or "rate limit" errors, watch fewer wallets or raise `priceCheckSeconds`.
- **Jupiter** is free without a key. If quotes start failing with `401`/`403`, get a free key at <https://portal.jup.ag> and paste it after `JUPITER_API_KEY=` in `.env`.
- **Fees** still cost real SOL in live mode: the network fee, the priority fee, and the exchange's own fee (around 1% each way on Pump.fun). On tiny trades, fees can wipe out the gain.

## Optional: Telegram alerts

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token it gives you into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. Copy the `"chat":{"id": ...}` number into `TELEGRAM_CHAT_ID`.
3. Restart the bot. You'll get a message on every buy and sell.

## Keeping it running

While SolBoy is open, it **keeps your computer from going to sleep on its own**, so it can trade all day and night. It uses features built into macOS and Windows, with nothing to install.

- The screen can still turn off and lock. SolBoy keeps trading.
- It only stops if you shut down, restart, choose Sleep yourself, or close SolBoy. Once SolBoy closes, normal sleep comes back automatically.
- **MacBooks: closing the lid always puts the Mac to sleep** (Apple doesn't let apps override that). Leave the lid open and let the screen turn off. Being plugged in is best.
- Windows desktops stay awake fully while SolBoy runs.
- To turn this off, set `"keepAwake": false` in `config.json`.

If SolBoy stops (you closed it, or the computer restarted), open it again. Your positions are saved in `data/` and it picks up where it left off, though it won't see trades that happened while it was closed.

## Updating SolBoy

When a new version is out, a yellow **⬆ Update** button appears at the top of the dashboard (and the terminal says so). Click it, then **Update now**. SolBoy downloads the new version, checks that it's intact and starts on your computer, swaps itself out, and the page reloads by itself, usually within a minute. In the terminal you can type `update` instead.

- **Nothing to redo:** your keys, wallets, settings, positions and trades live in separate files next to the app (`.env`, `config.json`, `data/`), and updating never touches them.
- **Safe:** if the download is damaged or the new version won't start, nothing changes.
- **Where updates come from:** releases of the public GitHub repo [zero998k/Skully](https://github.com/zero998k/Skully/releases). The download zips are there too, for friends setting up for the first time. Anyone who controls that GitHub account controls what SolBoy installs, so keep it secure (turn on two-factor login).
- The online server version updates the same way, from its dashboard.

## Troubleshooting

| Message | Fix |
|---|---|
| `Couldn't reach Solana` | Check your internet. If the Helius key changed, delete `.env` and restart to enter it again |
| `isn't valid JSON` | A missing comma or quote in `config.json`. Every line in a list except the last needs a comma |
| `failed on-chain (often slippage)` | The price moved too fast. Raise `buySlippageBps`, or accept you missed it |
| `skip: creator can freeze holders' tokens` | The safety filter working as intended |
| `Free RPC plan limit reached, slowing down` | Normal now and then with busy wallets. If it shows constantly, watch fewer or less hyperactive wallets, or lower `rpcRequestsPerSecond` |
| Nothing happens | The wallets haven't traded yet. Check them on solscan.io |

---

## Running from source (optional, for developers)

Needs Node.js 18+: `npm install`, then `npm start`. Setup and settings work the same, using the current folder.
`npm run build` rebuilds the Windows/Mac/Linux apps into `dist/` (needs [Bun](https://bun.sh)).
