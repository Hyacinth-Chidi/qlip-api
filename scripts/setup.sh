#!/usr/bin/env bash
# One command to run after `git pull`: installs/updates node deps, ensures
# yt-dlp + ffmpeg are present (does NOT touch yt-dlp if it already exists —
# use `npm run update-ytdlp` for that), builds, and (re)starts under PM2
# without disturbing any other app already running under PM2.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BIN_DIR="$ROOT/bin"
YTDLP_BIN="$BIN_DIR/yt-dlp"

echo "==> Installing Node dependencies"
npm install

echo "==> Ensuring bin/ exists"
mkdir -p "$BIN_DIR"

# Pick a standalone release asset that bundles its own Python. The plain
# "yt-dlp" asset is a zipimport build that needs system Python 3.10+, which
# isn't guaranteed on a VPS — these don't.
case "$(uname -m)" in
  x86_64)           YTDLP_ASSET="yt-dlp_linux" ;;
  aarch64 | arm64)  YTDLP_ASSET="yt-dlp_linux_aarch64" ;;
  *)                YTDLP_ASSET="yt-dlp" ;;  # fall back to the Python-dependent build
esac

if [ ! -f "$YTDLP_BIN" ]; then
  echo "==> yt-dlp binary not found, downloading latest release ($YTDLP_ASSET)"
  curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YTDLP_ASSET" -o "$YTDLP_BIN"
  chmod +x "$YTDLP_BIN"
  echo "==> yt-dlp version: $("$YTDLP_BIN" --version)"
else
  echo "==> yt-dlp binary already present, leaving it as-is (use 'npm run update-ytdlp' to bump it)"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "!! ffmpeg not found on PATH."
  echo "   Install it once with your package manager, e.g.:"
  echo "     sudo apt-get update && sudo apt-get install -y ffmpeg"
  echo "   (needed to merge separate video/audio streams for higher qualities)"
else
  echo "==> ffmpeg found: $(command -v ffmpeg)"
fi

echo "==> Building TypeScript"
npm run build

if ! command -v pm2 >/dev/null 2>&1; then
  echo "!! pm2 not found on PATH. Install it once with: npm install -g pm2"
  exit 1
fi

echo "==> Starting/reloading qlip-api under PM2 (other PM2 apps are untouched)"
pm2 startOrReload ecosystem.config.cjs

echo "==> Done. Check status with: pm2 status"
