#!/usr/bin/env bash
# One-line SolBoy install/upgrade for a Mac:
#   curl -fsSL https://raw.githubusercontent.com/zero998k/Skully/claude/hopeful-edison-2b8ltm/solboy/scripts/install-mac.sh | bash
# Finds your SolBoy folder (keeping your keys, wallets, settings and trades), puts the newest SolBoy in it
# and opens it. Without an existing folder, it sets SolBoy up fresh in Documents/SolBoy.
set -euo pipefail

REPO="zero998k/Skully"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

case "${SOLBOY_PLATFORM:-$(uname -s)-$(uname -m)}" in
  Darwin-arm64) ASSET="SolBoy-Mac-AppleSilicon" ;;
  Darwin-x86_64) ASSET="SolBoy-Mac-Intel" ;;
  Linux-x86_64) ASSET="SolBoy-Linux-x64" ;;
  Linux-aarch64) ASSET="SolBoy-Linux-arm64" ;;
  *) echo "Sorry, this computer isn't supported."; exit 1 ;;
esac

# Newest SolBoy release: GitHub's API, or its releases feed if the API is busy.
TAGS="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" 2>/dev/null || curl -fsSL "https://github.com/$REPO/releases.atom" 2>/dev/null || true)"
VERSION="$(printf '%s' "$TAGS" | grep -o 'solboy-v[0-9][0-9.]*[0-9]' | sed 's#solboy-v##' | sort -u -t. -k1,1n -k2,2n -k3,3n | tail -n1 || true)"
[ -n "$VERSION" ] || { echo "Couldn't find a SolBoy release. Check your internet and try again."; exit 1; }

# Where is SolBoy now? First a running copy, then the usual folders (the one used most recently wins).
DIR=""
for pid in $(pgrep -x SolBoy 2>/dev/null || true); do
  exe="$(ps -o comm= -p "$pid" 2>/dev/null | head -n1 || true)"
  case "$exe" in /*) [ -f "$(dirname "$exe")/config.json" ] && DIR="$(dirname "$exe")" && break ;; esac
done
if [ -z "$DIR" ]; then
  DIR="$(find "$HOME/Desktop" "$HOME/Documents" "$HOME/Downloads" "$HOME" -maxdepth 3 -name config.json 2>/dev/null \
    | while read -r f; do d="$(dirname "$f")"; [ -f "$d/SolBoy" ] && [ -f "$d/.env" ] && echo "$(stat -c %Y "$d/.env" 2>/dev/null || stat -f %m "$d/.env") $d"; done \
    | sort -rn | head -n1 | cut -d' ' -f2- || true)"
fi
if [ -n "$DIR" ]; then
  say "Found your SolBoy in $DIR. Upgrading it to $VERSION (your keys, wallets and trades stay)."
else
  DIR="$HOME/Documents/SolBoy"
  say "Installing SolBoy $VERSION in $DIR."
  mkdir -p "$DIR"
fi

BASE="https://github.com/$REPO/releases/download/solboy-v$VERSION"
TMP="$DIR/SolBoy.new"
curl -fL --progress-bar -o "$TMP" "$BASE/$ASSET"
WANT="$(curl -fsSL "$BASE/SHA256SUMS" | awk -v a="$ASSET" '$2==a {print $1}' || true)"
GOT="$( (sha256sum "$TMP" 2>/dev/null || shasum -a 256 "$TMP") | cut -d' ' -f1)"
if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then rm -f "$TMP"; echo "The download was damaged. Nothing was changed. Try again."; exit 1; fi
chmod 755 "$TMP"
"$TMP" --version | grep -q "$VERSION" || { rm -f "$TMP"; echo "The new SolBoy wouldn't start. Nothing was changed."; exit 1; }

# Close the old SolBoy (if open), swap in the new one, and start it.
for pid in $(pgrep -x SolBoy 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
sleep 2
[ -f "$DIR/SolBoy" ] && mv -f "$DIR/SolBoy" "$DIR/SolBoy.old"
mv -f "$TMP" "$DIR/SolBoy"
rm -f "$DIR/SolBoy.old"

say "Done! SolBoy $VERSION is ready."
if [ "$(uname -s)" = "Darwin" ] && [ -z "${SOLBOY_NO_OPEN:-}" ]; then
  open -a Terminal "$DIR/SolBoy"
  echo "It's opening in a new Terminal window, and your dashboard opens in your browser."
else
  echo "Start it with: $DIR/SolBoy"
fi
echo "Next time, just click the yellow Update button in the dashboard."
