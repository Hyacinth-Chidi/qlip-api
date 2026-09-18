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
  ],
};
