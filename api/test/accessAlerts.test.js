const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { makeFakePid } = require('../src/security/pid');

// PR-C: GET /audit/alerts, POST /audit/alerts/{id}/ack|close - ตาราง append-only, สถานะคำนวณจาก action ล่าสุด, ต้อง scope audit:review + role dpo,
// ห้ามดำเนินการกับ alert ของตัวเอง (alert ถูกสร้างโดย worker - ที่นี่แทรกตรงด้วย adminPool)

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

const uniqueSub = (prefix) => `${prefix}-${crypto.randomUUID()}`;

// คืน object ที่ไม่ใช่ thenable เพื่อให้ `(await api(...)).send()/.query()` ทำงาน (การ await supertest Test ตรงๆ จะยิง request ทันที)
async function api(method, urlPath, auth = {}) {
  const token = await ctx.auth.signToken(auth);
  const pending = (body, query) => ({
    then: (resolve, reject) => {
      let req = request(ctx.app)[method](`/api/v1${urlPath}`).set('Authorization', `Bearer ${token}`);
      if (query) req = req.query(query);
      if (body !== undefined) req = req.send(body);
      return req.then(resolve, reject);
    },
  });
  return { send: (body) => pending(body), query: (query) => pending(undefined, query) };
}

const dpo = (sub) => ({ scope: 'audit:read audit:review', sub, azp: 'dpo-console', roles: ['dpo'] });
const act = async (alertId, action, body, auth) => (await api('post', `/audit/alerts/${alertId}/${action}`, auth)).send(body ?? {});
const list = async (query, scope = 'audit:read') => (await api('get', '/audit/alerts', { scope })).query(query);

async function insertAlert({ actor = uniqueSub('alert-actor'), rule = 'BULK_VIEW', detectedAt = null, severity = 'HIGH' } = {}) {
  const { rows } = await adminPool.query(
    `INSERT INTO audit.access_alert (rule_code, dedupe_key, severity, actor_sub, actor_client, window_start, window_end, metric_count, threshold, details, detected_at)
     VALUES ($1, $2, $3, $4, 'hr-console', now() - interval '10 minutes', now(), 31, 30, '{"distinctPersons": 31, "windowMinutes": 10}', COALESCE($5::timestamptz, now()))
     RETURNING alert_id`,
    [rule, `TEST:${crypto.randomUUID()}`, severity, actor, detectedAt]
  );
  return { alertId: Number(rows[0].alert_id), actor };
}

const actionRows = async (alertId) =>
  (await adminPool.query(`SELECT action, note, actor_sub, actor_client FROM audit.access_alert_action WHERE alert_id = $1 ORDER BY action_id`, [alertId])).rows;

