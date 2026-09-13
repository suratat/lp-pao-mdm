const { createPools } = require('./pools');
const { createFakeVaultClient } = require('../src/security/vault');
const { runOutboxDispatch } = require('../src/jobs/outboxDispatch');
const { runWebhookAttempt, BACKOFF_MINUTES } = require('../src/jobs/webhookAttempt');
const { verifySignature } = require('../src/services/webhookSigner');
const {
  insertActivePerson,
  insertConsumerSystem,
  insertWebhookSubscription,
  insertOutboxEvent,
} = require('./fixtures');

// adminPool: เตรียม fixture (mdm_worker ไม่มีสิทธิ์ INSERT webhook_subscription โดยเจตนา - เป็นงานของ T5)
// pool: connection จริงของ worker (mdm_worker) ที่ job function ภายใต้การทดสอบใช้
let adminPool;
let pool;
let vault;

beforeAll(() => {
  ({ adminPool, workerPool: pool } = createPools());
  vault = createFakeVaultClient();
});

afterAll(async () => {
  await adminPool.end();
  await pool.end();
});

// runOutboxDispatch/runWebhookAttempt สแกนทั้งตาราง (ตามที่ควรเป็นสำหรับ background dispatcher จริง)
// จึงต้องล้าง fixture ของเทสก่อนหน้าออกก่อนทุกเทส ไม่งั้นแถวที่ค้างจากเทสอื่นจะมาปนในผลลัพธ์ที่นับจำนวน
beforeEach(async () => {
  await adminPool.query(
    'TRUNCATE integration.webhook_delivery, integration.webhook_subscription, integration.outbox_event CASCADE'
  );
});

// mock receiver: บันทึกทุก call ไว้ตรวจสอบ (headers/body) แทนการเปิด socket จริง - ยัง exercise
// โค้ด sign/verify ทั้งหมดจริง เพียงแต่ไม่ผ่าน network จริง (url ที่เก็บใน DB ยังต้องผ่าน
// webhook_subscription_https_only_ck ของ T1 อยู่ดี)
function fakeReceiver(responses) {
  let i = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r.throw) throw new Error(r.throw);
    return { status: r.status };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function getDelivery(subscriptionId, eventId) {
  const { rows } = await pool.query(
    `SELECT * FROM integration.webhook_delivery WHERE subscription_id = $1 AND event_id = $2`,
    [subscriptionId, eventId]
  );
  return rows[0];
}

