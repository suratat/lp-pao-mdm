const { withTransaction } = require('../db/transaction');

// Phase C ของ seq-02: พ้น grace period แล้วยังไม่ยืนยัน -> EXPIRED + outbox VERIFICATION_EXPIRED
// รายงาน HR/dashboard ไม่ได้ implement (เป็นงานของ Portal, T9)
async function runReverifyEscalate({ pool, now = () => new Date(), batchSize = 500 }) {
  const nowDate = now();

  const { rows: candidates } = await pool.query(
    `SELECT person_id FROM mdm.person
     WHERE verification_status = 'STALE' AND reverify_due_at < $1
     LIMIT $2`,
    [nowDate, batchSize]
  );

  let expiredCount = 0;

  for (const { person_id: personId } of candidates) {
    const escalated = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT version, status FROM mdm.person
         WHERE person_id = $1 AND verification_status = 'STALE' AND reverify_due_at < $2
         FOR UPDATE SKIP LOCKED`,
        [personId, nowDate]
      );
      if (rows.length === 0) return false;

      await client.query(`UPDATE mdm.person SET verification_status = 'EXPIRED' WHERE person_id = $1`, [personId]);

      await client.query(
        `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
         VALUES ($1, 'VERIFICATION_EXPIRED', '[]'::jsonb, $2, $3)`,
        [
          personId,
          JSON.stringify({ personId, version: rows[0].version, status: rows[0].status, verificationStatus: 'EXPIRED' }),
          rows[0].version,
        ]
      );

      return true;
    });

    if (escalated) expiredCount++;
  }

  return { expiredCount };
}

module.exports = { runReverifyEscalate };
