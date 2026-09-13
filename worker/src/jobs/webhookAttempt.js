const { withTransaction } = require('../db/transaction');
const { signPayload } = require('../services/webhookSigner');

const WEBHOOK_SECRET_KEY_NAME = 'mdm-webhook-secret';

// backoff ตาม §2.3: 1m -> 5m -> 30m -> 2h -> 12h -> 24h -> 24h แล้ว DEAD (7 ช่วงเวลา = สูงสุด 8 ครั้ง)
const BACKOFF_MINUTES = [1, 5, 30, 120, 720, 1440, 1440];

function buildEventBody(row) {
  const data = row.payload || {};
  return JSON.stringify({
    eventId: row.event_id,
    sequence: Number(row.sequence),
    eventType: row.event_type,
    personId: row.person_id,
    occurredAt: row.occurred_at,
    version: row.version,
    changedFields: row.changed_fields || [],
    data: {
      status: data.status ?? null,
      verificationStatus: data.verificationStatus ?? null,
      mergedIntoPersonId: data.mergedIntoPersonId ?? null,
    },
  });
}

// ประมวลผล delivery ทีละแถวในธุรกรรมสั้นๆ ของตัวเอง (ไม่ถือ lock ค้างไว้ตลอดทั้ง batch ระหว่างรอ
// เครือข่าย) FOR UPDATE ... SKIP LOCKED กัน worker หลายตัวแย่งกันส่ง delivery เดียวกันซ้ำ
async function attemptOneDelivery({ pool, vault, fetchImpl, now, deliveryId }) {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT wd.delivery_id, wd.subscription_id, wd.attempt_count,
              ws.url, ws.secret_enc,
              oe.event_id, oe.sequence, oe.event_type, oe.person_id, oe.occurred_at, oe.version, oe.changed_fields, oe.payload
       FROM integration.webhook_delivery wd
       JOIN integration.webhook_subscription ws ON ws.subscription_id = wd.subscription_id
       JOIN integration.outbox_event oe ON oe.event_id = wd.event_id
       WHERE wd.delivery_id = $1 AND wd.status IN ('PENDING', 'FAILED') AND wd.next_attempt_at <= $2
       FOR UPDATE OF wd SKIP LOCKED`,
      [deliveryId, now()]
    );

    if (rows.length === 0) return null; // ถูก worker อื่นหยิบไปแล้ว หรือยังไม่ถึงเวลา/สถานะเปลี่ยนแล้ว

    const row = rows[0];
    const secretBuffer = await vault.decrypt(
      WEBHOOK_SECRET_KEY_NAME,
      Buffer.from(row.secret_enc).toString('utf8'),
      row.subscription_id
    );
    const secret = secretBuffer.toString('utf8');

    const timestamp = now().toISOString();
    const body = buildEventBody(row);
    const signature = signPayload(secret, timestamp, body);
    const attemptNumber = row.attempt_count + 1;

    let responseStatus = null;
    let errorMessage = null;
    let success = false;

    try {
      const res = await fetchImpl(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MDM-Event-Id': row.event_id,
          'X-MDM-Timestamp': timestamp,
          'X-MDM-Signature': signature,
          'X-MDM-Delivery-Attempt': String(attemptNumber),
        },
        body,
      });
      responseStatus = res.status;
      success = res.status >= 200 && res.status < 300;
      if (!success) errorMessage = `HTTP ${res.status}`;
    } catch (err) {
      errorMessage = err.message;
    }

    if (success) {
      await client.query(
        `UPDATE integration.webhook_delivery
         SET status = 'DELIVERED', attempt_count = $2, last_response_code = $3, last_error = NULL,
             delivered_at = now(), next_attempt_at = NULL
         WHERE delivery_id = $1`,
        [row.delivery_id, attemptNumber, responseStatus]
      );
      return { deliveryId: row.delivery_id, outcome: 'DELIVERED', attemptNumber };
    }

    if (attemptNumber > BACKOFF_MINUTES.length) {
      await client.query(
        `UPDATE integration.webhook_delivery
         SET status = 'DEAD', attempt_count = $2, last_response_code = $3, last_error = $4, next_attempt_at = NULL
         WHERE delivery_id = $1`,
        [row.delivery_id, attemptNumber, responseStatus, errorMessage]
      );
      return { deliveryId: row.delivery_id, outcome: 'DEAD', attemptNumber };
    }

    const delayMinutes = BACKOFF_MINUTES[attemptNumber - 1];
    await client.query(
      `UPDATE integration.webhook_delivery
       SET status = 'FAILED', attempt_count = $2, last_response_code = $3, last_error = $4,
           next_attempt_at = $5::timestamptz + ($6 || ' minutes')::interval
       WHERE delivery_id = $1`,
      [row.delivery_id, attemptNumber, responseStatus, errorMessage, now(), delayMinutes]
    );
    return { deliveryId: row.delivery_id, outcome: 'FAILED', attemptNumber, nextDelayMinutes: delayMinutes };
  });
}

async function runWebhookAttempt({ pool, vault, fetchImpl = fetch, now = () => new Date(), batchSize = 50 }) {
  const { rows: due } = await pool.query(
    `SELECT delivery_id FROM integration.webhook_delivery
     WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= $1
     ORDER BY next_attempt_at
     LIMIT $2`,
    [now(), batchSize]
  );

  const results = [];
  for (const { delivery_id: deliveryId } of due) {
    const result = await attemptOneDelivery({ pool, vault, fetchImpl, now, deliveryId });
    if (result) results.push(result);
  }
  return { processed: results.length, results };
}

module.exports = { runWebhookAttempt, attemptOneDelivery, BACKOFF_MINUTES, buildEventBody };
