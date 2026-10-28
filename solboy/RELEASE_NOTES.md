**New in 1.4.2: know what you're buying**
- **The story behind every coin:** each card shows the X post the coin came from (or the creator's description) right under its name. Hover over a coin's picture for a big preview with its story.
- **Story strip on every coin page:** the coin's picture, a one-line **✨ Story** of what the coin is about and where it comes from (written by your free Groq AI), the X post itself with who posted it, likes and its picture, the coin's website, and the creator's description.
- **More pictures load:** if the IPFS servers are slow, SolBoy now also asks Pump.fun directly for the coin's picture.

**New in 1.4.1: a smoother, fuller Pulse**
- **Moves smoothly, like Axiom:** cards update in place instead of redrawing, new coins slide in at the top while the others glide down, pictures never blink, and the board refreshes about 3 times a second. Coin pages no longer jump, reset your typed amount or lose your scroll spot.
- **Full columns straight away:** Final Stretch and Migrated fill as soon as SolBoy starts (from Pump.fun's own lists), and the board is saved so it's still full after a restart or update.
- **Coin pictures load:** SolBoy fetches each picture once through the fastest IPFS server and keeps it, instead of your browser waiting on slow servers.
- **Coin pages open instantly:** the page shows right away and fills in holders within a second or two. Coins SolBoy didn't watch from launch now show their recent buys and sells and a chart straight away.

**New in 1.4.0: Pulse, a trading terminal like Axiom**
- Click **📈 Pulse** on the dashboard: live **New Pairs**, **Final Stretch** and **Migrated** columns with every coin's age, socials, holders, volume, market cap and the top 10 / dev / snipers / insiders / bundlers percentages.
- **Axiom-style filters** on each column: keywords, launchpads, Audit, $ Metrics and Socials, with 3 presets and import/export/share.
- **Coin pages:** live chart, every buy and sell in real time, holders with % and profit, top traders, snipers and bundles (checked on the chain), dev's other coins, and an insider check.
- **Live, not delayed:** migrated coins you open get their price straight from the pool on the chain (every trade, about half a second) instead of DexScreener's ~20 seconds. The top bar shows how many milliseconds behind the chain the feed is, and each coin shows whether its price is live.
- **Polished look:** pulsing LIVE light, colour-coded columns, a bonding curve ring around each coin picture, market caps that flash green or red when they move, buys and sells that flash as they stream in, loading placeholders, smoother windows and toasts, and the coin's market cap in the browser tab. Shortcuts: **Q** opens the quick trade box, **/** searches, **Esc** closes things.
- **Quick trading:** ⚡ buy from any card, a buy/sell panel on each coin, and a floating trade box you can drag around or pop out. Works in paper mode and with real money.
- **Copy trading fixes:** several wallets buying at the same moment can no longer push you past your max open coins; a real-money buy of a brand-new coin can't trigger the stop loss by mistake while the chain catches up; very low slippage settings no longer make PumpPortal trades fail.

**New in 1.3.0**
- **Copying fixed for traders who keep a "moon bag":** SolBoy now sells when the wallet sells 90% or more. Before, a trader keeping a few % forever meant SolBoy never sold, your slots filled up, and new buys were skipped.
- **Fresh buys copied again:** a wallet holding a little dust from an old trade no longer counts as "adding more".
- **The dashboard tells you why a buy was skipped:** slots full, daily loss limit hit, or the trade loaded too slowly, with what to do about it.
- **AI narrative research removed** (Intel tab, Scan box and reports). Ask SolBoy still works and can look up any coin's live numbers. Tabs are now 1 History, 2 Wallets, 3 Loadout, 4 Account.

**New in 1.2.2**
- **Reset PnL now resets everything you see:** the big total, today's profit, win rate, streak, chart and wallet stats all go back to 0 (before, only today's number and the daily loss limit did). Your trade history is kept, and the daily loss limit refills.

**New in 1.2.1**
- **Scans fixed:** research requests are smaller, so they fit Groq's free limits, and if one free AI model says no, SolBoy automatically tries the next one. If a scan still fails, the dashboard now tells you why.
- **Reset PnL** is easy to find: a ↺ reset button right next to today's profit/loss (and under the HP bar). You can also ask SolBoy: "reset my pnl".

**Also in 1.2.0**
- **Straight-to-the-point research, like GMGN's AI overview:** every report now opens with *What it is*, *Why it's pumping* (or dumping) with the real numbers (price change, volume spike, buyers vs sellers, the X post behind it), and the *Biggest risk*. No more vague "maybe"s.
- **Copy only first buys:** when a wallet you copy adds more to a coin it already holds, SolBoy doesn't buy again.
- **Sell only when they're out:** SolBoy ignores partial sells and sells everything when the wallet fully sells out. Your take profit and stop loss still work. Both rules can be switched in Loadout → Quick settings.
- **Reset today:** a button under the HP bar (or type reset in the terminal) starts today's profit/loss from zero and refills your daily loss limit.

Downloads: **SolBoy-for-Mac.zip** (Mac), **SolBoy-for-Windows.zip** (Windows PC), **SolBoy-for-Server.zip** (24/7 online server). Already running SolBoy 1.1.1 or newer? Just click Update in the dashboard.
