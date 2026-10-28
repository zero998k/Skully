**New in 1.10.2**
- **⟳ Check for updates** button at the top: checks right away and, if there's a new version, opens the Update window. SolBoy also checks by itself every 15 minutes now (it used to be every 6 hours), so the yellow Update button shows up much sooner for you and your friends.

**New in 1.10.1: faster trade updates and clearer speed readings**
- Pump.fun confirmation checks start sooner, with fewer network requests. Recently unavailable sell routes avoid repeated quote requests while a fresh Pump.fun curve is available.
- Completed buys and sells appear immediately while prices and balances refresh. Speed readings now cover buys and sells, distinguish sent from confirmed, and clearly label practice trades.
- Updated the free Jupiter connection so it keeps working on the current service.

**New in 1.10.0: Social Lobby and Hypothetical PnL**
- **🧮 Hypothetical PnL** (button at the top): every copy SolBoy made, with what you actually made, what you'd have made if you'd sold exactly when the wallet sold, and what you'd have if you still held it. Type an amount in "What if every copy was __ SOL" to see it at a different size.
- **💬 Social Lobby** (button at the top): chat with friends. Pick your username, then share your link (🔗 Share Finder). Friends open it, tap **💬 Social Lobby**, and join with a username and password.
  - **Profiles:** profile picture, banner, bio and name color, plus online dots and "last seen".
  - **Chat:** a group Lounge and private messages, with reactions 🔥🚀😂💀👀💎 and unread counts on the button.
  - **📣 Calls board:** post a coin you think will run, and SolBoy tracks how much it moved since your call, with a leaderboard.
  - **Share to the Lobby** from the Finder (a wallet or a coin), and **📈 Flex PnL** to post your SolBoy results.
  - **You're the host 👑:** you can remove members and delete any message.
  - **Matrix look:** glowing green terminal style on black.
  - The Lobby lives on your computer, so it's open while your SolBoy is running. When the link changes, friends log in again with the same username and password and keep their profile.

**New in 1.9.2**
- **Share the Wallet Finder with a link:** click **🔗 Share Finder**, then **Make a link**, and send it to a friend. They open it in any browser, Windows included, with nothing to download, and get the Wallet Finder only (none of your trades, wallet, keys or settings). It works while SolBoy is running on your computer; **Stop sharing** or closing SolBoy turns it off.

**New in 1.9.1**
- **Coin scans in under 15 seconds:** the Finder reads a coin's early trades in parallel and checks every buyer's holdings in one go. On a very busy coin it stops going back after a few seconds and shows the earliest trades it reached (it tells you when that happens). If your Helius plan has the "oldest first" lookup, SolBoy uses it and jumps straight to the launch. The time each scan took shows next to the coin.

**New in 1.9.0: Wallet Finder**
- **Find the wallets behind coins that ran:** open the new **Finder** tab (key 5) and paste one or more coins from Axiom. SolBoy lists each coin's early buyers with what they spent, the market cap they got in at, what they sold, and their profit, tagged dev / bundle / sniper. Paste several coins and it shows the wallets that were early **and** in profit on more than one of them.
- **Full wallet profile:** click **Profile** on any wallet (or paste a wallet) to see its net worth, SOL balance and every coin it holds with values, win rate, profit for 7 / 30 days and overall, typical hold time and entry market cap, trading style, a "good to copy?" verdict, best and worst trades, and every coin it traded.
- **PnL calendar for each wallet you check:** a month view with green and red days showing how much that wallet made or lost each day. Use ◀ ▶ to go back through the months.
- **Possibly linked wallets:** wallets that sent it money, were paid by the same wallet that funded it, or kept buying the same coins in the same block, each marked high / medium / low with the reasons. Exchanges are left out.
- **What if I'd copied it?** Replays its last 7 or 30 days with your settings and shows what you'd have made, with its own calendar.
- **Copy this wallet** in one click.
- **Pulse removed:** SolBoy is back to doing one thing really well, copy trading. Use Axiom (or any terminal) for finding coins.
- **Copy trading prices brand-new Pump.fun coins on its own:** it reads the coin's bonding curve straight from the chain, so paper trades, take profit and stop loss work on coins Jupiter can't price yet.

