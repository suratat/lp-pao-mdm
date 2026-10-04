const crypto = require('node:crypto');
const request = require('supertest');
const { buildTestApp } = require('./testApp');
const { makeFakePid } = require('../src/security/pid');
const { insertFixtureOrgUnit } = require('./fixtures');

// PR-B (DPO): รีวิวการเปิดเลขบัตร - audit.pid_access_review (append-only, อ้าง (access_id, accessed_at) ไม่ใช้ FK)
// ข้อมูลทั้งหมดสมมติ (pid จาก makeFakePid())

let ctx;
let orgUnitId;

beforeAll(async () => {
  ctx = await buildTestApp();
  orgUnitId = await insertFixtureOrgUnit(ctx.pool);
});

afterAll(async () => {
  await ctx.pool.end();
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

async function makePerson() {
  const pid = makeFakePid();
  const { rows } = await ctx.pool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบรีวิว', 'GENERAL', $2) RETURNING position_id`,
    [`POS-REVIEW-${crypto.randomUUID()}`, orgUnitId]
  );
  const res = await (await api('post', '/persons', { scope: 'personnel:provision personnel:read:basic' })).send({
    pid,
    expectedFirstNameTh: 'ก',
    expectedLastNameTh: 'ข',
    employment: {
      employeeNo: pid,
      personnelType: 'CIVIL_SERVANT',
      positionId: rows[0].position_id,
      orgUnitId,
      effectiveFrom: '2024-01-01',
    },
  });
  expect(res.status).toBe(201);
  return { personId: res.body.personId, pid };
}

// เปิดเลขบัตรจริงผ่าน API (เขียน access_log ด้วย endpoint ไม่มี query string) แล้วคืนแถว access_log ของครั้งนั้น
async function reveal(personId, sub, justification = 'ตรวจสอบสิทธิ์เบิกจ่ายเงินเดือนประจำเดือน') {
  const res = await (await api('get', `/persons/${personId}/pid`, { scope: 'personnel:read:pid', sub, azp: 'hr-console' })).query({
    justification,
  });
  expect(res.status).toBe(200);
  const { rows } = await ctx.pool.query(
    `SELECT access_id, accessed_at, endpoint FROM audit.access_log
     WHERE subject_person_id = $1 AND actor_sub = $2 ORDER BY access_id DESC LIMIT 1`,
    [personId, sub]
  );
  return { accessId: Number(rows[0].access_id), accessedAt: rows[0].accessed_at.toISOString(), endpoint: rows[0].endpoint };
}

const dpo = (sub) => ({ scope: 'audit:read audit:review', sub, azp: 'dpo-console', roles: ['dpo'] });
const review = async (accessId, body, auth) => (await api('post', `/audit/access-logs/${accessId}/review`, auth)).send(body);
const listLogs = async (query, scope = 'audit:read') => (await api('get', '/audit/access-logs', { scope })).query(query);

async function reviewRows(accessId) {
  const { rows } = await ctx.pool.query(
    `SELECT status, note, reviewer_sub, reviewer_client FROM audit.pid_access_review WHERE access_id = $1 ORDER BY review_id`,
    [accessId]
  );
  return rows;
}

describe('justification ที่มีเลข 13 หลัก -> 422 (ไม่เขียน access_log, ไม่ถอดรหัส)', () => {
  test('GET /persons/{id}/pid: ทั้งแบบติดกันและแบบมีขีด/ช่องว่างคั่น', async () => {
    const { personId } = await makePerson();
    const fake = makeFakePid();
    const dashed = `${fake.slice(0, 1)}-${fake.slice(1, 5)}-${fake.slice(5, 10)}-${fake.slice(10, 12)}-${fake.slice(12)}`;
    const sub = uniqueSub('revealer');

    for (const justification of [`ขอตรวจเลข ${fake} ของพนักงาน`, `ขอตรวจเลข ${dashed} ของพนักงาน`]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await (await api('get', `/persons/${personId}/pid`, { scope: 'personnel:read:pid', sub, azp: 'hr-console' })).query({
        justification,
      });
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(/justification-contains-pid/);
      expect(JSON.stringify(res.body)).not.toContain(fake);
      expect(JSON.stringify(res.body)).not.toContain(dashed);
    }
    const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM audit.access_log WHERE actor_sub = $1`, [sub]);
    expect(rows[0].n).toBe(0);
  });

  test('POST /persons/lookup: justification มีเลข 13 หลัก -> 422 และไม่เขียน access_log', async () => {
    const { pid } = await makePerson();
    const sub = uniqueSub('looker');
    const res = await (await api('post', '/persons/lookup', { scope: 'personnel:lookup:pid', sub })).send({
      pid,
      justification: `ค้นหาจากเลข ${pid} ของผู้สมัคร`,
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain(pid);
    const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM audit.access_log WHERE actor_sub = $1`, [sub]);
    expect(rows[0].n).toBe(0);
  });
});

