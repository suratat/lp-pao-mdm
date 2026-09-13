const { withTransaction } = require('../db/transaction');

// WK->>DB: SELECT outbox_event WHERE published_at IS NULL FOR UPDATE SKIP LOCKED (seq-01 ขั้น 51-57)
// fan-out ไปยัง webhook_delivery ต่อ subscription ที่ยัง active และสมัครรับ event_type นี้
// UNIQUE(subscription_id, event_id) ของ T1 ทำให้ ON CONFLICT DO NOTHING กัน fan-out ซ้ำได้จริง
// (idempotent แม้ job นี้จะถูกเรียกซ้ำ หรือมีหลาย worker แข่งกัน SKIP LOCKED)
async function runOutboxDispatch({ pool, batchSize = 100 }) {
  return withTransaction(pool, async (client) => {
    const { rows: events } = await client.query(
      `SELECT event_id, event_type FROM integration.outbox_event
       WHERE published_at IS NULL
       ORDER BY sequence
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [batchSize]
    );

    let fanned = 0;

    for (const event of events) {
      const { rows: subs } = await client.query(
        `SELECT subscription_id FROM integration.webhook_subscription
         WHERE is_active = true AND event_types ? $1`,
        [event.event_type]
      );

      for (const sub of subs) {
        const { rowCount } = await client.query(
          `INSERT INTO integration.webhook_delivery (subscription_id, event_id, status, attempt_count, next_attempt_at)
           VALUES ($1, $2, 'PENDING', 0, now())
           ON CONFLICT (subscription_id, event_id) DO NOTHING`,
          [sub.subscription_id, event.event_id]
        );
        fanned += rowCount;
      }

      await client.query(`UPDATE integration.outbox_event SET published_at = now() WHERE event_id = $1`, [
        event.event_id,
      ]);
    }

    return { processed: events.length, fanned };
  });
}

module.exports = { runOutboxDispatch };
