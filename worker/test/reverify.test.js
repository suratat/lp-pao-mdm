const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');
const { runReverifyScan } = require('../src/jobs/reverifyScan');
const { runReverifyEscalate } = require('../src/jobs/reverifyEscalate');
const { createFakeCheckClient } = require('../src/services/checkClient');
const { insertActivePerson } = require('./fixtures');

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

async function getVerificationStatus(personId) {
  const { rows } = await pool.query(`SELECT verification_status FROM mdm.person WHERE person_id = $1`, [personId]);
  return rows[0].verification_status;
}

describe('reverify-scan (seq-02 Phase A)', () => {
  test('thaid_verified_at เกิน REVERIFY_MAX_AGE (180 วัน) -> STALE + revoke session + outbox VERIFICATION_STALE', async () => {
    const oldVerifiedAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const personId = await insertActivePerson(pool, { thaidVerifiedAt: oldVerifiedAt });
    const checkClient = createFakeCheckClient();

    const result = await runReverifyScan({ pool, checkClient });
    expect(result.staleCount).toBeGreaterThanOrEqual(1);

    const person = await pool.query(
      `SELECT verification_status, reverify_due_at FROM mdm.person WHERE person_id = $1`,
      [personId]
    );
    expect(person.rows[0].verification_status).toBe('STALE');
    expect(person.rows[0].reverify_due_at).not.toBeNull();

    expect(checkClient.calls.some((c) => c.personId === personId)).toBe(true);

    const outbox = await pool.query(
      `SELECT event_type FROM integration.outbox_event WHERE person_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [personId]
    );
    expect(outbox.rows[0].event_type).toBe('VERIFICATION_STALE');
  });

  test('บัตรใกล้หมดอายุภายใน 60 วัน -> STALE แม้ thaid_verified_at ยังใหม่', async () => {
    const nearExpiry = new Date();
    nearExpiry.setDate(nearExpiry.getDate() + 30);
    const personId = await insertActivePerson(pool, {
      thaidVerifiedAt: new Date(),
      idCardExpireDate: nearExpiry.toISOString().slice(0, 10),
    });

    await runReverifyScan({ pool, checkClient: createFakeCheckClient() });

    expect(await getVerificationStatus(personId)).toBe('STALE');
  });

  test('reverify_requested_at ถูกตั้งโดย HR -> STALE ทันทีแม้ยังไม่ครบกำหนดอื่น', async () => {
    const personId = await insertActivePerson(pool, { reverifyRequestedAt: new Date() });

    await runReverifyScan({ pool, checkClient: createFakeCheckClient() });

    expect(await getVerificationStatus(personId)).toBe('STALE');
  });

  test('person ปกติ (verified ใหม่ บัตรยังไม่ใกล้หมดอายุ ไม่มีคำขอ) -> ไม่ถูกแตะ', async () => {
    const personId = await insertActivePerson(pool);
    const checkClient = createFakeCheckClient();

    await runReverifyScan({ pool, checkClient });

    expect(await getVerificationStatus(personId)).toBe('VERIFIED');
    expect(checkClient.calls.some((c) => c.personId === personId)).toBe(false);
  });

  test('รันซ้ำไม่สร้าง outbox_event ซ้ำ (รอบสองไม่พบ candidate เพราะสถานะเปลี่ยนเป็น STALE แล้ว)', async () => {
    const oldVerifiedAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const personId = await insertActivePerson(pool, { thaidVerifiedAt: oldVerifiedAt });

    await runReverifyScan({ pool, checkClient: createFakeCheckClient() });
    await runReverifyScan({ pool, checkClient: createFakeCheckClient() });

    const outbox = await pool.query(
      `SELECT count(*)::int AS n FROM integration.outbox_event WHERE person_id = $1 AND event_type = 'VERIFICATION_STALE'`,
      [personId]
    );
    expect(outbox.rows[0].n).toBe(1);
  });

  test('check.lp-pao.go.th ล้มเหลว (best-effort) -> ยังคงอยู่ STALE ไม่ rollback', async () => {
    const oldVerifiedAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const personId = await insertActivePerson(pool, { thaidVerifiedAt: oldVerifiedAt });
    const failingCheckClient = {
      calls: [],
      async revokeSessions() {
        throw new Error('check unreachable');
      },
    };

    await runReverifyScan({ pool, checkClient: failingCheckClient });

    expect(await getVerificationStatus(personId)).toBe('STALE');
  });
});

describe('reverify-escalate (seq-02 Phase C)', () => {
  test('STALE ที่พ้น grace period -> EXPIRED + outbox VERIFICATION_EXPIRED', async () => {
    const personId = await insertActivePerson(pool, {
      verificationStatus: 'STALE',
      reverifyDueAt: new Date(Date.now() - 1000),
    });

    const result = await runReverifyEscalate({ pool });
    expect(result.expiredCount).toBeGreaterThanOrEqual(1);

    expect(await getVerificationStatus(personId)).toBe('EXPIRED');

    const outbox = await pool.query(
      `SELECT event_type FROM integration.outbox_event WHERE person_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [personId]
    );
    expect(outbox.rows[0].event_type).toBe('VERIFICATION_EXPIRED');
  });

  test('STALE ที่ยังไม่พ้น grace period -> ไม่ถูกแตะ', async () => {
    const personId = await insertActivePerson(pool, {
      verificationStatus: 'STALE',
      reverifyDueAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });

    await runReverifyEscalate({ pool });

    expect(await getVerificationStatus(personId)).toBe('STALE');
  });
});
