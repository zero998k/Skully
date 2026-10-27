#!/usr/bin/env bash
# Makes the download zips from dist/ (run `npm run build` first). Used locally and by the release workflow.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-release}"
STAGE="$(mktemp -d)"
mkdir -p "$OUT" "$STAGE/mac/SolBoy" "$STAGE/win/SolBoy" "$STAGE/srv/SolBoy-for-Server"

cp dist/SolBoy-Mac-AppleSilicon "$STAGE/mac/SolBoy/SolBoy"
cp README.md "$STAGE/mac/SolBoy/" && cp packaging/START-HERE-Mac.txt "$STAGE/mac/SolBoy/START HERE.txt"
cp dist/SolBoy-Windows.exe "$STAGE/win/SolBoy/SolBoy.exe"
cp README.md "$STAGE/win/SolBoy/" && cp packaging/START-HERE-Windows.txt "$STAGE/win/SolBoy/START HERE.txt"
cp dist/SolBoy-Linux-x64 dist/SolBoy-Linux-arm64 packaging/install-server.sh README.md "$STAGE/srv/SolBoy-for-Server/"
cp packaging/START-HERE-Server.txt "$STAGE/srv/SolBoy-for-Server/START HERE (Server).txt"
chmod 755 "$STAGE/mac/SolBoy/SolBoy" "$STAGE"/srv/SolBoy-for-Server/SolBoy-Linux-* "$STAGE/srv/SolBoy-for-Server/install-server.sh"

OUT="$(cd "$OUT" && pwd)"
rm -f "$OUT/SolBoy-for-Mac.zip" "$OUT/SolBoy-for-Windows.zip" "$OUT/SolBoy-for-Server.zip"
(cd "$STAGE/mac" && zip -qr -9 "$OUT/SolBoy-for-Mac.zip" SolBoy)
(cd "$STAGE/win" && zip -qr -9 "$OUT/SolBoy-for-Windows.zip" SolBoy)
(cd "$STAGE/srv" && zip -qr -9 "$OUT/SolBoy-for-Server.zip" SolBoy-for-Server)
rm -r "$STAGE"
echo "Zips are in $OUT"
