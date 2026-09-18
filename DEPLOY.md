# Deploying qlip-server to the VPS

Target: `/var/www/qlip`, served at `https://qlip-api.techfamz.com`, managed by PM2 as `qlip-api`, reverse-proxied by nginx.

Run everything below on the VPS over SSH, in order. Each step's expected output is noted so you know if something's wrong before moving on.

---

## 0. One-time prerequisites (skip anything already installed)

```bash
# ffmpeg (required for merging video+audio streams — most qualities need this)
sudo apt-get update
sudo apt-get install -y ffmpeg
ffmpeg -version | head -1

# pm2 (you already have this if your other app runs under it — skip if so)
npm install -g pm2

# certbot with the nginx plugin (skip if you already used it for your other site)
sudo apt-get install -y certbot python3-certbot-nginx
```

---

## 1. Get the code onto the box

```bash
sudo mkdir -p /var/www/qlip
sudo chown $USER:$USER /var/www/qlip
cd /var/www/qlip
git clone <YOUR_QLIP_SERVER_GIT_REMOTE> .
```

(If you're pulling into an already-cloned directory instead: `cd /var/www/qlip && git pull`.)

---

## 2. Install, build, and start under PM2

```bash
cd /var/www/qlip
npm run setup
```

This single command:
- installs Node dependencies
- downloads the `yt-dlp` binary into `./bin/` (only if not already present)
- warns if `ffmpeg` is missing (should be a no-op if you did step 0)
- builds TypeScript
- runs `pm2 startOrReload ecosystem.config.js` — starts (or zero-downtime-reloads) **only** the `qlip-api` process, leaving any other PM2 apps on the box untouched

**Verify:**
```bash
pm2 status
# expect a row named "qlip-api", status "online"

curl -s http://127.0.0.1:4477/health
# expect: {"ok":true}
```

If `pm2 status` shows another app already running (e.g. your existing API), it should still be listed and untouched — `qlip-api` is just a new row alongside it.

---

## 3. Nginx reverse proxy

```bash
sudo cp deploy/nginx-qlip-api.conf /etc/nginx/sites-available/qlip-api.techfamz.com
sudo ln -s /etc/nginx/sites-available/qlip-api.techfamz.com /etc/nginx/sites-enabled/
sudo nginx -t
```

**Verify:** `nginx -t` should print `syntax is ok` / `test is successful`. If it errors, stop and fix before reloading — don't reload a broken config.

```bash
sudo systemctl reload nginx
```

At this point `http://qlip-api.techfamz.com/health` should already work (no SSL yet):
```bash
curl -s http://qlip-api.techfamz.com/health
# expect: {"ok":true}
```

---

## 4. SSL certificate

```bash
sudo certbot --nginx -d qlip-api.techfamz.com
```

Certbot will ask for an email (first time only) and whether to redirect HTTP→HTTPS — choose **yes, redirect**. It rewrites `/etc/nginx/sites-available/qlip-api.techfamz.com` in place to add the `listen 443 ssl` block and cert paths, and reloads nginx itself.

**Verify:**
```bash
curl -s https://qlip-api.techfamz.com/health
# expect: {"ok":true}

curl -sI http://qlip-api.techfamz.com/health
# expect a 301/308 redirect to https://
```

Renewal is handled by certbot's existing systemd timer (`systemctl status certbot.timer`) — nothing new to schedule.

---

## 5. Firewall (only if 80/443 aren't already open)

```bash
sudo ufw status
# if 80 and 443 aren't in the list:
sudo ufw allow 80
sudo ufw allow 443
```

Do **not** open port 4477 externally — nginx reaches Fastify over `127.0.0.1`, which needs no firewall rule. Keep it closed.

---

## 6. Full live smoke test

```bash
# health
curl -s https://qlip-api.techfamz.com/health

# real extraction against a short public video
curl -s -X POST https://qlip-api.techfamz.com/api/extract \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}'

# real download of a small audio-only format from the extract response's
# "qualities" list (pick one with "kind":"audio")
curl -sI "https://qlip-api.techfamz.com/api/download?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw&format=<FORMAT_ID_FROM_EXTRACT>"
# expect: HTTP/2 200, content-type: application/octet-stream
```

Once these three succeed, the API is fully live and ready for the app to call.

---

## Routine updates after this point

**Normal code deploy:**
```bash
cd /var/www/qlip
git pull
npm run setup
```

**yt-dlp broke because a platform changed something (tokens, extraction logic):**
```bash
cd /var/www/qlip
npm run update-ytdlp
```
This touches nothing but the `yt-dlp` binary and restarts only the `qlip-api` PM2 process.

**nginx/SSL:** no routine action needed — certbot auto-renews, and the nginx config doesn't change unless the port or domain changes.
