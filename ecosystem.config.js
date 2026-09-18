export default {
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
