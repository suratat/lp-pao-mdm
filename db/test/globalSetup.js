const path = require('path');
const { execSync } = require('node:child_process');
const { migrate } = require('./helpers');
const { DATABASE_URL } = require('./config');

const REPO_ROOT = path.join(__dirname, '..', '..');
const COMPOSE_FILE = path.join(__dirname, '..', 'docker-compose.yml');

module.exports = async () => {
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d --wait`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });

  await migrate(DATABASE_URL, 'up');
};
