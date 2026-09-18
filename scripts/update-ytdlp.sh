#!/usr/bin/env bash
# Updates ONLY the yt-dlp binary in place and restarts the qlip-api PM2
# process. Never touches node_modules, never reinstalls anything else, and
# never affects other apps running under the same PM2 daemon.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
YTDLP_BIN="$ROOT/bin/yt-dlp"

mkdir -p "$ROOT/bin"

# Must match the asset selection in setup.sh — standalone builds that bundle
# their own Python, so no system Python 3.10+ is required.
case "$(uname -m)" in
  x86_64)           YTDLP_ASSET="yt-dlp_linux" ;;
  aarch64 | arm64)  YTDLP_ASSET="yt-dlp_linux_aarch64" ;;
  *)                YTDLP_ASSET="yt-dlp" ;;
esac

download_ytdlp() {
  curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YTDLP_ASSET" -o "$YTDLP_BIN"
  chmod +x "$YTDLP_BIN"
}

if [ -f "$YTDLP_BIN" ] && [ -x "$YTDLP_BIN" ]; then
  echo "==> Updating yt-dlp via its built-in self-updater"
  "$YTDLP_BIN" -U || {
    echo "==> Self-update failed, re-downloading latest release ($YTDLP_ASSET) instead"
    download_ytdlp
  }
else
  echo "==> No existing yt-dlp binary, downloading latest release ($YTDLP_ASSET)"
  download_ytdlp
fi

echo "==> yt-dlp version now: $("$YTDLP_BIN" --version)"

if command -v pm2 >/dev/null 2>&1 && pm2 describe qlip-api >/dev/null 2>&1; then
  echo "==> Restarting only qlip-api"
  pm2 restart qlip-api
  # Restart the token provider too when present: a stale one is a common
  # cause of YouTube breaking while every other site still works.
  if pm2 describe qlip-pot >/dev/null 2>&1; then
    echo "==> Restarting qlip-pot (PO-token provider)"
    pm2 restart qlip-pot
  fi
else
  echo "!! qlip-api is not running under PM2 yet — run 'npm run setup' first."
fi

echo "==> Done."
