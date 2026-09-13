const crypto = require('node:crypto');
const { HttpProblem } = require('../security/httpProblem');
const { validateWebhookUrl } = require('../security/webhookUrl');
const { signPayload } = require('../security/webhookSigner');

const WEBHOOK_SECRET_KEY_NAME = 'mdm-webhook-secret';

// endpoint กลุ่ม Webhooks ทั้งหมดขอบเขตอยู่ที่ consumer_system ของ client ที่เรียก (จาก JWT azp)
async function resolveConsumerSystemId(pool, azp) {
  const { rows } = await pool.query(
    `SELECT consumer_system_id FROM mdm.consumer_system WHERE keycloak_client_id = $1 AND status = 'ACTIVE'`,
    [azp]
  );
  if (rows.length === 0) {
    throw new HttpProblem(
      403,
      'not-registered-consumer',
      'client นี้ยังไม่ได้ลงทะเบียนเป็น consumer_system',
      'ติดต่อผู้ดูแล MDM เพื่อลงทะเบียน consumer_system ก่อนใช้ webhook'
    );
  }
  return rows[0].consumer_system_id;
}

function presentSubscription(row) {
  return {
    subscriptionId: row.subscription_id,
    url: row.url,
    eventTypes: row.event_types,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

function presentDelivery(row) {
  return {
    deliveryId: row.delivery_id,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    status: row.status,
    attemptCount: row.attempt_count,
    // nextAttemptAt/deliveredAt เป็น {type: [string,'null'], format: date-time} (nullable แบบ array) -
    // ต้องแปลง Date เป็น ISO string เอง (ดูคอมเมนต์เดียวกันใน personPresenter.js)
    nextAttemptAt: row.next_attempt_at ? row.next_attempt_at.toISOString() : null,
    lastResponseCode: row.last_response_code,
    lastError: row.last_error,
    deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
  };
}

async function listWebhookSubscriptions(pool, azp) {
  const consumerSystemId = await resolveConsumerSystemId(pool, azp);
  const { rows } = await pool.query(
    `SELECT * FROM integration.webhook_subscription WHERE consumer_system_id = $1 ORDER BY created_at`,
    [consumerSystemId]
  );
  return rows.map(presentSubscription);
}

async function createWebhookSubscription({ pool, vault }, azp, { url, eventTypes }) {
  const consumerSystemId = await resolveConsumerSystemId(pool, azp);
  validateWebhookUrl(url);

  const secret = crypto.randomBytes(32).toString('hex');
  const subscriptionId = crypto.randomUUID();
  const { ciphertext, keyId } = await vault.encrypt(
    WEBHOOK_SECRET_KEY_NAME,
    Buffer.from(secret, 'utf8'),
    subscriptionId
  );

  await pool.query(
    `INSERT INTO integration.webhook_subscription
      (subscription_id, consumer_system_id, url, secret_enc, key_id, event_types, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [subscriptionId, consumerSystemId, url, Buffer.from(ciphertext, 'utf8'), keyId, JSON.stringify(eventTypes)]
  );

  const { rows } = await pool.query(`SELECT * FROM integration.webhook_subscription WHERE subscription_id = $1`, [
    subscriptionId,
  ]);
  return { ...presentSubscription(rows[0]), secret };
}

async function deleteWebhookSubscription(pool, azp, subscriptionId) {
  const consumerSystemId = await resolveConsumerSystemId(pool, azp);
  const { rowCount } = await pool.query(
    `DELETE FROM integration.webhook_subscription WHERE subscription_id = $1 AND consumer_system_id = $2`,
    [subscriptionId, consumerSystemId]
  );
  if (rowCount === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบ subscription นี้', undefined);
}

// ping ทดสอบ - ไม่ผูกกับบุคคลจริงจึงไม่บันทึกเป็น outbox_event/webhook_delivery ถาวร (outbox_event มี FK
// ไปบุคคลจริงเสมอ) คืนผลการส่งแบบ ephemeral ตรงตาม operation "ส่งเหตุการณ์ทดสอบ" เท่านั้น
async function testWebhookSubscription({ pool, vault, fetchImpl = fetch }, azp, subscriptionId) {
  const consumerSystemId = await resolveConsumerSystemId(pool, azp);
  const { rows } = await pool.query(
    `SELECT * FROM integration.webhook_subscription WHERE subscription_id = $1 AND consumer_system_id = $2`,
    [subscriptionId, consumerSystemId]
  );
  if (rows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบ subscription นี้', undefined);
  const subscription = rows[0];

  const secretBuffer = await vault.decrypt(
    WEBHOOK_SECRET_KEY_NAME,
    Buffer.from(subscription.secret_enc).toString('utf8'),
    subscriptionId
  );
  const secret = secretBuffer.toString('utf8');

  const eventId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({
    eventId,
    sequence: 0,
    eventType: subscription.event_types[0] || 'IDENTITY_UPDATED',
    personId: '00000000-0000-0000-0000-000000000000',
    occurredAt: timestamp,
    version: 0,
    changedFields: [],
    data: { status: 'ACTIVE', verificationStatus: 'VERIFIED', mergedIntoPersonId: null },
  });
  const signature = signPayload(secret, timestamp, body);

  let status = 'FAILED';
  let responseCode = null;
  let errorMessage = null;
  try {
    const res = await fetchImpl(subscription.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MDM-Event-Id': eventId,
        'X-MDM-Timestamp': timestamp,
        'X-MDM-Signature': signature,
        'X-MDM-Delivery-Attempt': '1',
      },
      body,
      redirect: 'error',
    });
    responseCode = res.status;
    status = res.status >= 200 && res.status < 300 ? 'DELIVERED' : 'FAILED';
  } catch (err) {
    errorMessage = err.message;
  }

  return {
    deliveryId: crypto.randomUUID(),
    subscriptionId,
    eventId,
    status,
    attemptCount: 1,
    nextAttemptAt: null,
    lastResponseCode: responseCode,
    lastError: errorMessage,
    deliveredAt: status === 'DELIVERED' ? timestamp : null,
  };
}

async function listWebhookDeliveries(pool, azp, { status, cursor, limit }) {
  const consumerSystemId = await resolveConsumerSystemId(pool, azp);
  const conditions = ['ws.consumer_system_id = $1'];
  const params = [consumerSystemId];

  if (status && status.length > 0) {
    params.push(status);
    conditions.push(`wd.status = ANY($${params.length}::text[])`);
  }
  if (cursor) {
    params.push(cursor);
    conditions.push(`wd.delivery_id > $${params.length}`);
  }
  params.push(limit + 1);

  const { rows } = await pool.query(
    `SELECT wd.* FROM integration.webhook_delivery wd
     JOIN integration.webhook_subscription ws ON ws.subscription_id = wd.subscription_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY wd.delivery_id
     LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    data: page.map(presentDelivery),
    page: { nextCursor: hasMore ? page[page.length - 1].delivery_id : null, limit },
  };
}

async function retryWebhookDelivery(pool, azp, deliveryId) {
  const consumerSystemId = await resolveConsumerSystemId(pool, azp);
  const { rows } = await pool.query(
    `SELECT wd.delivery_id FROM integration.webhook_delivery wd
     JOIN integration.webhook_subscription ws ON ws.subscription_id = wd.subscription_id
     WHERE wd.delivery_id = $1 AND ws.consumer_system_id = $2 AND wd.status = 'DEAD'`,
    [deliveryId, consumerSystemId]
  );
  if (rows.length === 0) {
    throw new HttpProblem(404, 'not-found', 'ไม่พบ delivery ที่เป็น DEAD ตามที่ระบุ', undefined);
  }

  await pool.query(
    `UPDATE integration.webhook_delivery SET status = 'PENDING', next_attempt_at = now() WHERE delivery_id = $1`,
    [deliveryId]
  );
}

module.exports = {
  listWebhookSubscriptions,
  createWebhookSubscription,
  deleteWebhookSubscription,
  testWebhookSubscription,
  listWebhookDeliveries,
  retryWebhookDelivery,
};
