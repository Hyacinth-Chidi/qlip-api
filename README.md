# qlip-server

Fastify backend that wraps [yt-dlp](https://github.com/yt-dlp/yt-dlp) to power the Qlip app's video extraction and download flow. The app never talks to yt-dlp directly — it calls this server over HTTP.

- `POST /api/extract` — `{ url }` → title, thumbnail, duration, and a list of quality options.
- `GET /api/download?url=...&format=...` — streams the chosen format straight through to the client. The server does **not** write the final file to disk; bytes are piped from yt-dlp's stdout directly into the HTTP response. (If yt-dlp needs to mux separate video/audio streams, ffmpeg may use a short-lived temp file internally, cleaned up automatically once streaming finishes.) If the requested format requires muxing (its id looks like `"137+140"`) and ffmpeg isn't installed, the route fails fast with a `503` instead of starting a stream — a mid-stream ffmpeg failure can't be turned into a clean HTTP error after bytes have already started flowing, so this is checked before anything is sent.
- `GET /health` — liveness check.

For the full first-time VPS setup (nginx reverse proxy, SSL via certbot, firewall, live smoke test), see [DEPLOY.md](./DEPLOY.md). The quick version below assumes nginx/SSL are already in place.

## First-time deploy on the VPS

```bash
cd /var/www/qlip
git pull
npm run setup
```

`npm run setup` is idempotent — safe to run after every `git pull`. It:
1. Installs/updates Node dependencies.
2. Downloads the `yt-dlp` binary into `./bin/` **only if it's not already there** — it will never overwrite an existing binary.
3. Warns if `ffmpeg` isn't installed (one-time `apt-get install ffmpeg`, not managed by this repo). **Install it** — without it, any quality that needs merged video+audio streams (most resolutions above the lowest progressive tier) will be refused by `/api/download` rather than served broken.
4. Builds TypeScript.
5. Runs `pm2 startOrReload ecosystem.config.cjs`, which starts (or zero-downtime-reloads) the `qlip-api` process only. Any other apps already running under the same PM2 daemon are untouched — PM2 manages processes independently by name.

## Updating yt-dlp when a platform changes its tokens

This is deliberately a separate, single-purpose command — it does **not** run `npm install` or touch `node_modules`:

```bash
npm run update-ytdlp
```

This runs yt-dlp's own self-updater (falling back to a fresh binary download if that fails), then restarts only the `qlip-api` PM2 process. Nothing else on the box is touched.

## YouTube cookies (required for YouTube to work from a VPS)

YouTube blocks requests from datacenter IPs with `Sign in to confirm you're not a bot` unless yt-dlp presents cookies from a real logged-in browser session. Without this, `/api/extract` and `/api/download` will fail with a `422` for every YouTube URL, even though the server itself is working correctly — this is YouTube's anti-bot system rejecting the request, not a bug.

**Setup:**
1. In a browser where you're logged into YouTube, install a cookie-export extension (e.g. "Get cookies.txt LOCALLY") and export cookies for `youtube.com` in Netscape format.
2. Upload that file to the VPS as `cookies/youtube.txt` (relative to the repo root, e.g. `/var/www/qlip/qlip-api/cookies/youtube.txt`).
3. That's it — `ytdlp.ts` auto-detects the file and passes `--cookies` to every yt-dlp call. No restart needed beyond the next natural request (the file is checked per-call, not cached at boot).

**Never commit this file.** It's already in `.gitignore` — it contains your personal YouTube session and must only ever live on the server's disk.

Cookies expire and will need periodic re-export (how often varies; if YouTube extraction starts failing again after previously working, this is the first thing to check — re-export and re-upload).

## Local development

```bash
npm install
npm run dev
```

Requires `yt-dlp` and `ffmpeg` available on your `PATH` locally (e.g. `pip install yt-dlp`, `brew install ffmpeg` / `apt install ffmpeg`), or drop a `yt-dlp` binary into `./bin/`.

## PM2 process name

The app is registered as `qlip-api` in `ecosystem.config.cjs`. All commands (`setup`, `update-ytdlp`) only ever start/restart/reload that one named process — never `pm2 restart all`.

The `.cjs` extension is deliberate: `package.json` sets `"type": "module"`, which would make a plain `ecosystem.config.js` parse as ESM, but PM2 loads ecosystem files with `require()`. That mismatch fails silently — PM2 reports `No script path - aborting` with a blank app name rather than a module error.