describe('GET /audit/access-logs: accessId, justification และสถานะรีวิว', () => {
  test('การเปิด pid แสดง accessId + justification + PENDING; รายการอื่นไม่มี reviewStatus และไม่ติดตัวกรอง', async () => {
    const { personId } = await makePerson();
    const sub = uniqueSub('revealer');
    const justification = 'ส่งข้อมูลให้กรมบัญชีกลางตามหนังสือที่ 123';
    const row = await reveal(personId, sub, justification);
    // รายการอื่นของคนเดียวกัน (อ่านข้อมูลทั่วไป) ต้องไม่ถูกนับเป็นการเปิด pid
    const other = await (await api('get', `/persons/${personId}`, { scope: 'personnel:read:basic', sub })).query({});
    expect(other.status).toBe(200);

    const all = await listLogs({ personId, limit: 100 });
    const revealEntry = all.body.data.find((e) => e.accessId === row.accessId);
    expect(revealEntry).toMatchObject({ justification, reviewStatus: 'PENDING', reviewedAt: null, reviewerSub: null, reviewNote: null });
    expect(revealEntry.endpoint).toBe(`/api/v1/persons/${personId}/pid`); // ไม่มี query string (#73)
    const otherEntry = all.body.data.find((e) => e.accessId !== row.accessId);
    expect(otherEntry.reviewStatus).toBeNull();

    const pending = await listLogs({ personId, reviewStatus: 'PENDING', limit: 100 });
    expect(pending.body.data.map((e) => e.accessId)).toEqual([row.accessId]);
    expect((await listLogs({ personId, reviewStatus: 'REVIEWED' })).body.data).toEqual([]);
  });

  test('แถวเก่าที่ endpoint มี ?justification= ต่อท้ายยังนับเป็นการเปิด pid และ justification ที่มีเลข 13 หลักหลุดมาถูกปกปิด', async () => {
    const { personId } = await makePerson();
    const leaked = makeFakePid();
    await ctx.pool.query(
      `INSERT INTO audit.access_log (subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method, fields_returned, justification, request_id, response_status)
       VALUES ($1, 'SERVICE', 'legacy-revealer', 'hr-console', $2, 'GET', '["pid"]', $3, gen_random_uuid()::text, 200)`,
      [personId, `/api/v1/persons/${personId}/pid?justification=${encodeURIComponent('เหตุผลเก่า')}`, `เลข ${leaked} เก่า`]
    );
    const res = await listLogs({ personId, reviewStatus: 'PENDING' });
    expect(res.body.data).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(leaked);
    expect(res.body.data[0].justification).toContain('ปกปิดเลข 13 หลัก');
  });
});

