module.exports = {
  apps: [
    {
      name: 'qrsong',
      script: 'npm',
      args: 'run start_pm2',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
