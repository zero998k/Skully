#!/usr/bin/env bash
# SolBoy server installer. Run it from the unzipped SolBoy-for-Server folder:   bash install-server.sh
# Installs SolBoy as an always-on service (starts on boot, restarts if it crashes) and, optionally,
# gives it a private HTTPS web address through Tailscale. Running it again updates SolBoy and keeps
# your settings, wallet and trades.
set -euo pipefail

DIR="${SOLBOY_DIR:-/opt/solboy}"
PORT="${SOLBOY_PORT:-7777}"
HERE="$(cd "$(dirname "$0")" && pwd)"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

case "$(uname -m)" in
  x86_64 | amd64) BIN="$HERE/SolBoy-Linux-x64" ;;
  aarch64 | arm64) BIN="$HERE/SolBoy-Linux-arm64" ;;
  *) echo "Sorry, this server's chip type ($(uname -m)) isn't supported."; exit 1 ;;
esac
[ -f "$BIN" ] || { echo "Can't find $BIN. Run this from inside the unzipped SolBoy-for-Server folder."; exit 1; }

say "1/3  Installing SolBoy into $DIR"
id solboy >/dev/null 2>&1 || $SUDO useradd --system --home "$DIR" --shell /usr/sbin/nologin solboy
$SUDO mkdir -p "$DIR"
$SUDO systemctl stop solboy 2>/dev/null || true
$SUDO install -m 755 "$BIN" "$DIR/SolBoy"
if ! $SUDO test -f "$DIR/.env"; then
  CODE="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'SETUP_CODE=%s\n' "$CODE" | $SUDO tee "$DIR/.env" >/dev/null
else
  CODE="$($SUDO sed -n 's/^SETUP_CODE=//p' "$DIR/.env" | head -n1)"
fi
$SUDO chown -R solboy:solboy "$DIR"
$SUDO chmod 600 "$DIR/.env"

say "2/3  Making SolBoy run all the time"
$SUDO tee /etc/systemd/system/solboy.service >/dev/null <<UNIT
[Unit]
Description=SolBoy copy trader
After=network-online.target
Wants=network-online.target

[Service]
User=solboy
WorkingDirectory=$DIR
Environment=SOLBOY_SERVER=1
Environment=PORT=$PORT
ExecStart=$DIR/SolBoy --server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now solboy
sleep 3
if ! $SUDO systemctl is-active --quiet solboy; then
  echo "SolBoy didn't start. Here's what it said:"
  $SUDO journalctl -u solboy -n 30 --no-pager || true
  exit 1
fi
echo "SolBoy is running."

say "3/3  Your secure web address (Tailscale, free)"
URL=""
ANSWER="y"
if : 2>/dev/null </dev/tty; then read -r -p "Set up an HTTPS web address for SolBoy now? [Y/n] " ANSWER </dev/tty || true; fi
if [[ ! "${ANSWER:-y}" =~ ^[Nn] ]]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "Installing Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | $SUDO sh
  fi
  echo
  echo "If a login link appears below, open it on your computer and sign in (Google/Apple/Microsoft all work)."
  $SUDO tailscale up
  echo
  echo "Turning on the public HTTPS address (Tailscale Funnel)..."
  echo "If it shows a link to enable Funnel, open it, click Enable, then run:  sudo tailscale funnel --bg $PORT"
  $SUDO tailscale funnel --bg "$PORT" || true
  URL="$($SUDO tailscale funnel status 2>/dev/null | grep -o 'https://[^ ]*' | head -n1 || true)"
fi

say "Done!"
if [ -n "$URL" ]; then
  echo "  Your SolBoy web address:  $URL"
else
  echo "  Web address not set up yet. See the guide (step 6) to finish it."
fi
if ! $SUDO grep -q '^DASHBOARD_PASSWORD_HASH=' "$DIR/.env"; then  # setup not finished yet
  echo "  Your setup code:          $CODE"
  echo "  Open the web address, enter the setup code, and finish setup in your browser."
else
  echo "  SolBoy was updated. Your settings, wallet and trades were kept."
fi
cat <<HELP

  Handy commands:
    sudo systemctl status solboy      is it running?
    sudo journalctl -u solboy -f      live log (Ctrl+C to stop watching)
    sudo systemctl restart solboy     restart it
HELP
