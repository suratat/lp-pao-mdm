const crypto = require('node:crypto');

async function insertActivePerson(pool, overrides = {}) {
  const personId = crypto.randomUUID();
  const pidHash = crypto.randomBytes(32).toString('hex');

  await pool.query(
    `INSERT INTO mdm.person
      (person_id, pid_hash, status, verification_status, thaid_verified_at, claimed_at, reverify_requested_at, reverify_due_at, version)
     VALUES ($1, $2, 'ACTIVE', $3, $4, now(), $5, $6, 1)`,
    [
      personId,
      pidHash,
      overrides.verificationStatus ?? 'VERIFIED',
      overrides.thaidVerifiedAt ?? new Date(),
      overrides.reverifyRequestedAt ?? null,
      overrides.reverifyDueAt ?? null,
    ]
  );

  await pool.query(
    `INSERT INTO mdm.person_identity (person_id, first_name_th, last_name_th, id_card_expire_date, synced_at)
     VALUES ($1, 'ทดสอบ', 'ระบบ', $2, now())`,
    [personId, overrides.idCardExpireDate ?? '2099-01-01']
  );

  return personId;
}

async function insertConsumerSystem(pool) {
  const consumerSystemId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mdm.consumer_system (consumer_system_id, keycloak_client_id, name, purpose_code, status)
     VALUES ($1, $2, 'ระบบทดสอบ', 'HR_ADMIN', 'ACTIVE')`,
    [consumerSystemId, `test-client-${consumerSystemId}`]
  );
  return consumerSystemId;
}

// สร้าง webhook_subscription โดยเข้ารหัส secret ด้วย vault client เดียวกับที่ worker ใช้ตอนทดสอบ
// (จำลองสิ่งที่ POST /webhooks/subscriptions ของ T5 จะทำจริง) ผูก context = subscription_id
async function insertWebhookSubscription(pool, vault, { consumerSystemId, url, eventTypes, secretPlain }) {
  const subscriptionId = crypto.randomUUID();
  const { ciphertext } = await vault.encrypt('mdm-webhook-secret', Buffer.from(secretPlain, 'utf8'), subscriptionId);

  await pool.query(
    `INSERT INTO integration.webhook_subscription (subscription_id, consumer_system_id, url, secret_enc, event_types, is_active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [subscriptionId, consumerSystemId, url, Buffer.from(ciphertext, 'utf8'), JSON.stringify(eventTypes)]
  );

  return subscriptionId;
}

async function insertOutboxEvent(pool, { personId, eventType, changedFields = [], status = 'ACTIVE', verificationStatus = 'VERIFIED', version = 1 }) {
  const { rows } = await pool.query(
    `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
     VALUES ($1, $2, $3, $4, $5) RETURNING event_id, sequence`,
    [
      personId,
      eventType,
      JSON.stringify(changedFields),
      JSON.stringify({ personId, version, status, verificationStatus }),
      version,
    ]
  );
  return rows[0];
}

module.exports = { insertActivePerson, insertConsumerSystem, insertWebhookSubscription, insertOutboxEvent };