describe('GET /audit/alerts', () => {
  test('ต้องมี scope audit:read; คืน alert พร้อมสถานะ OPEN และไม่มีข้อมูลบุคคล', async () => {
    const { alertId, actor } = await insertAlert();
    expect((await list({}, 'personnel:read:basic')).status).toBe(403);

    const res = await list({ actorSub: actor });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      alertId,
      ruleCode: 'BULK_VIEW',
      severity: 'HIGH',
      status: 'OPEN',
      actorSub: actor,
      actorClient: 'hr-console',
      metricCount: 31,
      threshold: 30,
      details: { distinctPersons: 31, windowMinutes: 10 },
      lastActionBy: null,
      lastActionAt: null,
      lastActionNote: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/\d{13}/);
  });

  test('สถานะคำนวณจาก action ล่าสุด: OPEN -> ACK -> CLOSED และ filter status ตามนั้น', async () => {
    const { alertId, actor } = await insertAlert();
    const reviewer = uniqueSub('dpo');
    const statusOf = async () => (await list({ actorSub: actor })).body.data[0];

    expect((await act(alertId, 'ack', { note: 'รับเรื่องแล้ว กำลังตรวจ' }, dpo(reviewer))).status).toBe(201);
    expect(await statusOf()).toMatchObject({ status: 'ACK', lastActionBy: reviewer, lastActionNote: 'รับเรื่องแล้ว กำลังตรวจ' });
    expect((await list({ actorSub: actor, status: 'ACK' })).body.data).toHaveLength(1);
    expect((await list({ actorSub: actor, status: 'OPEN' })).body.data).toHaveLength(0);

    expect((await act(alertId, 'close', { note: 'ตรวจแล้ว เป็นงานตามคำสั่ง' }, dpo(reviewer))).status).toBe(201);
    expect(await statusOf()).toMatchObject({ status: 'CLOSED', lastActionNote: 'ตรวจแล้ว เป็นงานตามคำสั่ง' });
    expect((await list({ actorSub: actor, status: 'CLOSED' })).body.data).toHaveLength(1);
    expect((await list({ actorSub: actor, status: 'ACK' })).body.data).toHaveLength(0);
    expect((await actionRows(alertId)).map((r) => r.action)).toEqual(['ACK', 'CLOSE']);
  });

  test('filter ruleCode / from / to และเรียงใหม่ -> เก่า + cursor ไม่ซ้ำ/ไม่ตกหล่น', async () => {
    const actor = uniqueSub('alert-page');
    const ids = [];
    for (const rule of ['BULK_VIEW', 'OFF_HOURS', 'PID_REVEAL_FREQUENT', 'OFF_HOURS', 'BULK_VIEW']) ids.push((await insertAlert({ actor, rule })).alertId);

    const all = (await list({ actorSub: actor, limit: 100 })).body.data;
    expect(all.map((a) => a.alertId)).toEqual([...ids].reverse());

    const seen = [];
    let cursor;
    for (let i = 0; i < 10; i += 1) {
      const page = await list({ actorSub: actor, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.body.data.map((a) => a.alertId));
      cursor = page.body.page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all.map((a) => a.alertId));

    expect((await list({ actorSub: actor, ruleCode: 'OFF_HOURS' })).body.data.map((a) => a.ruleCode)).toEqual(['OFF_HOURS', 'OFF_HOURS']);
    expect((await list({ actorSub: actor, from: new Date(Date.now() + 3600_000).toISOString() })).body.data).toEqual([]);
    expect((await list({ actorSub: actor, to: new Date(Date.now() - 3600_000).toISOString() })).body.data).toEqual([]);
  });
});

