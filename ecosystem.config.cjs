// .cjs extension is required: package.json sets "type": "module", so a plain
// .js file here would be parsed as ESM, but PM2's config loader uses
// require() to read ecosystem files — that silently failed to find `apps`
// (PM2 reported "No script path - aborting" with no app name).
module.exports = {
  apps: [
    {
      name: 'qlip-api',
      script: './dist/server.js',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.QLIP_PORT || 4477,
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
    },
    {
      // bgutil PO-token provider: mints the "proof of origin" tokens YouTube
      // requires from datacenter IPs, so no browser cookies are needed.
      // Bound to 127.0.0.1 — only yt-dlp on this box should reach it.
      name: 'qlip-pot',
      script: './pot-provider/server/build/main.js',
      args: '--host 127.0.0.1 --port 4416',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
    },
  ],
};
