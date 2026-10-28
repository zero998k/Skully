#!/usr/bin/env bash
# End-to-end tests: runs the real packaged native app against fake Solana, Jupiter, DexScreener, Pump.fun,
# X, IPFS, Groq and GitHub servers (fake.cjs), drives the dashboard with Playwright and the terminal
# through a pty, then checks the results (check.cjs). Takes about 10 minutes.
# Needs Linux x64/arm64 or macOS arm64/x64, Node 18+, Bun 1.4.4, Python 3, and Playwright with Chromium:
#   npm i --no-save playwright && npx playwright install chromium
# Uses an isolated dashboard port and stops only processes started by this test run.
set -uo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
ROOT="$(cd ../.. && pwd)"
OUT="$HERE/out"
rm -rf "$OUT"
mkdir -p "$OUT/rel"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=bun-darwin-arm64; ASSET=SolBoy-Mac-AppleSilicon ;;
  Darwin-x86_64) TARGET=bun-darwin-x64; ASSET=SolBoy-Mac-Intel ;;
  Linux-x86_64) TARGET=bun-linux-x64; ASSET=SolBoy-Linux-x64 ;;
  Linux-aarch64) TARGET=bun-linux-arm64; ASSET=SolBoy-Linux-arm64 ;;
  *) echo "Unsupported test platform"; exit 1 ;;
esac
export SOLBOY_TEST_PORT="${SOLBOY_TEST_PORT:-18777}"
export SOLBOY_TEST_URL="http://localhost:$SOLBOY_TEST_PORT"
export PORT="$SOLBOY_TEST_PORT"
node -e 'const s=require("net").createServer();s.once("error",()=>{console.error("Test dashboard port is already in use");process.exit(1)});s.listen(Number(process.env.PORT),"127.0.0.1",()=>s.close());' || exit 1
APP=""

echo "Building this version and a pretend next version (for the update test)..."
VERSION="$(node -p "require('$ROOT/package.json').version")"
NEXT="$(node -p "const v = '$VERSION'.split('.').map(Number); v[2]++; v.join('.')")"
(cd "$ROOT" && npm run embed >/dev/null && bun build src/main.js --compile --minify --target="$TARGET" --outfile "$OUT/SolBoy" >/dev/null) || exit 1
(cd "$ROOT" && printf 'export const VERSION = "%s";\n' "$NEXT" > src/version.js && bun build src/main.js --compile --minify --target="$TARGET" --outfile "$OUT/rel/$ASSET" >/dev/null; npm run embed >/dev/null)
node -e 'const f=require("fs"),c=require("crypto"),p=process.argv[1],n=process.argv[2];f.writeFileSync(p+"/SHA256SUMS",c.createHash("sha256").update(f.readFileSync(p+"/"+n)).digest("hex")+"  "+n+"\n")' "$OUT/rel" "$ASSET"

FAKE=""
start_fake() {
  REL_TAG="solboy-v$NEXT" FAKE_REL_DIR="$OUT/rel" node fake.cjs > "$OUT/fake-$1.log" 2>&1 &
  FAKE=$!
  sleep 1
}
stop_all() {
  kill "$FAKE" 2>/dev/null
  [ -n "$APP" ] && kill "$APP" 2>/dev/null
  APP=""
  sleep 1
  true
}
fresh_app() { # $1 = folder; $2 = extra .env lines
  rm -rf "$1" && mkdir -p "$1" && cp config.base.json "$1/config.json" && cp env.base "$1/.env" && cp "$OUT/SolBoy" "$1/SolBoy"
  node -e 'const f=require("fs"),p=process.argv[1]+"/config.json",c=JSON.parse(f.readFileSync(p));c.dashboard.port=Number(process.env.SOLBOY_TEST_PORT);f.writeFileSync(p,JSON.stringify(c));' "$1"
  [ -n "${2:-}" ] && printf '%s\n' "$2" >> "$1/.env"
  true
}

trap 'stop_all' EXIT
if ! node speed-unit.mjs "$OUT/speed.json" > "$OUT/speed-unit.txt" 2>&1; then cat "$OUT/speed-unit.txt"; exit 1; fi

echo "1/4 Dashboard: every feature..."
fresh_app "$OUT/app"
start_fake full
node process.cjs app 0 "$OUT/app/SolBoy" > "$OUT/app-full.txt" 2>&1 &
APP=$!
node process.cjs timeout 600 node full.cjs "$OUT" "$OUT/app" > "$OUT/full.json"
stop_all

echo "2/4 Terminal menu..."
start_fake term
python3 term.py "$OUT/app/SolBoy" 1 "" 2 "" 3 "" 4 "" "tp 40" "sl -15" "sl 120" "tp" "tp off" \
  "add 5NU3oN4fNnx1CknHtaH8kGPHAaK4UJ3X4E2WdEyY3h1y buddy" "remove buddy" reset account "ask hey" "blah" > "$OUT/term.txt"
stop_all

echo "3/4 Online server mode..."
rm -rf "$OUT/srv" && mkdir -p "$OUT/srv" && cp "$OUT/SolBoy" "$OUT/srv/SolBoy"
printf 'SETUP_CODE=k7q2m9x4\nJUPITER_API_URL=http://127.0.0.1:18902\n' > "$OUT/srv/.env"
start_fake server
node process.cjs timeout 300 node server-test.cjs "$OUT" > "$OUT/server.json"
stop_all

echo "4/4 One-click update to $NEXT..."
fresh_app "$OUT/upd" "SOLBOY_UPDATE_API=http://127.0.0.1:18903/repos/zero998k/Skully
SOLBOY_UPDATE_SITE=http://127.0.0.1:18903/gh"
start_fake update
curl -s -X POST "http://127.0.0.1:18900/set?release=1" >/dev/null
node process.cjs app 0 "$OUT/upd/SolBoy" > "$OUT/app-update.txt" 2>&1 &
APP=$!
node process.cjs timeout 300 node update.cjs "$OUT" "$OUT/upd" > "$OUT/update.json"
stop_all

node check.cjs "$OUT" "$VERSION" "$NEXT"