describe('outbox-dispatch (fan-out)', () => {
  test('สร้าง webhook_delivery ต่อ subscription ที่สมัคร event_type นี้ และ idempotent เมื่อรันซ้ำ', async () => {
    const personId = await insertActivePerson(adminPool);
    const consumerSystemId = await insertConsumerSystem(adminPool);
    const subscriptionId = await insertWebhookSubscription(adminPool, vault, {
      consumerSystemId,
      url: 'https://example.lp-pao.go.th/hooks/mdm',
      eventTypes: ['IDENTITY_UPDATED'],
      secretPlain: 'webhook-secret-1',
    });
    const event = await insertOutboxEvent(adminPool, { personId, eventType: 'IDENTITY_UPDATED' });

    await runOutboxDispatch({ pool });
    await runOutboxDispatch({ pool }); // รันซ้ำ - ต้อง idempotent (ไม่ fan-out ซ้ำ)

    const { rows } = await pool.query(
      `SELECT * FROM integration.webhook_delivery WHERE subscription_id = $1 AND event_id = $2`,
      [subscriptionId, event.event_id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PENDING');

    const outbox = await pool.query(`SELECT published_at FROM integration.outbox_event WHERE event_id = $1`, [
      event.event_id,
    ]);
    expect(outbox.rows[0].published_at).not.toBeNull();
  });

  test('ไม่ fan-out ไป subscription ที่ไม่ได้สมัคร event_type นี้', async () => {
    const personId = await insertActivePerson(adminPool);
    const consumerSystemId = await insertConsumerSystem(adminPool);
    await insertWebhookSubscription(adminPool, vault, {
      consumerSystemId,
      url: 'https://example.lp-pao.go.th/hooks/other',
      eventTypes: ['PERSON_DEACTIVATED'],
      secretPlain: 'x',
    });
    const event = await insertOutboxEvent(adminPool, { personId, eventType: 'IDENTITY_UPDATED' });

    await runOutboxDispatch({ pool });

    const { rows } = await pool.query(`SELECT * FROM integration.webhook_delivery WHERE event_id = $1`, [
      event.event_id,
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe('webhook-attempt (ส่ง, ตรวจลายเซ็น, retry ตาม backoff, DEAD)', () => {
  test('ส่งสำเร็จ (2xx) -> DELIVERED, ลายเซ็นตรวจผ่านจริงด้วย verifySignature อิสระ, ไม่มีข้อมูลส่วนบุคคลใน payload', async () => {
    const personId = await insertActivePerson(adminPool);
    const consumerSystemId = await insertConsumerSystem(adminPool);
    const secretPlain = 'webhook-secret-2';
    const subscriptionId = await insertWebhookSubscription(adminPool, vault, {
      consumerSystemId,
      url: 'https://example.lp-pao.go.th/hooks/ok',
      eventTypes: ['IDENTITY_UPDATED'],
      secretPlain,
    });
    const event = await insertOutboxEvent(adminPool, {
      personId,
      eventType: 'IDENTITY_UPDATED',
      changedFields: ['identity.last_name_th'],
    });
    await runOutboxDispatch({ pool });

    const receiver = fakeReceiver([{ status: 200 }]);
    await runWebhookAttempt({ pool, vault, fetchImpl: receiver });

    expect(receiver.calls).toHaveLength(1);
    const { url, options } = receiver.calls[0];
    expect(url).toBe('https://example.lp-pao.go.th/hooks/ok');
    expect(options.headers['X-MDM-Event-Id']).toBe(event.event_id);
    expect(options.headers['X-MDM-Delivery-Attempt']).toBe('1');

    const signatureValid = verifySignature(
      secretPlain,
      options.headers['X-MDM-Timestamp'],
      options.body,
      options.headers['X-MDM-Signature']
    );
    expect(signatureValid).toBe(true);

    const parsedBody = JSON.parse(options.body);
    expect(Object.keys(parsedBody).sort()).toEqual(
      ['changedFields', 'data', 'eventId', 'eventType', 'occurredAt', 'personId', 'sequence', 'version'].sort()
    );
    expect(parsedBody.data).toEqual({ status: 'ACTIVE', verificationStatus: 'VERIFIED', mergedIntoPersonId: null });

    const delivery = await getDelivery(subscriptionId, event.event_id);
    expect(delivery.status).toBe('DELIVERED');
    expect(delivery.attempt_count).toBe(1);
    expect(delivery.delivered_at).not.toBeNull();

    // idempotent: เรียกซ้ำหลัง DELIVERED แล้วต้องไม่ส่งซ้ำอีก
    const receiverAgain = fakeReceiver([{ status: 200 }]);
    await runWebhookAttempt({ pool, vault, fetchImpl: receiverAgain });
    expect(receiverAgain.calls).toHaveLength(0);
  });

  test('ส่งไม่สำเร็จ (500) -> FAILED พร้อม next_attempt_at ตาม backoff ตัวแรก (1 นาที)', async () => {
    const personId = await insertActivePerson(adminPool);
    const consumerSystemId = await insertConsumerSystem(adminPool);
    const subscriptionId = await insertWebhookSubscription(adminPool, vault, {
      consumerSystemId,
      url: 'https://example.lp-pao.go.th/hooks/fail',
      eventTypes: ['IDENTITY_UPDATED'],
      secretPlain: 'x',
    });
    const event = await insertOutboxEvent(adminPool, { personId, eventType: 'IDENTITY_UPDATED' });
    await runOutboxDispatch({ pool });

    // fan-out ตั้ง next_attempt_at = now() จริงของ DB ตอน INSERT ดังนั้น "now" ที่ใช้ทดสอบต้องอยู่
    // "หลัง" เวลานั้น ไม่ใช่วันที่ในอดีตที่แต่งขึ้นเอง (ไม่งั้นแถวจะยังไม่ถึงกำหนดและไม่ถูกหยิบมาทำ)
    const fixedNow = new Date();
    await runWebhookAttempt({ pool, vault, fetchImpl: fakeReceiver([{ status: 500 }]), now: () => fixedNow });

    const delivery = await getDelivery(subscriptionId, event.event_id);
    expect(delivery.status).toBe('FAILED');
    expect(delivery.attempt_count).toBe(1);
    expect(delivery.last_response_code).toBe(500);
    expect(new Date(delivery.next_attempt_at).getTime()).toBe(fixedNow.getTime() + BACKOFF_MINUTES[0] * 60000);
  });

  test('ยังไม่ถึงเวลา next_attempt_at -> ไม่ถูกหยิบมาส่งซ้ำ', async () => {
    const personId = await insertActivePerson(adminPool);
    const consumerSystemId = await insertConsumerSystem(adminPool);
    const subscriptionId = await insertWebhookSubscription(adminPool, vault, {
      consumerSystemId,
      url: 'https://example.lp-pao.go.th/hooks/notyet',
      eventTypes: ['IDENTITY_UPDATED'],
      secretPlain: 'x',
    });
    const event = await insertOutboxEvent(adminPool, { personId, eventType: 'IDENTITY_UPDATED' });
    await runOutboxDispatch({ pool });

    const t0 = new Date();
    await runWebhookAttempt({ pool, vault, fetchImpl: fakeReceiver([{ status: 500 }]), now: () => t0 });

    const tooSoon = new Date(t0.getTime() + 30 * 1000);
    const receiver = fakeReceiver([{ status: 200 }]);
    await runWebhookAttempt({ pool, vault, fetchImpl: receiver, now: () => tooSoon });
    expect(receiver.calls).toHaveLength(0);

    const delivery = await getDelivery(subscriptionId, event.event_id);
    expect(delivery.status).toBe('FAILED');
    expect(delivery.attempt_count).toBe(1);
  });

  test('ล้มเหลวต่อเนื่องจนครบ backoff schedule (8 ครั้ง) -> DEAD', async () => {
    const personId = await insertActivePerson(adminPool);
    const consumerSystemId = await insertConsumerSystem(adminPool);
    const subscriptionId = await insertWebhookSubscription(adminPool, vault, {
      consumerSystemId,
      url: 'https://example.lp-pao.go.th/hooks/dead',
      eventTypes: ['IDENTITY_UPDATED'],
      secretPlain: 'x',
    });
    const event = await insertOutboxEvent(adminPool, { personId, eventType: 'IDENTITY_UPDATED' });
    await runOutboxDispatch({ pool });

    let currentTime = new Date();

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await runWebhookAttempt({ pool, vault, fetchImpl: fakeReceiver([{ status: 503 }]), now: () => currentTime });
      const delivery = await getDelivery(subscriptionId, event.event_id);
      expect(delivery.attempt_count).toBe(attempt);

      if (attempt <= BACKOFF_MINUTES.length) {
        expect(delivery.status).toBe('FAILED');
        currentTime = new Date(delivery.next_attempt_at);
      } else {
        expect(delivery.status).toBe('DEAD');
      }
    }
  });

  test('network error (throw) ก็นับเป็นความล้มเหลวและ backoff เหมือนกัน', async () => {
    const personId = await insertActivePerson(adminPool);
    const consumerSystemId = await insertConsumerSystem(adminPool);
    const subscriptionId = await insertWebhookSubscription(adminPool, vault, {
      consumerSystemId,
      url: 'https://example.lp-pao.go.th/hooks/timeout',
      eventTypes: ['IDENTITY_UPDATED'],
      secretPlain: 'x',
    });
    const event = await insertOutboxEvent(adminPool, { personId, eventType: 'IDENTITY_UPDATED' });
    await runOutboxDispatch({ pool });

    await runWebhookAttempt({ pool, vault, fetchImpl: fakeReceiver([{ throw: 'timeout' }]) });

    const delivery = await getDelivery(subscriptionId, event.event_id);
    expect(delivery.status).toBe('FAILED');
    expect(delivery.last_error).toBe('timeout');
    expect(delivery.last_response_code).toBeNull();
  });
});
