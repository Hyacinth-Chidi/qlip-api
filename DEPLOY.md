# Deploying qlip-server to the VPS

Target: `/var/www/qlip`, served at `https://qlip-api.techfamz.com`, managed by PM2 as `qlip-api`, reverse-proxied by nginx.

Run everything below on the VPS over SSH, in order. Each step's expected output is noted so you know if something's wrong before moving on.

---

## 0. One-time prerequisites (skip anything already installed)

On a fresh box, run all of these. On a box that already hosts another Node
app, you likely only need ffmpeg.

```bash
sudo apt-get update

# Node 20+ — required by the server and by the PO-token provider. Ubuntu's
# own `nodejs` package is usually too old, so use NodeSource.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # expect v22.x

# ffmpeg (merges video+audio; most qualities above the lowest tier need it)
sudo apt-get install -y ffmpeg git
ffmpeg -version | head -1

# pm2 process manager
sudo npm install -g pm2

# certbot with the nginx plugin, and nginx itself if not present
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

---

## 1. Get the code onto the box

```bash
sudo mkdir -p /var/www/qlip
sudo chown $USER:$USER /var/www/qlip
cd /var/www/qlip
git clone https://github.com/Hyacinth-Chidi/qlip-api.git .
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
- runs `pm2 startOrReload ecosystem.config.cjs` — starts (or zero-downtime-reloads) **only** the `qlip-api` process, leaving any other PM2 apps on the box untouched

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

Replace `DOMAIN` with your API host.

```bash
# 1. health
curl -s https://DOMAIN/health
# expect: {"ok":true}

# 2. extraction on a platform that doesn't IP-block (use any real reel/post)
curl -s -X POST https://DOMAIN/api/extract \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.instagram.com/reel/XXXXXXXXX/"}'
# expect: {"type":"single","title":...,"qualities":[...]}

# 3. download headers — confirms the file arrives named and typed
curl -sI "https://DOMAIN/api/download?url=<URL-ENCODED>&format=<ID_FROM_STEP_2>&ext=mp4&name=test"
# expect: content-type: video/mp4
#         content-disposition: attachment; filename="test.mp4"
```

### Does YouTube work on this IP?

YouTube blocks most datacenter IPs before returning any stream URLs, which no
amount of server-side configuration can bypass. A new host may or may not be
flagged — this is the only way to find out:

```bash
cd /var/www/qlip
./bin/yt-dlp -J --no-warnings --js-runtimes node --plugin-dirs ./plugins \
  "https://youtu.be/jNQXAC9IVRw" >/dev/null 2>/tmp/yt.txt \
  && echo "YOUTUBE WORKS on this IP" \
  || grep -oiE "sign in to confirm[^.]*" /tmp/yt.txt
```

If it prints the "sign in to confirm" line, this IP is flagged. The only
proven fix is routing yt-dlp through a residential/mobile proxy — datacenter
proxies are scored the same as the VPS and don't help. Everything else
(PO tokens, alternate player clients, newer builds) was tried and failed.

Once the first three checks succeed, the API is live for the app, whatever
YouTube does.

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