**New in 1.8.0**
- **Same coins as Axiom with "Pump" ticked:** a Pump.fun coin that graduated now stays in Migrated when you filter to Pump only (before, it was hidden because it trades on PumpSwap after graduating).
- **Set where Final Stretch starts:** Pulse → ⚙ → "Final Stretch starts at this bonding curve %" (45% by default).
- **Scrolling fixed everywhere:** the Pulse columns, the filter window (every section reachable now) and the coin page scroll properly on laptop screens.
- **Animated risk gauges:** top 10, dev, snipers, insiders and bundlers are rings that fill to the percentage around their own icon, glide when the number moves, turn yellow then red as it gets risky, and pulse red when it's dangerous.
- **Pictures and stories load faster:** a coin's picture and socials start loading the moment it launches, the fastest picture servers are remembered and asked first, the coin's own description or X post shows instantly on its page while the AI writes, the AI uses Groq's fastest model, and hovering a coin preloads its page and story.

**New in 1.7.0: Axiom-style trading box and coin details**
- **New quick trade box (side panel, floating box and pop-out):** presets **P1 / P2 / P3**, four one-click **Buy** buttons (in SOL, or flip to **USD**), one-click **Sell** by SOL amount or by %, **Sell Init.** (sells just enough to get your money back), slippage and priority fee per preset (⚙), ✎ to change any button, your wallet balance, and **Bought / Sold / Holding / PnL** at the bottom.
- **Holders, Top Traders and Snipers & Bundles in full detail:** each wallet's SOL balance, what it bought and sold (in $, tokens, number of trades and the average market cap it bought / sold at), unrealized PnL, what it still holds ($, % and a bar), **fees paid**, who funded it, and how long it has held.
- **Fees on every trade** in the Trades tab, and dev tokens now show market cap, ATH, curve progress and age.
- **Chart markers:** dev buys and sells (DB/DS), snipers and bundlers (SB/SS), your KOL wallets (KB/KS) and whale trades 🐳, with a Markers switch.
- Fees are estimates: the exchange fee on what was traded plus network fees (priority tips aren't in the live feed).

**New in 1.6.0: a fuller, more finished Pulse**
- **Pictures and X posts for far more coins:** coins SolBoy didn't see launch (and every migrated coin) now get their picture, name and X post too. When the IPFS picture servers fail, SolBoy asks your Helius key for its fast copy of the picture, and your browser also tries the picture directly.
- **Charts and trades for older coins:** when GeckoTerminal has nothing, SolBoy reads the coin's latest trades straight from the chain with your Helius key and draws the chart from them.
- **Always warm:** SolBoy now follows up to 2,500 coins' trades from their launch and saves the board (with dev, sniper and bundler tags) across restarts, so Final Stretch and Migrated fill with full numbers. Leave SolBoy running and it gets better and better.
- **✨ Quality switch on every column:** hides coins with no socials, a dev who sold, or heavy bundling / top-10 ownership.
- **Coin page:** 5m / 1h / 6h / 24h price change, volume and buys vs sells with a buy/sell bar; mint and freeze authority check; age; 15m and 1h chart; 🐳 / 🐬 / 🐟 size on every trade.
- **See the feed working:** the top bar shows trades per minute, and the 📡 Live data check now also tests Helius coin details and warns if trades aren't arriving.

**New in 1.5.0: faster copying, wallet switches, fuller Pulse**
- **Copies Pump.fun trades much faster:** SolBoy now hears a wallet's trade at the earliest moment the network reports it, reads Pump.fun trades straight from the notification (no download), buys straight on the coin's curve, and runs its checks at the same time instead of one by one. The dashboard shows **⚡ how long each copy took**, from their trade to your order going out.
- **Switch copying on or off per wallet:** Wallets tab → click **Copying / Off** next to any wallet. Switched-off wallets aren't copied, but their sells still follow for coins you already hold from them.
- **Pause and sell everything:** pausing with coins open asks whether to just pause or **pause and sell everything**. Dead coins nobody will buy any more are cleared from your slots.
- **Final Stretch and Migrated fill up:** coins that graduate now always get their name and show up, and if Pump.fun's lists don't answer, SolBoy fills the columns from GeckoTerminal's free lists.
- **Slim story line like Axiom:** a coin's story is now one line under its header (✨ one-sentence story, the X post and website as small chips). Click **more** for the full X post and details.

**New in 1.4.3**
- **📡 Live data check:** in Pulse, click ⚙ (top right) → **Check now**. SolBoy tests every source it uses on real coins from your computer (live feed, Pump.fun, coin pictures, X posts, charts, prices, your Solana connection and the AI story) and shows a ✓ or ✗ for each.
- **Tidier coin cards:** the X handle no longer shows twice, and the X post's picture on a coin page is a neat thumbnail.
- **Works on a phone:** the top bar now fits small screens, and the story strip isn't cut off.

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
