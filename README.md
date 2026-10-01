# 💀 Skully

Two things live here:

- **Skully Discord bot** (`bot/`): a smart AI for your Discord server. It costs nothing to run.
- **Skully Meme Coin Radar** (`app.py`): the Streamlit dashboard (`pip install -r requirements.txt`, then `streamlit run app.py`).

## What the bot can do

- **Chat like a smart friend.** It reads the recent messages in the channel, so it follows the conversation and knows who said what.
- **Search the web and read links.** It looks up news, scores, releases and other current info instead of guessing, and cites its sources.
- **See images.** Attach a screenshot, chart or meme and ask about it.
- **Read files.** Attach code or text files (`.py`, `.js`, `.txt`, `.json`, ...) for reviews, bug hunting or explanations.
- **Do exact math** with a real calculator, not mental arithmetic.
- **Check live crypto data:** prices, 24h change, volume and market cap, plus the same *Skully signal* the radar uses. Also the Fear & Greed index and trending coins.
- **Remember things** like birthdays, favourite coins and plans, even after a restart.
- **Summarize** what you missed in a channel.
- **Never go silent on rate limits.** When one free AI model hits its limit, the next one answers.

### Talking to it

| How | Example |
|---|---|
| Mention it | `@Skully who won the Champions League final?` |
| Start with its name | `skully, explain this error` |
| Reply to one of its messages | *(just reply)* |
| DM it | *(message the bot directly)* |
| `/autochat enabled:True` | It answers **every** message in that channel |

### Slash commands

`/ask` (optionally with an image, or private) · `/price btc, pepe, bonk` · `/market` · `/summarize` · `/remember` · `/memories` · `/forget` · `/reset` (forget this channel's conversation) · `/autochat` · `/status` (which AI is answering) · `/help`

---

## Setup (about 10 minutes, all free)

### 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications>, click **New Application**, and name it `Skully`.
2. Open the **Bot** tab:
   - Click **Reset Token**, then **copy** the token. This is your `DISCORD_TOKEN`. Keep it secret: anyone with it controls your bot.
   - Scroll to **Privileged Gateway Intents**, turn on **Message Content Intent**, and click **Save**.
3. (Optional) On the **General Information** tab, give it a skull avatar 💀.

### 2. Get a free AI key

- **Google Gemini (recommended):** the smartest free option, and it can see images. Go to <https://aistudio.google.com/apikey>, then **Create API key**, then copy it.
- **Backups (optional, also free):** if you add these, the bot switches over automatically when Gemini hits its free limit:
  - Groq: <https://console.groq.com/keys>
  - OpenRouter: <https://openrouter.ai/keys>

### 3. Install and run

You need **Python 3.10 or newer** (<https://www.python.org/downloads/>; on Windows, tick *"Add Python to PATH"*).

```bash
git clone https://github.com/zero998k/Skully.git
cd Skully
pip install -r requirements-bot.txt
cp .env.example .env        # Windows: copy .env.example .env
```

Open `.env` in any text editor and paste in your keys:

```
DISCORD_TOKEN=your-bot-token
GEMINI_API_KEY=your-gemini-key
```

Start it:

```bash
python -m bot
```

The console prints a line like `Invite me to a server with: https://discord.com/oauth2/authorize?...`. Open that link, pick your server, and click **Authorize**. Then say `@Skully hi` 🎉

### 4. Keep it online

The bot only runs while `python -m bot` is running. To keep it up 24/7 for free, you can:

- **Leave it running** on a computer that stays on (an old laptop or a Raspberry Pi works great).
- **Use a free cloud VM** (several cloud providers have "always free" or free-tier small VMs). Copy the folder over, then run it with `nohup python -m bot &`, or set it up as a service so it restarts on reboot.

The bot keeps its memories in `skully.db` next to the code. Back that file up if you move servers.

---

## Good to know

- **Free limits.** Free AI tiers allow a limited number of requests per minute and per day, and the exact numbers change over time. That's plenty for a group of friends. If you see *"out of free juice"*, wait a minute or add a backup key. `/status` shows which model is answering. With `/autochat` on in a busy channel, the bot uses up its limits faster.
- **Privacy.** On free tiers, AI providers may use what you send to improve their models. Don't share passwords or other secrets with the bot.
- **Not financial advice.** The Skully signal is a simple momentum and volume rule of thumb.
- **Personality.** Set `EXTRA_PERSONALITY` in `.env`, for example `Roast Zippe whenever PEPE dumps.` Every other setting is explained in `.env.example`.
- **Your own model (unlimited and free if you have a strong PC).** Install [Ollama](https://ollama.com), then set `CUSTOM_LLM_BASE_URL=http://localhost:11434/v1` and `CUSTOM_LLM_MODELS=<model name>`.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Turn on MESSAGE CONTENT INTENT` | Developer Portal → Bot → Privileged Gateway Intents → Message Content Intent → Save |
| `Discord rejected the token` | Reset the token on the Bot tab and paste the new one into `.env` |
| Slash commands don't show up | Re-invite the bot with the link from the console (it needs the `applications.commands` scope), then restart Discord |
| Bot is online but never replies | Make sure it can view the channel and send messages there, and mention it or use its name |
| "out of free juice" | You hit the free rate limit. Wait a minute, or add `GROQ_API_KEY` / `OPENROUTER_API_KEY` as backups |

## Development

```bash
pip install -r requirements-dev.txt
pytest
```

The code lives in `bot/`:

- `discord_app.py`: Discord events and slash commands
- `agent.py`: the think → use tools → answer loop
- `llm.py`: the free-provider chain with automatic fallback
- `tools.py`: web search, page reader, crypto, calculator and memory
- `prompts.py`: personality and rules
- `storage.py`: SQLite
