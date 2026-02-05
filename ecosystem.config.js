module.exports = {
  apps: [
    {
      name: 'parallax',
      script: 'dist/index.js',

      // Cluster mode for zero-downtime (PM2 manages socket sharing)
      exec_mode: 'cluster',
      instances: 1,               // Single instance, but cluster mode enables graceful reload

      // Zero-downtime deployment settings
      wait_ready: true,           // Wait for process.send('ready')
      listen_timeout: 90000,      // 90s timeout for ready signal (init takes ~60s)
      kill_timeout: 5000,         // 5s grace period for old process

      // Restart behavior
      max_memory_restart: '2G',
      restart_delay: 1000,
      
      // Node.js options - increase heap size
      node_args: '--max-old-space-size=2048',

      // Environment
      env: {
        NODE_ENV: 'production'
      },

      // Logging
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true
    },
    {
      name: 'cloudflared',
      script: 'cloudflared',
      args: 'tunnel run parallax',
      autorestart: true,
      restart_delay: 5000,

      // Logging
      error_file: 'logs/cloudflared-error.log',
      out_file: 'logs/cloudflared-out.log',
      merge_logs: true
    }
  ]
};
