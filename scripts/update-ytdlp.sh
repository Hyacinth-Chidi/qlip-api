#!/usr/bin/env bash
# Updates ONLY the yt-dlp binary in place and restarts the qlip-api PM2
# process. Never touches node_modules, never reinstalls anything else, and
# never affects other apps running under the same PM2 daemon.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
YTDLP_BIN="$ROOT/bin/yt-dlp"

mkdir -p "$ROOT/bin"

if [ -f "$YTDLP_BIN" ] && [ -x "$YTDLP_BIN" ]; then
  echo "==> Updating yt-dlp via its built-in self-updater"
  "$YTDLP_BIN" -U || {
    echo "==> Self-update failed, re-downloading latest release binary instead"
    curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "$YTDLP_BIN"
    chmod +x "$YTDLP_BIN"
  }
else
  echo "==> No existing yt-dlp binary, downloading latest release"
  curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "$YTDLP_BIN"
  chmod +x "$YTDLP_BIN"
fi

echo "==> yt-dlp version now: $("$YTDLP_BIN" --version)"

if command -v pm2 >/dev/null 2>&1 && pm2 describe qlip-api >/dev/null 2>&1; then
  echo "==> Restarting only qlip-api"
  pm2 restart qlip-api
else
  echo "!! qlip-api is not running under PM2 yet — run 'npm run setup' first."
fi

echo "==> Done."
