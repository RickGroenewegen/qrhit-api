module.exports = {
  apps: [
    {
      name: 'qrsong',
      script: 'npm',
      args: 'run start',
      watch: false,
      autorestart: true,
      env: {
        NODE_ENV: 'development',
        GIT_SSH_COMMAND: 'ssh -i ~/.ssh/id_rsa -o IdentitiesOnly=yes',
      },
      env_production: {
        NODE_ENV: 'production',
        GIT_SSH_COMMAND: 'ssh -i ~/.ssh/id_rsa -o IdentitiesOnly=yes',
      },
    },
  ],
};