describe('POST /audit/alerts/{id}/ack และ /close', () => {
  test('ปิดเรื่องจาก OPEN ได้โดยตรง; ปิดแล้วทำอะไรต่อไม่ได้ (409)', async () => {
    const { alertId } = await insertAlert();
    const auth = dpo(uniqueSub('dpo'));
    const closed = await act(alertId, 'close', { note: 'ปิดเรื่อง ตรวจแล้วไม่พบความผิดปกติ' }, auth);
    expect(closed.status).toBe(201);
    expect(closed.body).toMatchObject({ alertId, action: 'CLOSE', status: 'CLOSED', actorSub: auth.sub });

    for (const action of ['ack', 'close']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await act(alertId, action, { note: 'ซ้ำ' }, auth);
      expect(res.status).toBe(409);
      expect(res.body.type).toMatch(/already-closed/);
    }
    expect(await actionRows(alertId)).toHaveLength(1);
  });

  test('รับทราบซ้ำ -> 409 already-acknowledged แต่ปิดเรื่องต่อจาก ACK ได้', async () => {
    const { alertId } = await insertAlert();
    const auth = dpo(uniqueSub('dpo'));
    expect((await act(alertId, 'ack', undefined, auth)).status).toBe(201); // ack ไม่ต้องมี note
    const again = await act(alertId, 'ack', {}, auth);
    expect(again.status).toBe(409);
    expect(again.body.type).toMatch(/already-acknowledged/);
    expect((await act(alertId, 'close', { note: 'เรียบร้อย' }, auth)).status).toBe(201);
  });

  test('ปิดเรื่องต้องมี note: ไม่ส่ง -> 400 (schema), ช่องว่างล้วน -> 422; ไม่เขียนแถว', async () => {
    const { alertId } = await insertAlert();
    const auth = dpo(uniqueSub('dpo'));
    expect((await act(alertId, 'close', {}, auth)).status).toBe(400);
    const blank = await act(alertId, 'close', { note: '   ' }, auth);
    expect(blank.status).toBe(422);
    expect(blank.body.type).toMatch(/note-required/);
    expect(await actionRows(alertId)).toEqual([]);
  });

  test('note ที่มีเลข 13 หลัก (ติดกัน/มีขีด) -> 422 และไม่สะท้อนค่ากลับ; ยาวเกิน 1000 -> 400', async () => {
    const { alertId } = await insertAlert();
    const auth = dpo(uniqueSub('dpo'));
    const pid = makeFakePid();
    const dashed = `${pid.slice(0, 1)}-${pid.slice(1, 5)}-${pid.slice(5, 10)}-${pid.slice(10, 12)}-${pid.slice(12)}`;
    for (const note of [`เลข ${pid}`, `เลข ${dashed}`]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await act(alertId, 'close', { note }, auth);
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).not.toContain(pid);
      expect(JSON.stringify(res.body)).not.toContain(dashed);
    }
    expect((await act(alertId, 'close', { note: 'ก'.repeat(1001) }, auth)).status).toBe(400);
    expect(await actionRows(alertId)).toEqual([]);
  });

  test('ห้ามดำเนินการกับ alert ของตัวเอง -> 403 self-alert-forbidden ไม่เขียนแถว', async () => {
    const same = uniqueSub('dpo-subject');
    const { alertId } = await insertAlert({ actor: same });
    for (const action of ['ack', 'close']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await act(alertId, action, { note: 'ลองดำเนินการเอง' }, dpo(same));
      expect(res.status).toBe(403);
      expect(res.body.type).toMatch(/self-alert-forbidden/);
    }
    expect(await actionRows(alertId)).toEqual([]);
  });

  test('สิทธิ์: ต้องมี scope audit:review และ role dpo (auditor / audit:read อย่างเดียว -> 403)', async () => {
    const { alertId } = await insertAlert();
    const body = { note: 'ทดสอบสิทธิ์' };

    const auditor = await act(alertId, 'close', body, { scope: 'audit:read audit:review', sub: uniqueSub('aud'), roles: ['auditor'] });
    expect(auditor.status).toBe(403);
    expect(auditor.body.type).toMatch(/insufficient-role/);
    const noScope = await act(alertId, 'close', body, { scope: 'audit:read', sub: uniqueSub('dpo'), roles: ['dpo'] });
    expect(noScope.status).toBe(403);
    expect(noScope.body.type).toMatch(/insufficient-scope/);
    expect((await act(alertId, 'ack', body, { scope: 'audit:review', sub: uniqueSub('x') })).status).toBe(403);
    expect(await actionRows(alertId)).toEqual([]);

    const viaRealm = await act(alertId, 'ack', body, { scope: 'audit:review', sub: uniqueSub('dpo'), realmRoles: ['dpo'] });
    expect(viaRealm.status).toBe(201);
  });

  test('alertId ไม่มีอยู่ -> 404', async () => {
    expect((await act(2_000_000_000, 'ack', {}, dpo(uniqueSub('dpo')))).status).toBe(404);
  });

  test('สองคนปิดเรื่องพร้อมกัน: สำเร็จคนเดียว อีกคน 409 (advisory lock serialize การกระทำต่อ alert เดียวกัน)', async () => {
    const { alertId } = await insertAlert();

    // ถือ advisory lock ตัวเดียวกับที่ API ใช้ไว้ก่อน (ผ่าน connection แยก) เพื่อให้ทั้งสอง request ไปค้างรอที่ล็อกแน่นอน แล้วค่อยปล่อย
    // - ถ้า API ไม่ล็อก ทั้งสองจะไม่ค้าง (เห็นสถานะ OPEN พร้อมกัน แล้วเขียน CLOSE ทั้งคู่) และเทสต์นี้จะรอไม่ได้ตามที่คาดจนล้ม
    const holder = await adminPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`access_alert:${alertId}`]);

      const both = Promise.all([
        act(alertId, 'close', { note: 'คนที่หนึ่ง' }, dpo(uniqueSub('dpo-a'))),
        act(alertId, 'close', { note: 'คนที่สอง' }, dpo(uniqueSub('dpo-b'))),
      ]);

      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (waiting < 2 && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        waiting = (await adminPool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rows[0].n;
        // eslint-disable-next-line no-await-in-loop
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(2);
      await holder.query('COMMIT');

      const [a, b] = await both;
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await actionRows(alertId)).toHaveLength(1);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  });

  test('actor_client ของผู้ดำเนินการถูกบันทึก (azp)', async () => {
    const { alertId } = await insertAlert();
    await act(alertId, 'ack', { note: 'x' }, dpo(uniqueSub('dpo')));
    expect((await actionRows(alertId))[0]).toMatchObject({ action: 'ACK', actor_client: 'dpo-console' });
  });
});

