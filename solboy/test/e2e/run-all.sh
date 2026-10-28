#!/usr/bin/env bash
# End-to-end tests: runs the real packaged Linux app against fake Solana, Jupiter, DexScreener, Pump.fun,
# X, IPFS, Groq and GitHub servers (fake.cjs), drives the dashboard with Playwright and the terminal
# through a pty, then checks the results (check.cjs). Takes about 10 minutes.
# Needs Linux x64, Node 18+, Bun 1.4.4, Python 3, and Playwright with Chromium:
#   npm i --no-save playwright && npx playwright install chromium
# Note: it stops every process named SolBoy on this machine when it finishes each stage.
set -uo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
ROOT="$(cd ../.. && pwd)"
OUT="$HERE/out"
rm -rf "$OUT"
mkdir -p "$OUT/rel"

echo "Building this version and a pretend next version (for the update test)..."
VERSION="$(node -p "require('$ROOT/package.json').version")"
NEXT="$(node -p "const v = '$VERSION'.split('.').map(Number); v[2]++; v.join('.')")"
(cd "$ROOT" && npm run embed >/dev/null && bun build src/main.js --compile --minify --target=bun-linux-x64 --outfile "$OUT/SolBoy" >/dev/null) || exit 1
(cd "$ROOT" && printf 'export const VERSION = "%s";\n' "$NEXT" > src/version.js && bun build src/main.js --compile --minify --target=bun-linux-x64 --outfile "$OUT/rel/SolBoy-Linux-x64" >/dev/null; npm run embed >/dev/null)
(cd "$OUT/rel" && sha256sum SolBoy-Linux-x64 > SHA256SUMS)

FAKE=""
start_fake() {
  REL_TAG="solboy-v$NEXT" FAKE_REL_DIR="$OUT/rel" node fake.cjs > "$OUT/fake-$1.log" 2>&1 &
  FAKE=$!
  sleep 1
}
stop_all() {
  kill "$FAKE" 2>/dev/null
  pgrep -x SolBoy >/dev/null && kill $(pgrep -x SolBoy) 2>/dev/null
  pkill -f "sleep 1200" 2>/dev/null
  sleep 1
  true
}
fresh_app() { # $1 = folder; $2 = extra .env lines
  rm -rf "$1" && mkdir -p "$1" && cp config.base.json "$1/config.json" && cp env.base "$1/.env" && cp "$OUT/SolBoy" "$1/SolBoy"
  [ -n "${2:-}" ] && printf '%s\n' "$2" >> "$1/.env"
  true
}

echo "1/5 Dashboard: every feature..."
fresh_app "$OUT/app"
start_fake full
(sleep 1200 | "$OUT/app/SolBoy" > "$OUT/app-full.txt" 2>&1) &
timeout 600 node full.cjs "$OUT" "$OUT/app" > "$OUT/full.json"
stop_all

echo "2/5 Terminal menu..."
start_fake term
python3 term.py "$OUT/app/SolBoy" 1 "" 2 "" 3 "" 4 "" "tp 40" "sl -15" "sl 120" "tp" "tp off" \
  "add 5NU3oN4fNnx1CknHtaH8kGPHAaK4UJ3X4E2WdEyY3h1y buddy" "remove buddy" reset account "ask hey" "blah" > "$OUT/term.txt"
stop_all

echo "3/5 Online server mode..."
rm -rf "$OUT/srv" && mkdir -p "$OUT/srv" && cp "$OUT/SolBoy" "$OUT/srv/SolBoy"
printf 'SETUP_CODE=k7q2m9x4\nJUPITER_API_URL=http://127.0.0.1:18902\n' > "$OUT/srv/.env"
start_fake server
timeout 300 node server-test.cjs "$OUT" > "$OUT/server.json"
stop_all

echo "4/5 One-click update to $NEXT..."
fresh_app "$OUT/upd" "SOLBOY_UPDATE_API=http://127.0.0.1:18903/repos/zero998k/Skully
SOLBOY_UPDATE_SITE=http://127.0.0.1:18903/gh"
start_fake update
curl -s -X POST "http://127.0.0.1:18900/set?release=1" >/dev/null
(sleep 1200 | "$OUT/upd/SolBoy" > "$OUT/app-update.txt" 2>&1) &
timeout 300 node update.cjs "$OUT" "$OUT/upd" > "$OUT/update.json"
stop_all

echo "5/5 Pulse trading terminal..."
fresh_app "$OUT/pulse" "PUMPPORTAL_WS_URL=ws://127.0.0.1:18904
SOL_PRICE_URL=http://127.0.0.1:18903/price
GECKO_API_URL=http://127.0.0.1:18903/gecko
PULSE_ALLOW_LOCAL_URLS=1
PUMPPORTAL_API_URL=http://127.0.0.1:18903/pp-api"
node -e "const f='$OUT/pulse/config.json',c=JSON.parse(require('fs').readFileSync(f));c.pulse={backfillGapMs:300};require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
start_fake pulse
(sleep 1200 | "$OUT/pulse/SolBoy" > "$OUT/app-pulse.txt" 2>&1) &
timeout 300 node pulse.cjs "$OUT" > "$OUT/pulse.json"
stop_all

node check.cjs "$OUT" "$VERSION" "$NEXT"
