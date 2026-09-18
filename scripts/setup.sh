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

if [ ! -f "$YTDLP_BIN" ]; then
  echo "==> yt-dlp binary not found, downloading latest release"
  curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "$YTDLP_BIN"
  chmod +x "$YTDLP_BIN"
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
pm2 startOrReload ecosystem.config.js

echo "==> Done. Check status with: pm2 status"