describe('audit.access_alert / access_alert_action: append-only และสิทธิ์', () => {
  test('mdm_app UPDATE/DELETE ไม่ได้ทั้งสองตาราง และเขียน access_alert เองไม่ได้ (เฉพาะ worker)', async () => {
    const { alertId } = await insertAlert();
    await act(alertId, 'ack', { note: 'x' }, dpo(uniqueSub('dpo')));
    await expect(ctx.pool.query(`UPDATE audit.access_alert SET severity = 'LOW' WHERE alert_id = $1`, [alertId])).rejects.toThrow();
    await expect(ctx.pool.query(`DELETE FROM audit.access_alert WHERE alert_id = $1`, [alertId])).rejects.toThrow();
    await expect(ctx.pool.query(`UPDATE audit.access_alert_action SET note = 'y' WHERE alert_id = $1`, [alertId])).rejects.toThrow();
    await expect(ctx.pool.query(`DELETE FROM audit.access_alert_action WHERE alert_id = $1`, [alertId])).rejects.toThrow();
    await expect(
      ctx.pool.query(
        `INSERT INTO audit.access_alert (rule_code, dedupe_key, severity, window_start, window_end, metric_count, threshold) VALUES ('BULK_VIEW', 'x', 'LOW', now(), now(), 1, 1)`
      )
    ).rejects.toThrow(/permission denied/);
  });

  test('แม้เป็นเจ้าของตาราง trigger ก็ปฏิเสธ UPDATE/DELETE; dedupe_key ซ้ำไม่ได้; CLOSE ไม่มี note ไม่ได้ (CHECK)', async () => {
    const { alertId } = await insertAlert();
    await expect(adminPool.query(`UPDATE audit.access_alert SET severity = 'LOW' WHERE alert_id = $1`, [alertId])).rejects.toThrow(/append-only/);
    await expect(adminPool.query(`DELETE FROM audit.access_alert WHERE alert_id = $1`, [alertId])).rejects.toThrow(/append-only/);

    const { rows } = await adminPool.query(`SELECT dedupe_key FROM audit.access_alert WHERE alert_id = $1`, [alertId]);
    await expect(
      adminPool.query(
        `INSERT INTO audit.access_alert (rule_code, dedupe_key, severity, window_start, window_end, metric_count, threshold) VALUES ('BULK_VIEW', $1, 'LOW', now(), now(), 1, 1)`,
        [rows[0].dedupe_key]
      )
    ).rejects.toThrow(/duplicate key|unique/i);

    await expect(adminPool.query(`INSERT INTO audit.access_alert_action (alert_id, action, actor_sub) VALUES ($1, 'CLOSE', 'x')`, [alertId])).rejects.toThrow(/check/i);
    await expect(adminPool.query(`INSERT INTO audit.access_alert_action (alert_id, action, note, actor_sub) VALUES ($1, 'CLOSE', '  ', 'x')`, [alertId])).rejects.toThrow(/check/i);
  });
});
