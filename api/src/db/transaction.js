// ทุกการเปลี่ยนข้อมูลบุคคลต้องอยู่ใน transaction เดียวกับ data_change_log และ outbox_event (กฎข้อ 3 ของ CLAUDE.md)
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
