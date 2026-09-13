const path = require('path');
const { runner } = require('node-pg-migrate');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function migrate(databaseUrl, direction, opts = {}) {
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    migrationsTable: 'pgmigrations',
    count: Infinity,
    logger: { info: () => {}, warn: console.warn, error: console.error },
    ...opts,
  });
}

module.exports = { migrate, MIGRATIONS_DIR };
