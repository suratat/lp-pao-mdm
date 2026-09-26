const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const request = require('supertest');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { loadSpec } = require('../src/openapiSpec');

// T10: POST/PUT /org-units, /positions - scope+role, soft-delete, กฎ deactivate, race ของ position_no, reference_change_log
const SCOPE = 'personnel:manage:reference';
const ROLE = 'hr_master_data_admin';

let ctx;
let adminPool;
let adminToken;

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  adminToken = await ctx.auth.signToken({ scope: SCOPE, roles: [ROLE], sub: 'kc-user-master-data' });
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

const api = (method, url, token = adminToken) => {
  const req = request(ctx.app)[method](`/api/v1${url}`);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

const uniqueCode = () => `T10-${crypto.randomUUID().slice(0, 12)}`;
// position_no รูปแบบ NN-N-NN-NNNN-NNN ที่สุ่มจน (ทดสอบ) ไม่ซ้ำกับ seed จริง (ขึ้นต้นด้วย 9x ที่ seed ไม่มี)
const uniquePositionNo = () => {
  const n = (digits) => String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
  return `9${n(1)}-${n(1)}-${n(2)}-${n(4)}-${n(3)}`;
};

async function makeOrgUnit(fields = {}) {
  const res = await api('post', '/org-units').send({ code: uniqueCode(), nameTh: 'หน่วยงานทดสอบ T10', unitLevel: 'DIVISION', ...fields });
  expect(res.status).toBe(201);
  return res.body;
}

async function makePosition(orgUnitId, fields = {}) {
  const res = await api('post', '/positions').send({
    positionNo: uniquePositionNo(),
    titleTh: 'ตำแหน่งทดสอบ T10',
    positionType: 'GENERAL',
    orgUnitId,
    ...fields,
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function occupy(positionId, orgUnitId) {
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version)
     VALUES ($1, $2, 'ACTIVE', 'VERIFIED', 1)`,
    [personId, crypto.randomBytes(32).toString('hex')]
  );
  await adminPool.query(
    `INSERT INTO mdm.employment
       (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
     VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, CURRENT_DATE, true, 'ACTIVE', 'test')`,
    [personId, `EMP-T10-${crypto.randomUUID()}`, positionId, orgUnitId]
  );
  return personId;
}

async function changeLog(tableName, recordId) {
  const { rows } = await adminPool.query(
    `SELECT action, field_name, old_value, new_value, actor_sub, actor_client
     FROM audit.reference_change_log WHERE table_name = $1 AND record_id = $2 ORDER BY log_id`,
    [tableName, recordId]
  );
  return rows;
}

describe('สิทธิ์: ต้องมีทั้ง scope personnel:manage:reference และ role hr_master_data_admin', () => {
  const orgBody = () => ({ code: uniqueCode(), nameTh: 'x', unitLevel: 'DIVISION' });

  test('scope ครบแต่ไม่มี role (เช่น hr_officer ทั่วไปที่ hr-console ผูก scope ให้) -> 403 insufficient-role', async () => {
    const token = await ctx.auth.signToken({ scope: SCOPE, roles: ['hr_officer'] });
    const res = await api('post', '/org-units', token).send(orgBody());
    expect(res.status).toBe(403);
    expect(res.body.type).toMatch(/insufficient-role$/);
  });

  test('มี role แต่ไม่มี scope -> 403 insufficient-scope', async () => {
    const token = await ctx.auth.signToken({ scope: 'personnel:provision', roles: [ROLE] });
    const res = await api('post', '/org-units', token).send(orgBody());
    expect(res.status).toBe(403);
    expect(res.body.type).toMatch(/insufficient-scope$/);
  });

  test('ไม่มีทั้งสองอย่าง / ไม่มี token', async () => {
    const token = await ctx.auth.signToken({ scope: 'personnel:read:basic' });
    expect((await api('post', '/org-units', token).send(orgBody())).status).toBe(403);
    expect((await api('post', '/org-units', null).send(orgBody())).status).toBe(401);
  });

  test('ทุกเส้นทางเขียนใช้กฎเดียวกัน (POST/PUT ทั้ง org-units และ positions)', async () => {
    const token = await ctx.auth.signToken({ scope: SCOPE, roles: ['hr_officer'] });
    const org = await makeOrgUnit();
    const pos = await makePosition(org.orgUnitId);
    const id = crypto.randomUUID();
    const calls = [
      api('post', '/positions', token).send({ positionNo: uniquePositionNo(), titleTh: 'x', positionType: 'GENERAL', orgUnitId: org.orgUnitId }),
      api('put', `/org-units/${org.orgUnitId}`, token).send({ nameTh: 'x', unitLevel: 'DIVISION', isActive: true }),
      api('put', `/positions/${pos.positionId}`, token).send({ positionNo: pos.positionNo, titleTh: 'x', positionType: 'GENERAL', orgUnitId: org.orgUnitId, isActive: true }),
      api('put', `/org-units/${id}`, token).send({ nameTh: 'x', unitLevel: 'DIVISION', isActive: true }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(403);
      expect(res.body.type).toMatch(/insufficient-role$/);
    }
  });

  test('role มาจาก realm_access.roles (รูปแบบที่ Keycloak client scope "roles" ใส่ใน access token ของ hr-console) ได้เช่นกัน', async () => {
    const token = await ctx.auth.signToken({ scope: SCOPE, realmRoles: ['hr_officer', ROLE, 'offline_access'] });
    const res = await api('post', '/org-units', token).send(orgBody());
    expect(res.status).toBe(201);
  });

  test('ไม่มี DELETE endpoint (ห้ามลบจริง)', async () => {
    const org = await makeOrgUnit();
    const pos = await makePosition(org.orgUnitId);
    expect((await api('delete', `/org-units/${org.orgUnitId}`)).status).toBeGreaterThanOrEqual(404);
    expect((await api('delete', `/positions/${pos.positionId}`)).status).toBeGreaterThanOrEqual(404);
    const { rows } = await adminPool.query(`SELECT 1 FROM mdm.position WHERE position_id = $1`, [pos.positionId]);
    expect(rows).toHaveLength(1);
  });
});

describe('POST/PUT /org-units', () => {
  test('สร้างได้ 201, isActive=true, และเขียน reference_change_log ต่อฟิลด์พร้อม actor', async () => {
    const parent = await makeOrgUnit();
    const code = uniqueCode();
    const res = await api('post', '/org-units').send({ code, parentId: parent.orgUnitId, nameTh: 'ฝ่ายทดสอบ', nameEn: 'Test Section', unitLevel: 'SECTION' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code, parentId: parent.orgUnitId, nameTh: 'ฝ่ายทดสอบ', nameEn: 'Test Section', unitLevel: 'SECTION', isActive: true });

    const log = await changeLog('org_unit', res.body.orgUnitId);
    expect(log.every((r) => r.action === 'CREATE' && r.actor_sub === 'kc-user-master-data' && r.actor_client === 'test-client')).toBe(true);
    expect(Object.fromEntries(log.map((r) => [r.field_name, r.new_value]))).toMatchObject({
      code, parent_id: parent.orgUnitId, name_th: 'ฝ่ายทดสอบ', unit_level: 'SECTION', is_active: true,
    });
  });

  test('code ซ้ำ -> 409 org-unit-code-conflict (ไม่ใช่ 500) และไม่เขียน log ของแถวที่ล้มเหลว', async () => {
    const org = await makeOrgUnit();
    const res = await api('post', '/org-units').send({ code: org.code, nameTh: 'ซ้ำ', unitLevel: 'DIVISION' });
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/org-unit-code-conflict$/);
  });

  test('สร้างพร้อมกัน code เดียวกัน -> 201 หนึ่งตัว 409 ที่เหลือ ไม่มี 500', async () => {
    const code = uniqueCode();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => api('post', '/org-units').send({ code, nameTh: 'race', unitLevel: 'DIVISION' }))
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
  });

  test('parent ไม่มีอยู่ / inactive -> 422 org-unit-parent-invalid', async () => {
    const missing = await api('post', '/org-units').send({ code: uniqueCode(), parentId: crypto.randomUUID(), nameTh: 'x', unitLevel: 'SECTION' });
    expect(missing.status).toBe(422);
    expect(missing.body.type).toMatch(/org-unit-parent-invalid$/);

    const parent = await makeOrgUnit();
    expect((await api('put', `/org-units/${parent.orgUnitId}`).send({ nameTh: parent.nameTh, unitLevel: 'DIVISION', isActive: false })).status).toBe(200);
    const inactive = await api('post', '/org-units').send({ code: uniqueCode(), parentId: parent.orgUnitId, nameTh: 'x', unitLevel: 'SECTION' });
    expect(inactive.status).toBe(422);
  });

  test('ตรวจรูปแบบ request: unitLevel ผิด, code มีช่องว่าง, nameTh ว่าง/ช่องว่างล้วน -> 400', async () => {
    const base = { code: uniqueCode(), nameTh: 'x', unitLevel: 'DIVISION' };
    for (const bad of [{ unitLevel: 'สำนัก/กอง' }, { code: 'has space' }, { nameTh: '' }, { nameTh: '   ' }, { extra: 1 }]) {
      const res = await api('post', '/org-units').send({ ...base, ...bad });
      expect(res.status).toBe(400);
    }
  });

  test('PUT: แก้ชื่อ/level/parent ได้, เขียน log เฉพาะฟิลด์ที่เปลี่ยน, PUT ซ้ำที่ไม่เปลี่ยนไม่เขียน log', async () => {
    const parent = await makeOrgUnit();
    const org = await makeOrgUnit();
    const body = { parentId: parent.orgUnitId, nameTh: 'ชื่อใหม่', unitLevel: 'SECTION', isActive: true };
    const res = await api('put', `/org-units/${org.orgUnitId}`).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ parentId: parent.orgUnitId, nameTh: 'ชื่อใหม่', unitLevel: 'SECTION', code: org.code });

    const log = await changeLog('org_unit', org.orgUnitId);
    const updates = log.filter((r) => r.action === 'UPDATE');
    expect(updates.map((r) => r.field_name).sort()).toEqual(['name_th', 'parent_id', 'unit_level']);
    expect(updates.find((r) => r.field_name === 'name_th')).toMatchObject({ old_value: 'หน่วยงานทดสอบ T10', new_value: 'ชื่อใหม่' });

    const before = (await changeLog('org_unit', org.orgUnitId)).length;
    expect((await api('put', `/org-units/${org.orgUnitId}`).send(body)).status).toBe(200);
    expect((await changeLog('org_unit', org.orgUnitId)).length).toBe(before);
  });

  test('PUT: ส่ง code มา -> 400 (code แก้ไม่ได้), ไม่พบ -> 404', async () => {
    const org = await makeOrgUnit();
    const withCode = await api('put', `/org-units/${org.orgUnitId}`).send({ code: 'NEW', nameTh: 'x', unitLevel: 'DIVISION', isActive: true });
    expect(withCode.status).toBe(400);
    const missing = await api('put', `/org-units/${crypto.randomUUID()}`).send({ nameTh: 'x', unitLevel: 'DIVISION', isActive: true });
    expect(missing.status).toBe(404);
  });

  test('PUT: ตั้ง parent เป็นตัวเอง/ลูกหลานตัวเอง -> 422 org-unit-parent-cycle', async () => {
    const a = await makeOrgUnit();
    const b = await makeOrgUnit({ parentId: a.orgUnitId, unitLevel: 'SECTION' });
    const c = await makeOrgUnit({ parentId: b.orgUnitId, unitLevel: 'UNIT' });
    for (const parentId of [a.orgUnitId, c.orgUnitId]) {
      const res = await api('put', `/org-units/${a.orgUnitId}`).send({ parentId, nameTh: a.nameTh, unitLevel: 'DIVISION', isActive: true });
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(/org-unit-parent-cycle$/);
    }
  });

  test('PUT พร้อมกันสองตัวที่ถ้าสำเร็จทั้งคู่จะเกิด cycle -> สำเร็จได้ไม่เกินหนึ่งตัว และไม่มี 500/deadlock', async () => {
    const a = await makeOrgUnit();
    const b = await makeOrgUnit();
    const results = await Promise.all([
      api('put', `/org-units/${a.orgUnitId}`).send({ parentId: b.orgUnitId, nameTh: a.nameTh, unitLevel: 'DIVISION', isActive: true }),
      api('put', `/org-units/${b.orgUnitId}`).send({ parentId: a.orgUnitId, nameTh: b.nameTh, unitLevel: 'DIVISION', isActive: true }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
  });

  describe('deactivate (soft-delete)', () => {
    test('ยังมีหน่วยงานลูกที่ active -> 409 org-unit-in-use; ปิดลูกแล้วปิดแม่ได้', async () => {
      const parent = await makeOrgUnit();
      const child = await makeOrgUnit({ parentId: parent.orgUnitId, unitLevel: 'SECTION' });
      const off = (o) => api('put', `/org-units/${o.orgUnitId}`).send({ parentId: o.parentId ?? undefined, nameTh: o.nameTh, unitLevel: o.unitLevel, isActive: false });

      const blocked = await off(parent);
      expect(blocked.status).toBe(409);
      expect(blocked.body.type).toMatch(/org-unit-in-use$/);

      expect((await off(child)).status).toBe(200);
      const res = await off(parent);
      expect(res.status).toBe(200);
      expect(res.body.isActive).toBe(false);

      const { rows } = await adminPool.query(`SELECT is_active FROM mdm.org_unit WHERE org_unit_id = $1`, [parent.orgUnitId]);
      expect(rows[0].is_active).toBe(false); // แถวยังอยู่ (soft-delete)
      const log = await changeLog('org_unit', parent.orgUnitId);
      expect(log.find((r) => r.action === 'UPDATE' && r.field_name === 'is_active')).toMatchObject({ old_value: true, new_value: false });
    });

    test('ยังมีตำแหน่งที่ active -> 409; ปิดตำแหน่งแล้วปิดได้', async () => {
      const org = await makeOrgUnit();
      const pos = await makePosition(org.orgUnitId);
      const offOrg = () => api('put', `/org-units/${org.orgUnitId}`).send({ nameTh: org.nameTh, unitLevel: org.unitLevel, isActive: false });
      expect((await offOrg()).status).toBe(409);
      expect(
        (await api('put', `/positions/${pos.positionId}`).send({ positionNo: pos.positionNo, titleTh: pos.titleTh, positionType: pos.positionType, orgUnitId: org.orgUnitId, isActive: false })).status
      ).toBe(200);
      expect((await offOrg()).status).toBe(200);
    });

    test('ยังมีผู้ปฏิบัติงานปัจจุบัน (employment.is_current) -> 409 แม้ตำแหน่งจะ inactive แล้ว', async () => {
      const org = await makeOrgUnit();
      const pos = await makePosition(org.orgUnitId);
      await occupy(pos.positionId, org.orgUnitId);
      // ปิดตำแหน่งตรงๆ ใน DB (ข้ามกฎ API) เพื่อแยกทดสอบเงื่อนไข employment ของ org_unit
      await adminPool.query(`UPDATE mdm.position SET is_active = false WHERE position_id = $1`, [pos.positionId]);
      const res = await api('put', `/org-units/${org.orgUnitId}`).send({ nameTh: org.nameTh, unitLevel: org.unitLevel, isActive: false });
      expect(res.status).toBe(409);
      expect(res.body.type).toMatch(/org-unit-in-use$/);
    });

    test('เปิดใช้งานกลับ: parent ต้อง active (422), เมื่อ parent active แล้วเปิดได้', async () => {
      const parent = await makeOrgUnit();
      const child = await makeOrgUnit({ parentId: parent.orgUnitId, unitLevel: 'SECTION' });
      const put = (o, isActive) => api('put', `/org-units/${o.orgUnitId}`).send({ parentId: o.parentId ?? undefined, nameTh: o.nameTh, unitLevel: o.unitLevel, isActive });
      await put(child, false);
      await put(parent, false);

      const blocked = await put(child, true);
      expect(blocked.status).toBe(422);
      expect(blocked.body.type).toMatch(/org-unit-parent-invalid$/);

      await put(parent, true);
      expect((await put(child, true)).status).toBe(200);
    });
  });
});

describe('POST/PUT /positions', () => {
  test('สร้างได้ 201 (lineOfWork ไม่ส่ง = ไม่มีฟิลด์ใน response) และเขียน reference_change_log', async () => {
    const org = await makeOrgUnit();
    const positionNo = uniquePositionNo();
    const res = await api('post', '/positions').send({ positionNo, titleTh: 'นักวิชาการทดสอบ', positionType: 'ACADEMIC', orgUnitId: org.orgUnitId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ positionNo, titleTh: 'นักวิชาการทดสอบ', positionType: 'ACADEMIC', orgUnitId: org.orgUnitId, isActive: true });
    expect(res.body).not.toHaveProperty('lineOfWork');

    const log = await changeLog('position', res.body.positionId);
    expect(log.map((r) => r.field_name).sort()).toEqual(['is_active', 'line_of_work', 'org_unit_id', 'position_no', 'position_type', 'title_th']);
    expect(log.every((r) => r.action === 'CREATE' && r.actor_sub === 'kc-user-master-data')).toBe(true);
  });

  test('position_no ซ้ำ -> 409 position-no-conflict พร้อมข้อความชัดเจน (ไม่ใช่ 500)', async () => {
    const org = await makeOrgUnit();
    const pos = await makePosition(org.orgUnitId);
    const res = await api('post', '/positions').send({ positionNo: pos.positionNo, titleTh: 'ซ้ำ', positionType: 'GENERAL', orgUnitId: org.orgUnitId });
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/position-no-conflict$/);
    expect(res.body.detail).toContain(pos.positionNo);
  });

  test('race: สร้าง position_no เดียวกันพร้อมกัน 10 request -> 201 หนึ่งตัว 409 เก้าตัว ไม่มี 500 และมีแถวเดียวใน DB', async () => {
    const org = await makeOrgUnit();
    const positionNo = uniquePositionNo();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api('post', '/positions').send({ positionNo, titleTh: 'race', positionType: 'GENERAL', orgUnitId: org.orgUnitId })
      )
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(statuses.some((s) => s >= 500)).toBe(false);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.type).toMatch(/position-no-conflict$/);

    const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM mdm.position WHERE position_no = $1`, [positionNo]);
    expect(rows[0].n).toBe(1);
    // log ของ request ที่ล้มเหลวต้อง rollback ไปด้วย: มีชุด CREATE เดียว (6 ฟิลด์)
    const created = results.find((r) => r.status === 201).body;
    expect(await changeLog('position', created.positionId)).toHaveLength(6);
  });

  test('org_unit ไม่มีอยู่ / inactive -> 422 org-unit-invalid; position_type ไม่มี/inactive -> 422 position-type-invalid', async () => {
    const missing = await api('post', '/positions').send({ positionNo: uniquePositionNo(), titleTh: 'x', positionType: 'GENERAL', orgUnitId: crypto.randomUUID() });
    expect(missing.status).toBe(422);
    expect(missing.body.type).toMatch(/org-unit-invalid$/);

    const org = await makeOrgUnit();
    await api('put', `/org-units/${org.orgUnitId}`).send({ nameTh: org.nameTh, unitLevel: org.unitLevel, isActive: false });
    const inactive = await api('post', '/positions').send({ positionNo: uniquePositionNo(), titleTh: 'x', positionType: 'GENERAL', orgUnitId: org.orgUnitId });
    expect(inactive.status).toBe(422);

    const org2 = await makeOrgUnit();
    const badType = await api('post', '/positions').send({ positionNo: uniquePositionNo(), titleTh: 'x', positionType: 'NOPE', orgUnitId: org2.orgUnitId });
    expect(badType.status).toBe(422);
    expect(badType.body.type).toMatch(/position-type-invalid$/);

    await adminPool.query(`INSERT INTO mdm.position_type (code, name_th, is_active) VALUES ('T10_OFF', 'ปิดใช้งาน', false) ON CONFLICT DO NOTHING`);
    const offType = await api('post', '/positions').send({ positionNo: uniquePositionNo(), titleTh: 'x', positionType: 'T10_OFF', orgUnitId: org2.orgUnitId });
    expect(offType.status).toBe(422);
  });

  test('org_unit ถูกปิดใช้งานพร้อมกับการสร้างตำแหน่ง -> ห้ามจบด้วยตำแหน่ง active ใต้หน่วยงาน inactive', async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const org = await makeOrgUnit();
      // eslint-disable-next-line no-await-in-loop
      const [create, deactivate] = await Promise.all([
        api('post', '/positions').send({ positionNo: uniquePositionNo(), titleTh: 'race', positionType: 'GENERAL', orgUnitId: org.orgUnitId }),
        api('put', `/org-units/${org.orgUnitId}`).send({ nameTh: org.nameTh, unitLevel: org.unitLevel, isActive: false }),
      ]);
      expect(create.status).not.toBe(500);
      expect(deactivate.status).not.toBe(500);
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await adminPool.query(
        `SELECT (SELECT is_active FROM mdm.org_unit WHERE org_unit_id = $1) AS org_active,
                (SELECT count(*)::int FROM mdm.position WHERE org_unit_id = $1 AND is_active) AS active_positions`,
        [org.orgUnitId]
      );
      expect(rows[0].org_active === false && rows[0].active_positions > 0).toBe(false);
    }
  });

  test('ตรวจรูปแบบ position_no ฝั่ง API: ยอมรับ 4 รูปแบบ, ปฏิเสธที่เหลือ (400)', async () => {
    const org = await makeOrgUnit();
    const suffix = () => String(crypto.randomInt(0, 1000)).padStart(3, '0');
    const good = [
      `9${crypto.randomInt(0, 10)}-1-07-${String(crypto.randomInt(0, 10000)).padStart(4, '0')}-${suffix()}`,
      `9${crypto.randomInt(0, 10)}-2-08-${String(crypto.randomInt(0, 10000)).padStart(4, '0')}-${suffix()} (ถ)`,
      `EX-${String(crypto.randomInt(900, 1000))}`,
      String(crypto.randomInt(100, 10000)), // เลขลำดับล้วน 3-4 หลัก (ลูกจ้างประจำ) - เดิมรับแค่ 1-2 หลัก
    ];
    for (const positionNo of good) {
      // eslint-disable-next-line no-await-in-loop
      const res = await api('post', '/positions').send({ positionNo, titleTh: 'x', positionType: 'GENERAL', orgUnitId: org.orgUnitId });
      expect([201, 409]).toContain(res.status); // 409 = สุ่มชนของที่มีอยู่ ยังถือว่ารูปแบบผ่าน
    }
    for (const positionNo of ['', ' 52-1-07-3106-003', '52-1-07-3106-003 ', '52-1-07-3106', 'ex-001', 'EX-1', '12345', '12a', 'ABC', '52-1-07-3106-003 (ก)']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await api('post', '/positions').send({ positionNo, titleTh: 'x', positionType: 'GENERAL', orgUnitId: org.orgUnitId });
      expect([positionNo, res.status]).toEqual([positionNo, 400]);
    }
  });

  test('PositionNo pattern ใน OpenAPI ยอมรับ position_no จริงทั้ง 1,025 แถวใน position-seed-data.csv', () => {
    const re = new RegExp(loadSpec().components.schemas.PositionNo.pattern);
    const csv = path.join(__dirname, '..', '..', 'migrate', 'data', 'position-seed-data.csv');
    const rows = fs.readFileSync(csv, 'utf8').split(/\r?\n/).filter(Boolean).slice(1);
    expect(rows.length).toBeGreaterThan(1000);
    const bad = rows.map((r) => r.split(',')[1]).filter((p) => !re.test(p));
    expect(bad).toEqual([]);
  });

  test('PUT: แก้ชื่อ/สายงาน/หมวด/position_no ได้ พร้อม log; lineOfWork ที่ไม่ส่งมา = ล้างเป็น null', async () => {
    const org = await makeOrgUnit();
    const pos = await makePosition(org.orgUnitId, { lineOfWork: 'สายงานเดิม' });
    const newNo = uniquePositionNo();
    const res = await api('put', `/positions/${pos.positionId}`).send({
      positionNo: newNo, titleTh: 'ชื่อใหม่', positionType: 'ACADEMIC', orgUnitId: org.orgUnitId, isActive: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ positionNo: newNo, titleTh: 'ชื่อใหม่', positionType: 'ACADEMIC' });
    expect(res.body).not.toHaveProperty('lineOfWork');

    const updates = (await changeLog('position', pos.positionId)).filter((r) => r.action === 'UPDATE');
    expect(updates.map((r) => r.field_name).sort()).toEqual(['line_of_work', 'position_no', 'position_type', 'title_th']);
    expect(updates.find((r) => r.field_name === 'position_no')).toMatchObject({ old_value: pos.positionNo, new_value: newNo });
    expect(updates.find((r) => r.field_name === 'line_of_work')).toMatchObject({ old_value: 'สายงานเดิม', new_value: null });
  });

  test('PUT: เปลี่ยน position_no ไปซ้ำกับของอื่น -> 409 position-no-conflict; ไม่พบ -> 404', async () => {
    const org = await makeOrgUnit();
    const a = await makePosition(org.orgUnitId);
    const b = await makePosition(org.orgUnitId);
    const res = await api('put', `/positions/${b.positionId}`).send({ positionNo: a.positionNo, titleTh: b.titleTh, positionType: b.positionType, orgUnitId: org.orgUnitId, isActive: true });
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/position-no-conflict$/);

    const missing = await api('put', `/positions/${crypto.randomUUID()}`).send({ positionNo: uniquePositionNo(), titleTh: 'x', positionType: 'GENERAL', orgUnitId: org.orgUnitId, isActive: true });
    expect(missing.status).toBe(404);
  });

  test('PUT ของสองตำแหน่งพร้อมกันที่ตั้ง position_no เดียวกัน -> สำเร็จหนึ่ง 409 หนึ่ง', async () => {
    const org = await makeOrgUnit();
    const a = await makePosition(org.orgUnitId);
    const b = await makePosition(org.orgUnitId);
    const target = uniquePositionNo();
    const put = (p) => api('put', `/positions/${p.positionId}`).send({ positionNo: target, titleTh: p.titleTh, positionType: p.positionType, orgUnitId: org.orgUnitId, isActive: true });
    const results = await Promise.all([put(a), put(b)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  test('มีผู้ดำรงตำแหน่งปัจจุบัน: ปิดใช้งาน/ย้ายสังกัดไม่ได้ (409 position-occupied) แต่แก้ชื่อได้', async () => {
    const org = await makeOrgUnit();
    const other = await makeOrgUnit();
    const pos = await makePosition(org.orgUnitId);
    await occupy(pos.positionId, org.orgUnitId);
    const body = (o = {}) => ({ positionNo: pos.positionNo, titleTh: pos.titleTh, positionType: pos.positionType, orgUnitId: org.orgUnitId, isActive: true, ...o });

    for (const change of [{ isActive: false }, { orgUnitId: other.orgUnitId }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await api('put', `/positions/${pos.positionId}`).send(body(change));
      expect(res.status).toBe(409);
      expect(res.body.type).toMatch(/position-occupied$/);
    }
    expect((await api('put', `/positions/${pos.positionId}`).send(body({ titleTh: 'แก้ชื่อได้' }))).status).toBe(200);
  });

  test('แก้ชื่อตำแหน่ง (title_th) ของตำแหน่งที่มีคนครองอยู่ -> GET /persons/{id} และ GET /persons/{id}/employment ของคนนั้นเห็นชื่อใหม่ทันที (อ่านสด ไม่มี cache)', async () => {
    const org = await makeOrgUnit();
    const pos = await makePosition(org.orgUnitId, { titleTh: 'ชื่อตำแหน่งเดิม T10' });
    const personId = await occupy(pos.positionId, org.orgUnitId);
    const readToken = await ctx.auth.signToken({ scope: 'personnel:read:basic personnel:read:employment' });
    const readTitles = async () => {
      const person = await api('get', `/persons/${personId}`, readToken);
      const employment = await api('get', `/persons/${personId}/employment`, readToken);
      expect([person.status, employment.status]).toEqual([200, 200]);
      return { basic: person.body.basic?.positionTitle, current: employment.body.find((e) => e.position)?.position.titleTh };
    };

    expect(await readTitles()).toEqual({ basic: 'ชื่อตำแหน่งเดิม T10', current: 'ชื่อตำแหน่งเดิม T10' });

    const put = await api('put', `/positions/${pos.positionId}`).send({
      positionNo: pos.positionNo, titleTh: 'ชื่อตำแหน่งใหม่ T10', positionType: pos.positionType, orgUnitId: org.orgUnitId, isActive: true,
    });
    expect(put.status).toBe(200);

    expect(await readTitles()).toEqual({ basic: 'ชื่อตำแหน่งใหม่ T10', current: 'ชื่อตำแหน่งใหม่ T10' });
  });

  test('ปิดใช้งาน (soft-delete) ตำแหน่งว่างได้ แถวยังอยู่; เปิดกลับได้เมื่อสังกัด active, ไม่ได้ (422) เมื่อสังกัด inactive', async () => {
    const org = await makeOrgUnit();
    const pos = await makePosition(org.orgUnitId);
    const put = (isActive) => api('put', `/positions/${pos.positionId}`).send({ positionNo: pos.positionNo, titleTh: pos.titleTh, positionType: pos.positionType, orgUnitId: org.orgUnitId, isActive });

    const off = await put(false);
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    const { rows } = await adminPool.query(`SELECT is_active FROM mdm.position WHERE position_id = $1`, [pos.positionId]);
    expect(rows[0].is_active).toBe(false);

    await api('put', `/org-units/${org.orgUnitId}`).send({ nameTh: org.nameTh, unitLevel: org.unitLevel, isActive: false });
    const blocked = await put(true);
    expect(blocked.status).toBe(422);
    expect(blocked.body.type).toMatch(/org-unit-invalid$/);

    await api('put', `/org-units/${org.orgUnitId}`).send({ nameTh: org.nameTh, unitLevel: org.unitLevel, isActive: true });
    expect((await put(true)).status).toBe(200);
  });

  test('ย้ายตำแหน่งไป org_unit ที่ inactive/ไม่มี -> 422', async () => {
    const org = await makeOrgUnit();
    const off = await makeOrgUnit();
    await api('put', `/org-units/${off.orgUnitId}`).send({ nameTh: off.nameTh, unitLevel: off.unitLevel, isActive: false });
    const pos = await makePosition(org.orgUnitId);
    for (const orgUnitId of [off.orgUnitId, crypto.randomUUID()]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await api('put', `/positions/${pos.positionId}`).send({ positionNo: pos.positionNo, titleTh: pos.titleTh, positionType: pos.positionType, orgUnitId, isActive: true });
      expect(res.status).toBe(422);
    }
  });
});

describe('GET (อ่าน) ที่เกี่ยวข้อง', () => {
  test('GET /positions?activeOnly=true ตัดตำแหน่ง inactive; ค่าเริ่มต้นคืนทั้งหมด (พฤติกรรมเดิม)', async () => {
    const org = await makeOrgUnit();
    const on = await makePosition(org.orgUnitId);
    const off = await makePosition(org.orgUnitId);
    await api('put', `/positions/${off.positionId}`).send({ positionNo: off.positionNo, titleTh: off.titleTh, positionType: off.positionType, orgUnitId: org.orgUnitId, isActive: false });
    const readToken = await ctx.auth.signToken({ scope: 'personnel:read:basic' });

    const all = await api('get', `/positions?orgUnitId=${org.orgUnitId}`, readToken);
    expect(all.body.map((p) => p.positionId).sort()).toEqual([on.positionId, off.positionId].sort());
    const active = await api('get', `/positions?orgUnitId=${org.orgUnitId}&activeOnly=true`, readToken);
    expect(active.body.map((p) => p.positionId)).toEqual([on.positionId]);
  });

  test('GET /position-types คืนหมวดที่ active (มีทั้ง 7 หมวดที่ seed) และ activeOnly=false เห็นตัวที่ปิด', async () => {
    const readToken = await ctx.auth.signToken({ scope: 'personnel:read:basic' });
    const res = await api('get', '/position-types', readToken);
    expect(res.status).toBe(200);
    const codes = res.body.map((t) => t.code);
    expect(codes).toEqual(expect.arrayContaining(['EXECUTIVE', 'DIRECTOR', 'ACADEMIC', 'GENERAL', 'SCHOOL_DIRECTOR', 'SCHOOL_DEPUTY_DIRECTOR', 'POLITICAL']));
    expect(res.body.every((t) => t.isActive)).toBe(true);
  });
});

describe('audit: reference_change_log', () => {
  test('การเขียน master data ไม่แตะ audit.data_change_log และ integration.outbox_event (ไม่ใช่ข้อมูลบุคคล)', async () => {
    const count = async () => {
      const { rows } = await adminPool.query(
        `SELECT (SELECT count(*) FROM audit.data_change_log)::int AS dcl, (SELECT count(*) FROM integration.outbox_event)::int AS outbox`
      );
      return rows[0];
    };
    const before = await count();
    const org = await makeOrgUnit();
    await makePosition(org.orgUnitId);
    expect(await count()).toEqual(before);
  });

  test('role ของแอป (mdm_app) UPDATE/DELETE reference_change_log ไม่ได้', async () => {
    const org = await makeOrgUnit();
    await expect(ctx.pool.query(`UPDATE audit.reference_change_log SET actor_sub = 'x' WHERE record_id = $1`, [org.orgUnitId])).rejects.toThrow();
    await expect(ctx.pool.query(`DELETE FROM audit.reference_change_log WHERE record_id = $1`, [org.orgUnitId])).rejects.toThrow();
  });
});
