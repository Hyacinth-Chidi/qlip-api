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

# yt-dlp solves YouTube's JS challenges with an external runtime; the server
# passes --js-runtimes node, so Node must be on PATH (it is, for PM2 itself).
echo "==> node for yt-dlp JS challenges: $(command -v node) ($(node --version))"

# Extraction runs through a long-lived Python worker that imports yt-dlp once
# and reuses HTTP connections — roughly 2.3x faster than spawning the binary
# per request. Entirely optional: without it the server spawns the binary as
# before, just slower.
VENV_DIR="$ROOT/.venv"
VENV_PY="$VENV_DIR/bin/python3"

# The test is "can the worker import yt-dlp", not "does a .venv directory
# exist" — a failed `python3 -m venv` still leaves the directory behind, and
# keying off its presence meant a half-built venv was reported as ready and
# never repaired.
if "$VENV_PY" -c 'import yt_dlp' 2>/dev/null; then
  echo "==> Worker yt-dlp: $("$VENV_PY" -m yt_dlp --version)"
elif command -v python3 >/dev/null 2>&1 && \
     python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
  echo "==> Setting up the extraction worker ($(python3 --version))"

  # Recreate from scratch: an existing directory here is a failed attempt.
  if [ ! -x "$VENV_PY" ]; then
    rm -rf "$VENV_DIR"
    if ! python3 -m venv "$VENV_DIR" 2>&1 | sed 's/^/   /'; then
      echo "!! venv creation failed. On Debian/Ubuntu install the venv package:"
      echo "     sudo apt-get install -y python3-venv"
      echo "   Then re-run 'npm run setup'."
      echo "   Until then the server spawns yt-dlp per request — slower, still works."
    fi
  fi

  if [ -x "$VENV_PY" ]; then
    "$VENV_PY" -m pip install --quiet --upgrade pip yt-dlp \
      && echo "==> Worker yt-dlp: $("$VENV_PY" -m yt_dlp --version)" \
      || echo "!! pip install failed — server will spawn yt-dlp per request instead"
  fi
else
  echo "!! python3 >= 3.10 not found — extraction will spawn yt-dlp per request."
  echo "   Optional speedup: sudo apt-get install -y python3 python3-venv"
fi

# bgutil PO-token provider — replaces browser cookies for YouTube's bot check.
# Two parts: an HTTP server (run under PM2 as qlip-pot) and a yt-dlp plugin.
# Both pinned to one release; bump POT_VERSION to upgrade, then rm -rf the two
# install dirs and re-run setup.
POT_VERSION="${POT_VERSION:-2.0.0}"
POT_DIR="$ROOT/pot-provider"
PLUGIN_DIR="$ROOT/plugins"

if [ ! -f "$POT_DIR/server/build/main.js" ]; then
  echo "==> Installing PO-token provider server v$POT_VERSION"
  rm -rf "$POT_DIR"
  git clone --quiet --depth 1 --branch "$POT_VERSION" \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$POT_DIR"
  (cd "$POT_DIR/server" && npm ci --silent && npx tsc)
else
  echo "==> PO-token provider server already installed"
fi

if [ ! -f "$PLUGIN_DIR/bgutil-ytdlp-pot-provider.zip" ]; then
  echo "==> Installing yt-dlp PO-token plugin v$POT_VERSION"
  mkdir -p "$PLUGIN_DIR"
  curl -fL "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/$POT_VERSION/bgutil-ytdlp-pot-provider.zip" \
    -o "$PLUGIN_DIR/bgutil-ytdlp-pot-provider.zip"
else
  echo "==> yt-dlp PO-token plugin already installed"
fi

echo "==> Building TypeScript"
npm run build

if ! command -v pm2 >/dev/null 2>&1; then
  echo "!! pm2 not found on PATH. Install it once with: npm install -g pm2"
  exit 1
fi

echo "==> Starting/reloading qlip-api + qlip-pot under PM2 (other PM2 apps are untouched)"
pm2 startOrReload ecosystem.config.cjs

echo "==> Done. Check status with: pm2 status"
