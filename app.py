import streamlit as st
import requests
import pandas as pd
from datetime import datetime
from streamlit_autorefresh import st_autorefresh

# ====================== CONFIG ======================
st.set_page_config(
    page_title="Skully | Meme Coin Radar",
    page_icon="💀",
    layout="wide"
)

# Auto refresh every 60 seconds
st_autorefresh(interval=60 * 1000, key="skully_refresh")

# ====================== SIDEBAR ======================
st.sidebar.title("💀 Skully Settings")
st.sidebar.markdown("**Made for Zippe & Irnes**")

api_key = st.sidebar.text_input(
    "CoinGecko Demo API Key (optional but recommended)",
    type="password",
    help="Get free key at https://www.coingecko.com/en/api"
)

st.sidebar.markdown("---")
st.sidebar.markdown("### Add Coin to Watchlist")
new_coin = st.sidebar.text_input("CoinGecko ID (e.g. pepe, bonk, dogwifcoin, floki)")
if st.sidebar.button("➕ Add Coin") and new_coin:
    if "watchlist" not in st.session_state:
        st.session_state.watchlist = []
    coin_id = new_coin.strip().lower()
    if coin_id not in st.session_state.watchlist:
        st.session_state.watchlist.append(coin_id)
        st.sidebar.success(f"Added {coin_id}")

if "watchlist" not in st.session_state:
    # Default meme coins
    st.session_state.watchlist = [
        "pepe", "dogecoin", "shiba-inu", "bonk", 
        "dogwifcoin", "floki", "mog-coin", "popcat"
    ]

if st.sidebar.button("🗑️ Clear Watchlist"):
    st.session_state.watchlist = []

st.sidebar.markdown("---")
st.sidebar.info("This is **not financial advice**. Skully only shows public data heuristics.")

# ====================== HELPERS ======================
def get_headers():
    if api_key:
        return {"x-cg-demo-api-key": api_key}
    return {}

def fetch_prices(coin_ids):
    if not coin_ids:
        return {}
    ids = ",".join(coin_ids)
    url = f"https://api.coingecko.com/api/v3/simple/price"
    params = {
        "ids": ids,
        "vs_currencies": "usd",
        "include_24hr_change": "true",
        "include_24hr_vol": "true",
        "include_market_cap": "true"
    }
    try:
        r = requests.get(url, params=params, headers=get_headers(), timeout=10)
        return r.json() if r.status_code == 200 else {}
    except:
        return {}

def fetch_trending():
    try:
        r = requests.get(
            "https://api.coingecko.com/api/v3/search/trending",
            headers=get_headers(),
            timeout=10
        )
        if r.status_code == 200:
            return r.json().get("coins", [])
    except:
        pass
    return []

def fetch_fear_greed():
    try:
        r = requests.get("https://api.alternative.me/fng/?limit=1", timeout=8)
        if r.status_code == 200:
            data = r.json()["data"][0]
            return int(data["value"]), data["value_classification"]
    except:
        pass
    return None, "Unknown"

def skully_signal(change_24h, volume, market_cap):
    """Simple heuristic signal"""
    score = 0
    reasons = []

    if change_24h is None:
        return "Hold", 50, ["Not enough data"]

    # Momentum
    if change_24h > 15:
        score += 30
        reasons.append(f"Strong pump (+{change_24h:.1f}%)")
    elif change_24h > 5:
        score += 15
        reasons.append(f"Positive momentum (+{change_24h:.1f}%)")
    elif change_24h < -15:
        score -= 30
        reasons.append(f"Sharp dump ({change_24h:.1f}%)")
    elif change_24h < -5:
        score -= 15
        reasons.append(f"Negative momentum ({change_24h:.1f}%)")

    # Volume proxy (higher volume = more interest)
    if volume and volume > 5_000_000:
        score += 15
        reasons.append("High trading volume")
    elif volume and volume > 1_000_000:
        score += 8
        reasons.append("Decent volume")

    # Market mood adjustment later
    if score >= 25:
        signal = "Buy"
        conf = min(85, 55 + score)
    elif score <= -20:
        signal = "Sell"
        conf = min(85, 55 + abs(score))
    else:
        signal = "Hold"
        conf = 50 + abs(score) // 2

    if not reasons:
        reasons = ["Neutral price action"]

    return signal, conf, reasons

