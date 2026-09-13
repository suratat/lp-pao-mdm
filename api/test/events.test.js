const request = require('supertest');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { FIXTURE_PERSON_ID } = require('../src/constants');

let ctx;
let adminPool;

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

async function insertEvent(eventType, extra = {}) {
  const { rows } = await adminPool.query(
    `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
     VALUES ($1, $2, $3, $4, $5) RETURNING event_id, sequence`,
    [
      FIXTURE_PERSON_ID,
      eventType,
      JSON.stringify(extra.changedFields || []),
      JSON.stringify({
        personId: FIXTURE_PERSON_ID,
        version: 1,
        status: 'ACTIVE',
        verificationStatus: 'VERIFIED',
        ...extra.payload,
      }),
      1,
    ]
  );
  return rows[0];
}

describe('GET /events (§2.3 pull feed)', () => {
  test('คืน event เรียงตาม sequence, ไม่มีข้อมูลส่วนบุคคลใน payload', async () => {
    const event = await insertEvent('IDENTITY_UPDATED', { changedFields: ['identity.last_name_th'] });
    const token = await ctx.auth.signToken({ scope: 'events:read' });

    const res = await request(ctx.app)
      .get(`/api/v1/events?after=${event.sequence - 1}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const found = res.body.data.find((e) => e.eventId === event.event_id);
    expect(found).toBeDefined();
    expect(found.sequence).toBe(Number(event.sequence)); // pg คืน bigint เป็น string, service แปลงเป็น number ให้แล้ว
    expect(found.personId).toBe(FIXTURE_PERSON_ID);
    expect(found.data).toEqual({ status: 'ACTIVE', verificationStatus: 'VERIFIED', mergedIntoPersonId: null });
    expect(Object.keys(found).sort()).toEqual(
      ['changedFields', 'data', 'eventId', 'eventType', 'occurredAt', 'personId', 'sequence', 'version'].sort()
    );
  });

  test('after ใช้กรองแบบ exclusive (ไม่คืน event ที่ sequence <= after)', async () => {
    const event = await insertEvent('IDENTITY_UPDATED');
    const token = await ctx.auth.signToken({ scope: 'events:read' });

    const res = await request(ctx.app)
      .get(`/api/v1/events?after=${event.sequence}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.find((e) => e.eventId === event.event_id)).toBeUndefined();
  });

  test('กรองด้วย eventType', async () => {
    const claimed = await insertEvent('PERSON_CLAIMED');
    const updated = await insertEvent('IDENTITY_UPDATED');
    const token = await ctx.auth.signToken({ scope: 'events:read' });

    const res = await request(ctx.app)
      .get(`/api/v1/events?after=0&eventType=PERSON_CLAIMED`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((e) => e.eventId);
    expect(ids).toContain(claimed.event_id);
    expect(ids).not.toContain(updated.event_id);
  });

  test('limit + hasMore ทำงานถูกต้อง', async () => {
    const events = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      events.push(await insertEvent('EMPLOYMENT_UPDATED'));
    }
    const token = await ctx.auth.signToken({ scope: 'events:read' });

    const res = await request(ctx.app)
      .get(`/api/v1/events?after=${events[0].sequence - 1}&limit=2`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.lastSequence).toBe(res.body.data[res.body.data.length - 1].sequence);
  });

  test('403 เมื่อไม่มี scope events:read', async () => {
    const token = await ctx.auth.signToken({ scope: 'personnel:read:basic' });
    const res = await request(ctx.app).get('/api/v1/events').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
