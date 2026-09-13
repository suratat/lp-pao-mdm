const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'db', 'docker-compose.yml');

module.exports = async () => {
  execSync(`docker compose -f "${COMPOSE_FILE}" down -v`, { cwd: REPO_ROOT, stdio: 'inherit' });
};