def color_pct(val):
    if val is None:
        return ""
    color = "green" if val >= 0 else "red"
    return f"<span style='color:{color}; font-weight:bold'>{val:+.2f}%</span>"

# ====================== MAIN UI ======================
st.title("💀 Skully")
st.caption("Meme Coin Radar • Made for Zippe & Irnes")

# Fear & Greed
fg_value, fg_label = fetch_fear_greed()
col1, col2, col3 = st.columns(3)
with col1:
    st.metric("Market Fear & Greed", f"{fg_value if fg_value else '—'}", fg_label)
with col2:
    st.metric("Watchlist Coins", len(st.session_state.watchlist))
with col3:
    st.metric("Last Update", datetime.now().strftime("%H:%M:%S"))

st.markdown("---")

# ===== WATCHLIST TABLE =====
st.subheader("📋 Your Watchlist")

prices = fetch_prices(st.session_state.watchlist)

if prices:
    rows = []
    for coin_id in st.session_state.watchlist:
        data = prices.get(coin_id, {})
        price = data.get("usd")
        change = data.get("usd_24h_change")
        volume = data.get("usd_24h_vol")
        mcap = data.get("usd_market_cap")

        signal, conf, reasons = skully_signal(change, volume, mcap)

        # Simple buyers vs sellers proxy
        if change and change > 3:
            pressure = "Buyers dominating"
            pressure_color = "green"
        elif change and change < -3:
            pressure = "Sellers dominating"
            pressure_color = "red"
        else:
            pressure = "Balanced"
            pressure_color = "gray"

        rows.append({
            "Coin": coin_id,
            "Price": f"${price:,.8f}" if price and price < 1 else (f"${price:,.4f}" if price else "—"),
            "24h %": change,
            "Volume 24h": f"${volume:,.0f}" if volume else "—",
            "Pressure": pressure,
            "Skully Signal": signal,
            "Confidence": f"{conf}%",
            "Reasons": " • ".join(reasons)
        })

    df = pd.DataFrame(rows)

    # Display with colors
    def highlight_signal(val):
        if val == "Buy":
            return "background-color: #d4edda; color: #155724; font-weight: bold"
        elif val == "Sell":
            return "background-color: #f8d7da; color: #721c24; font-weight: bold"
        return ""

    st.dataframe(
        df.style.map(highlight_signal, subset=["Skully Signal"])
               .format({"24h %": lambda x: f"{x:+.2f}%" if pd.notnull(x) else "—"}),
        use_container_width=True,
        hide_index=True
    )
else:
    st.warning("No price data yet. Check your watchlist or API key.")

# ===== TRENDING =====
st.markdown("---")
st.subheader("🔥 Currently Trending on CoinGecko")

trending = fetch_trending()
if trending:
    trend_cols = st.columns(5)
    for i, item in enumerate(trending[:5]):
        coin = item.get("item", {})
        with trend_cols[i]:
            st.markdown(f"**{coin.get('symbol', '?').upper()}**")
            st.caption(coin.get("name", ""))
            st.caption(f"Rank #{coin.get('market_cap_rank', '—')}")
else:
    st.write("Could not load trending data.")

# ===== FOOTER =====
st.markdown("---")
st.markdown(
    """
    <div style='text-align:center; color:gray; font-size:0.9em'>
    Skully uses public market data only.<br>
    Signals are simple heuristics — <b>not financial advice</b>.<br>
    Always do your own research.
    </div>
    """,
    unsafe_allow_html=True
)