describe('POST /audit/access-logs/{accessId}/review', () => {
  test('dpo รีวิว -> 201, สถานะเปลี่ยนตาม; รีวิวซ้ำได้และแถวล่าสุดชนะ; เก็บทุกครั้งแบบ append-only', async () => {
    const { personId } = await makePerson();
    const revealer = uniqueSub('revealer');
    const reviewer = uniqueSub('dpo');
    const row = await reveal(personId, revealer);

    const first = await review(row.accessId, { accessedAt: row.accessedAt, status: 'NEEDS_EXPLANATION', note: 'โปรดชี้แจงเหตุผลที่ต้องใช้เลขเต็ม' }, dpo(reviewer));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ accessId: row.accessId, status: 'NEEDS_EXPLANATION', reviewerSub: reviewer });

    let entry = (await listLogs({ personId, reviewStatus: 'NEEDS_EXPLANATION' })).body.data[0];
    expect(entry).toMatchObject({ accessId: row.accessId, reviewStatus: 'NEEDS_EXPLANATION', reviewerSub: reviewer, reviewNote: 'โปรดชี้แจงเหตุผลที่ต้องใช้เลขเต็ม' });
    expect((await listLogs({ personId, reviewStatus: 'PENDING' })).body.data).toEqual([]);

    const second = await review(row.accessId, { accessedAt: row.accessedAt, status: 'REVIEWED', note: 'ชี้แจงแล้ว ยอมรับ' }, dpo(reviewer));
    expect(second.status).toBe(201);
    entry = (await listLogs({ personId, reviewStatus: 'REVIEWED' })).body.data[0];
    expect(entry.reviewNote).toBe('ชี้แจงแล้ว ยอมรับ');
    expect((await listLogs({ personId, reviewStatus: 'NEEDS_EXPLANATION' })).body.data).toEqual([]);

    const rows = await reviewRows(row.accessId);
    expect(rows.map((r) => r.status)).toEqual(['NEEDS_EXPLANATION', 'REVIEWED']);
    expect(rows.every((r) => r.reviewer_sub === reviewer && r.reviewer_client === 'dpo-console')).toBe(true);
  });

  test('ห้ามรีวิวรายการของตัวเอง -> 403 self-review-forbidden และไม่เขียนแถว', async () => {
    const { personId } = await makePerson();
    const same = uniqueSub('dpo-and-revealer');
    const row = await reveal(personId, same);
    const res = await review(row.accessId, { accessedAt: row.accessedAt, status: 'REVIEWED' }, dpo(same));
    expect(res.status).toBe(403);
    expect(res.body.type).toMatch(/self-review-forbidden/);
    expect(await reviewRows(row.accessId)).toEqual([]);
  });

  test('สิทธิ์: ต้องมี scope audit:review และ role dpo (auditor / audit:read อย่างเดียว -> 403) ไม่เขียนแถว', async () => {
    const { personId } = await makePerson();
    const row = await reveal(personId, uniqueSub('revealer'));
    const body = { accessedAt: row.accessedAt, status: 'REVIEWED' };

    const auditor = await review(row.accessId, body, { scope: 'audit:read audit:review', sub: uniqueSub('aud'), roles: ['auditor'] });
    expect(auditor.status).toBe(403);
    expect(auditor.body.type).toMatch(/insufficient-role/);

    const noScope = await review(row.accessId, body, { scope: 'audit:read', sub: uniqueSub('dpo'), roles: ['dpo'] });
    expect(noScope.status).toBe(403);
    expect(noScope.body.type).toMatch(/insufficient-scope/);

    const noRole = await review(row.accessId, body, { scope: 'audit:review', sub: uniqueSub('x') });
    expect(noRole.status).toBe(403);

    expect(await reviewRows(row.accessId)).toEqual([]);

    // role มาทาง realm_access.roles (Keycloak client scope "roles") ก็ใช้ได้เหมือนกัน
    const viaRealm = await review(row.accessId, body, { scope: 'audit:review', sub: uniqueSub('dpo'), realmRoles: ['dpo'] });
    expect(viaRealm.status).toBe(201);
  });

  test('NEEDS_EXPLANATION ต้องมี note; note ที่มีเลข 13 หลัก -> 422; status ผิด -> 400', async () => {
    const { personId } = await makePerson();
    const row = await reveal(personId, uniqueSub('revealer'));
    const auth = dpo(uniqueSub('dpo'));

    const noNote = await review(row.accessId, { accessedAt: row.accessedAt, status: 'NEEDS_EXPLANATION', note: '   ' }, auth);
    expect(noNote.status).toBe(422);
    expect(noNote.body.type).toMatch(/note-required/);

    const pid = makeFakePid();
    const withPid = await review(row.accessId, { accessedAt: row.accessedAt, status: 'REVIEWED', note: `เลข ${pid}` }, auth);
    expect(withPid.status).toBe(422);
    expect(JSON.stringify(withPid.body)).not.toContain(pid);

    expect((await review(row.accessId, { accessedAt: row.accessedAt, status: 'PENDING' }, auth)).status).toBe(400);
    expect((await review(row.accessId, { status: 'REVIEWED' }, auth)).status).toBe(400);
    expect(await reviewRows(row.accessId)).toEqual([]);
  });

  test('404: accessId ไม่มี / รายการที่ไม่ใช่การเปิด pid / accessedAt ไม่ตรง', async () => {
    const { personId } = await makePerson();
    const sub = uniqueSub('revealer');
    const row = await reveal(personId, sub);
    await (await api('get', `/persons/${personId}`, { scope: 'personnel:read:basic', sub })).query({});
    const { rows: nonReveal } = await ctx.pool.query(
      `SELECT access_id, accessed_at FROM audit.access_log WHERE subject_person_id = $1 AND endpoint NOT LIKE '%/pid' ORDER BY access_id DESC LIMIT 1`,
      [personId]
    );
    const auth = dpo(uniqueSub('dpo'));

    expect((await review(row.accessId + 100000000, { accessedAt: row.accessedAt, status: 'REVIEWED' }, auth)).status).toBe(404);
    expect(
      (await review(Number(nonReveal[0].access_id), { accessedAt: nonReveal[0].accessed_at.toISOString(), status: 'REVIEWED' }, auth)).status
    ).toBe(404);
    expect(
      (await review(row.accessId, { accessedAt: new Date(Date.parse(row.accessedAt) + 1000).toISOString(), status: 'REVIEWED' }, auth)).status
    ).toBe(404);
    expect(await reviewRows(row.accessId)).toEqual([]);
    expect(await reviewRows(Number(nonReveal[0].access_id))).toEqual([]);
  });

  test('accessed_at ระดับ µs: ส่ง ms ที่ตัดทอนมาก็จับคู่ได้ และเก็บค่า µs จริงของแถว access_log', async () => {
    const { personId } = await makePerson();
    const { rows } = await ctx.pool.query(
      `INSERT INTO audit.access_log (accessed_at, subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method, fields_returned, request_id, response_status)
       VALUES (date_trunc('second', now()) - interval '2 hours' + interval '123456 microseconds', $1, 'SERVICE', 'micro-revealer', 'hr-console', $2, 'GET', '["pid"]', gen_random_uuid()::text, 200)
       RETURNING access_id, accessed_at, to_char(accessed_at AT TIME ZONE 'UTC', 'US') AS micros`,
      [personId, `/api/v1/persons/${personId}/pid`]
    );
    expect(rows[0].micros).toBe('123456');
    const accessId = Number(rows[0].access_id);

    const listed = (await listLogs({ personId, reviewStatus: 'PENDING' })).body.data.find((e) => e.accessId === accessId);
    expect(listed.accessedAt).toMatch(/\.123Z$/); // API ส่งความละเอียด ms

    const res = await review(accessId, { accessedAt: listed.accessedAt, status: 'REVIEWED' }, dpo(uniqueSub('dpo')));
    expect(res.status).toBe(201);
    const stored = await ctx.pool.query(
      `SELECT to_char(accessed_at AT TIME ZONE 'UTC', 'US') AS micros FROM audit.pid_access_review WHERE access_id = $1`,
      [accessId]
    );
    expect(stored.rows[0].micros).toBe('123456');
    // และการ join กลับมาที่รายการเดิมต้องเห็นสถานะ (ถ้าเก็บค่าที่ตัดเป็น ms การ join จะไม่เจอ)
    expect((await listLogs({ personId, reviewStatus: 'REVIEWED' })).body.data.map((e) => e.accessId)).toContain(accessId);
  });
});

describe('audit.pid_access_review: append-only, ไม่มี FK, สิทธิ์ DB', () => {
  test('mdm_app UPDATE/DELETE ไม่ได้ และไม่มี foreign key ไป audit.access_log', async () => {
    const { personId } = await makePerson();
    const row = await reveal(personId, uniqueSub('revealer'));
    await review(row.accessId, { accessedAt: row.accessedAt, status: 'REVIEWED' }, dpo(uniqueSub('dpo')));

    await expect(ctx.pool.query(`UPDATE audit.pid_access_review SET note = 'x' WHERE access_id = $1`, [row.accessId])).rejects.toThrow();
    await expect(ctx.pool.query(`DELETE FROM audit.pid_access_review WHERE access_id = $1`, [row.accessId])).rejects.toThrow();
    expect(await reviewRows(row.accessId)).toHaveLength(1);

    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'audit.pid_access_review'::regclass AND contype = 'f'`
    );
    expect(rows[0].n).toBe(0);
  });
});
