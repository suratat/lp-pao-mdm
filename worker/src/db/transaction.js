// เหมือน api/src/db/transaction.js (ดูเหตุผลการไม่ทำ shared package ใน worker/src/security/vault.js)
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
