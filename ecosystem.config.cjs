const path = require('node:path');

const frontendRoot = path.resolve(__dirname, '../paymentgateway-frontend');
const common = {
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  watch: false,
  restart_delay: 3_000,
  min_uptime: '10s',
  max_restarts: 10,
  merge_logs: true,
  time: true,
  env: { NODE_ENV: 'production' },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'gateway-api',
      cwd: __dirname,
      script: 'node_modules/next/dist/bin/next',
      args: 'start -H 127.0.0.1 -p 3000',
      max_memory_restart: '512M',
      kill_timeout: 15_000,
    },
    {
      ...common,
      name: 'gateway-worker',
      cwd: __dirname,
      script: 'src/worker.ts',
      interpreter: path.join(__dirname, 'node_modules/.bin/tsx'),
      max_memory_restart: '256M',
      kill_timeout: 120_000,
      env: { NODE_ENV: 'production', ENV_FILE: '.env.production' },
    },
    {
      ...common,
      name: 'gateway-frontend',
      cwd: frontendRoot,
      script: 'node_modules/next/dist/bin/next',
      args: 'start -H 127.0.0.1 -p 5173',
      max_memory_restart: '384M',
      kill_timeout: 15_000,
    },
  ],
};
