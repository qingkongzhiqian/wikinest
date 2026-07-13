// PM2 process file for Wikinest (web + MCP server).
//
// Usage:
//   cd /path/to/wikinest
//   cp .env.example .env    # fill WIKI_TOKEN / WIKI_PASSWORD / LLM_* / S3_*
//   pm2 start deploy/ecosystem.config.cjs && pm2 save
//   pm2 logs wikinest
//
// bin/wiki.js auto-loads the project-root .env, so env vars aren't duplicated here.
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'wikinest',
      script: 'bin/wiki.js',
      args: 'serve',
      // Run from the project root regardless of where pm2 is invoked.
      cwd: path.resolve(__dirname, '..'),
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        WIKI_PORT: '4321',
      },
    },
  ],
};
