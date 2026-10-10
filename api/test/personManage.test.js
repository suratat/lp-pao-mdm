const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { makeFakePid } = require('../src/security/pid');
const { insertFixtureOrgUnit } = require('./fixtures');

// PR-D2: endpoint จัดการข้อมูลบุคคลโดย HR (manage-profile, expected-identity, contact, emergency-contacts, history) - ไม่ใช้ helper hrWrite.js
// ข้อมูลทั้งหมดสมมติ (pid จาก makeFakePid())

let ctx;
let adminPool;
let orgUnitId;

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  orgUnitId = await insertFixtureOrgUnit(ctx.pool);
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

const ROLE = 'hr_master_data_admin';
const SCOPE = 'personnel:manage:person';
const uniqueSub = (prefix) => `${prefix}-${crypto.randomUUID()}`;
// hr-console ถือ personnel:read:inactive เป็น default scope จึงใส่ให้ทุกเทสต์ (คน INACTIVE ต้องมี scope นี้ - ทดสอบตรงๆ ที่ personsHrView.test.js)
const mgr = (extra = {}) => ({ scope: `${SCOPE} personnel:read:inactive`, sub: uniqueSub('hr'), azp: 'hr-console', roles: [ROLE], ...extra });

async function call(method, urlPath, auth, body) {
  const token = await ctx.auth.signToken(auth);
  let req = request(ctx.app)[method](`/api/v1${urlPath}`).set('Authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body);
  return req;
}

async function makePosition() {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id) VALUES ($1, 'ตำแหน่งทดสอบ manage', 'GENERAL', $2) RETURNING position_id`,
    [`POS-D2-${crypto.randomUUID()}`, orgUnitId]
  );
  return rows[0].position_id;
}

// สร้างบุคคล PENDING_CLAIM ผ่าน POST /persons (ใช้ role + reason ตามสัญญา PR-D1)
async function provision(extra = {}) {
  const pid = makeFakePid();
  const res = await call('post', '/persons', { scope: 'personnel:provision personnel:read:basic', sub: uniqueSub('hr'), azp: 'hr-console', roles: [ROLE] }, {
    pid,
    expectedFirstNameTh: 'สมชาย',
    expectedLastNameTh: 'ทดสอบ',
    reason: 'เพิ่มบุคลากรใหม่ตามคำสั่งบรรจุ',
    employment: { employeeNo: pid, personnelType: 'CIVIL_SERVANT', positionId: await makePosition(), orgUnitId, effectiveFrom: '2024-01-01' },
    ...extra,
  });
  expect(res.status).toBe(201);
  return { personId: res.body.personId, pid, version: res.body.version };
}

const profile = async (personId, auth = mgr()) => (await call('get', `/persons/${personId}/manage-profile`, auth)).body;
const versionOf = async (personId) => (await adminPool.query(`SELECT version FROM mdm.person WHERE person_id = $1`, [personId])).rows[0].version;
const logsFor = async (personId) =>
  (await adminPool.query(`SELECT table_name, field_name, old_value, new_value, changed_by, actor_sub, actor_client, reason FROM audit.data_change_log WHERE person_id = $1 ORDER BY log_id`, [personId])).rows;
const outboxFor = async (personId) =>
  (await adminPool.query(`SELECT event_type, changed_fields, payload FROM integration.outbox_event WHERE person_id = $1 ORDER BY sequence`, [personId])).rows;
const setStatus = (personId, status) => adminPool.query(`UPDATE mdm.person SET status = $2 WHERE person_id = $1`, [personId, status]);
const expectedOf = async (personId) =>
  (await adminPool.query(`SELECT expected_first_name_th AS first, expected_last_name_th AS last, expected_birth_date::text AS birth FROM mdm.person WHERE person_id = $1`, [personId])).rows[0];
const dashed = (pid) => `${pid.slice(0, 1)}-${pid.slice(1, 5)}-${pid.slice(5, 10)}-${pid.slice(10, 12)}-${pid.slice(12)}`;

const ENDPOINTS = [
  ['GET manage-profile', 'get', (id) => `/persons/${id}/manage-profile`, () => undefined],
  ['PATCH expected-identity', 'patch', (id) => `/persons/${id}/expected-identity`, (v) => ({ expectedVersion: v, reason: 'ทดสอบสิทธิ์', firstNameTh: 'ใหม่' })],
  ['PATCH contact', 'patch', (id) => `/persons/${id}/contact`, (v) => ({ expectedVersion: v, reason: 'ทดสอบสิทธิ์', phoneAlt: '021234567' })],
  ['PUT emergency-contacts', 'put', (id) => `/persons/${id}/emergency-contacts`, (v) => ({ expectedVersion: v, reason: 'ทดสอบสิทธิ์', contacts: [] })],
  ['GET history', 'get', (id) => `/persons/${id}/history`, () => undefined],
];

describe.each(ENDPOINTS)('%s: สิทธิ์', (_name, method, pathOf, bodyOf) => {
  test('ไม่มี role hr_master_data_admin (ไม่มี role / hr_officer อย่างเดียว / dpo+auditor) -> 403 insufficient-role และไม่เขียนอะไร', async () => {
    const { personId, version } = await provision();
    const logsBefore = (await logsFor(personId)).length;
    for (const roles of [undefined, ['hr_officer'], ['dpo', 'auditor']]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(method, pathOf(personId), mgr({ roles }), bodyOf(version));
      expect(res.status).toBe(403);
      expect(res.body.type).toMatch(/insufficient-role/);
    }
    expect(await versionOf(personId)).toBe(version);
    expect((await logsFor(personId)).length).toBe(logsBefore);
  });

  test('ไม่มี scope personnel:manage:person (แม้มี role และ scope อื่นที่เกี่ยวข้อง) -> 403 insufficient-scope', async () => {
    const { personId, version } = await provision();
    const res = await call(method, pathOf(personId), mgr({ scope: 'personnel:read:basic personnel:read:contact personnel:write:employment audit:read' }), bodyOf(version));
    expect(res.status).toBe(403);
    expect(res.body.type).toMatch(/insufficient-scope/);
  });

  test('บุคคลที่ไม่มีอยู่ -> 404', async () => {
    const res = await call(method, pathOf(crypto.randomUUID()), mgr(), bodyOf(1));
    expect(res.status).toBe(404);
  });
});

describe('POST /persons: เลิกเก็บวันเกิดที่ HR กรอก', () => {
  test('เก็บเฉพาะชื่อ (ไม่แตะ person_identity) พร้อม log ผู้กระทำ/เหตุผล; ไม่เขียน expected_birth_date และไม่มี log ของฟิลด์นี้; manage-profile ไม่มี birthDate', async () => {
    const { personId } = await provision();
    expect(await expectedOf(personId)).toEqual({ first: 'สมชาย', last: 'ทดสอบ', birth: null });
    expect((await adminPool.query(`SELECT 1 FROM mdm.person_identity WHERE person_id = $1`, [personId])).rows).toEqual([]);

    const logs = (await logsFor(personId)).filter((l) => l.field_name.startsWith('person.expected_'));
    expect(logs.map((l) => l.field_name).sort()).toEqual(['person.expected_first_name_th', 'person.expected_last_name_th']);
    expect(logs.every((l) => l.changed_by === 'HR' && l.actor_client === 'hr-console' && l.reason === 'เพิ่มบุคลากรใหม่ตามคำสั่งบรรจุ')).toBe(true);

    expect((await profile(personId)).expectedIdentity).toEqual({ firstNameTh: 'สมชาย', lastNameTh: 'ทดสอบ', editable: true, lockedReason: null });
  });

  test('ส่ง expectedBirthDate มา -> 400 (ทุกค่า) และไม่สร้างบุคคล; ชื่อยาวเกิน 200 -> 400 (ไม่ใช่ 500)', async () => {
    const attempt = async (extra) => {
      const pid = makeFakePid();
      const res = await call('post', '/persons', { scope: 'personnel:provision personnel:read:basic', sub: uniqueSub('hr'), azp: 'hr-console', roles: [ROLE] }, {
        pid, expectedFirstNameTh: 'ก', expectedLastNameTh: 'ข', reason: 'ทดสอบ', employment: { employeeNo: pid, personnelType: 'OUTSOURCE_INDIVIDUAL', orgUnitId, effectiveFrom: '2024-01-01' }, ...extra,
      });
      return res.status;
    };
    const before = Number((await adminPool.query(`SELECT count(*) FROM mdm.person`)).rows[0].count);
    for (const value of ['1990-05-17', '2999-01-01', '17/05/1990', null]) {
      // eslint-disable-next-line no-await-in-loop
      expect([value, await attempt({ expectedBirthDate: value })]).toEqual([value, 400]);
    }
    expect(Number((await adminPool.query(`SELECT count(*) FROM mdm.person`)).rows[0].count)).toBe(before);
    expect(await attempt({ expectedFirstNameTh: 'ก'.repeat(201) })).toBe(400);
    expect(await attempt({ expectedLastNameTh: 'ข'.repeat(201) })).toBe(400);
    expect(await attempt({ expectedFirstNameTh: 'ก'.repeat(200) })).toBe(201);
  });
});

describe('GET /persons/{id}/manage-profile', () => {
  test('คืนข้อมูลติดต่อค่าเต็ม + ผู้ติดต่อฉุกเฉิน และเขียน access_log ทุกครั้ง (ผู้เปิด, endpoint, fields_returned ที่ส่งจริง)', async () => {
    const { personId, version } = await provision();
    const auth = mgr();
    const patched = await call('patch', `/persons/${personId}/contact`, auth, { expectedVersion: version, reason: 'บันทึกเบอร์ติดต่อ', mobilePhone: '0812345678', emailPersonal: 'somchai@example.com' });
    expect(patched.status).toBe(200);

    const reader = mgr();
    const before = Number((await adminPool.query(`SELECT count(*)::int AS n FROM audit.access_log WHERE actor_sub = $1`, [reader.sub])).rows[0].n);
    const res = await call('get', `/persons/${personId}/manage-profile`, reader);
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ mobilePhone: '0812345678', emailPersonal: 'somchai@example.com', updatedBy: 'HR' });

    const { rows } = await adminPool.query(
      `SELECT endpoint, http_method, fields_returned, subject_person_id, keycloak_client_id, response_status FROM audit.access_log WHERE actor_sub = $1 ORDER BY access_id`,
      [reader.sub]
    );
    expect(rows).toHaveLength(before + 1);
    expect(rows[0]).toMatchObject({ endpoint: `/api/v1/persons/${personId}/manage-profile`, http_method: 'GET', subject_person_id: personId, keycloak_client_id: 'hr-console', response_status: 200 });
    expect(rows[0].fields_returned).toEqual(expect.arrayContaining(['contact.mobilePhone', 'contact.emailPersonal', 'expectedIdentity.firstNameTh']));
  });

  test('การแก้ที่คืนโปรไฟล์ใหม่ (PATCH contact) ก็เขียน access_log; ถูกปฏิเสธ (403/409) ไม่เขียน', async () => {
    const { personId, version } = await provision();
    const auth = mgr();
    const count = async () => Number((await adminPool.query(`SELECT count(*)::int AS n FROM audit.access_log WHERE actor_sub = $1`, [auth.sub])).rows[0].n);

    expect((await call('patch', `/persons/${personId}/contact`, auth, { expectedVersion: version + 9, reason: 'x', lineId: 'abc' })).status).toBe(409);
    expect(await count()).toBe(0);
    expect((await call('patch', `/persons/${personId}/contact`, auth, { expectedVersion: version, reason: 'บันทึก line', lineId: 'abc' })).status).toBe(200);
    expect(await count()).toBe(1);
  });

  test('ไม่มีข้อมูลติดต่อ: ไม่มี key contact (ตัดทั้ง key ไม่ใส่ null) และ emergencyContacts เป็นรายการว่าง', async () => {
    const { personId } = await provision();
    const body = await profile(personId);
    expect(body).not.toHaveProperty('contact');
    expect(body.emergencyContacts).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('null,"');
  });
});

describe('hr_officer ที่ไม่มี hr_master_data_admin ต้องไม่เห็นข้อมูลติดต่อใน GET /persons/{id} เดิม', () => {
  test('ตัดกลุ่ม contact/emergencyContacts แม้ token มี personnel:read:contact; role hr_master_data_admin หรือไม่มี role hr_officer เห็นตาม scope เหมือนเดิม', async () => {
    const { personId, version } = await provision();
    const w = await call('patch', `/persons/${personId}/contact`, mgr(), { expectedVersion: version, reason: 'บันทึกข้อมูลติดต่อ', mobilePhone: '0899990000' });
    expect(w.status).toBe(200);
    const put = await call('put', `/persons/${personId}/emergency-contacts`, mgr(), {
      expectedVersion: w.body.version,
      reason: 'บันทึกผู้ติดต่อ',
      contacts: [{ fullName: 'ผู้ติดต่อ ทดสอบ', relationship: 'เพื่อน', phone: '0811110000', priority: 1 }],
    });
    expect(put.status).toBe(200);

    const scope = 'personnel:read:basic personnel:read:contact';
    const get = async (roles) => (await call('get', `/persons/${personId}`, { scope, sub: uniqueSub('u'), azp: 'hr-console', roles })).body;

    const officer = await get(['hr_officer']);
    expect(officer).toHaveProperty('basic');
    expect(officer).not.toHaveProperty('contact');
    expect(officer).not.toHaveProperty('emergencyContacts');
    expect(JSON.stringify(officer)).not.toContain('0899990000');
    expect(JSON.stringify(officer)).not.toContain('0811110000');

    const admin = await get(['hr_officer', ROLE]);
    expect(admin.contact.mobilePhone).toBe('0899990000');
    expect(admin.emergencyContacts).toHaveLength(1);

    // ระบบปลายทาง (ไม่มี role hr_officer) ที่ DPO อนุมัติ scope contact ให้ ยังเห็นเหมือนเดิม
    const consumer = await get(undefined);
    expect(consumer.contact.mobilePhone).toBe('0899990000');

    // และ hr_officer ไม่เข้า manage-profile ได้
    expect((await call('get', `/persons/${personId}/manage-profile`, mgr({ roles: ['hr_officer'] }))).status).toBe(403);
  });
});

describe('PATCH /persons/{id}/expected-identity', () => {
  test('แก้ชื่อ: version +1, log ต่อฟิลด์ (ค่าเก่า/ใหม่, ผู้กระทำ, เหตุผล), ฟิลด์ที่ไม่ส่งไม่ถูกแตะ, ค่าเดิมซ้ำไม่เปลี่ยนอะไร', async () => {
    const { personId, version } = await provision();
    const auth = mgr();
    const res = await call('patch', `/persons/${personId}/expected-identity`, auth, { expectedVersion: version, reason: '  แก้ตามสำเนาทะเบียนบ้าน  ', firstNameTh: ' สมศรี ' });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(version + 1);
    expect(res.body.expectedIdentity).toMatchObject({ firstNameTh: 'สมศรี', lastNameTh: 'ทดสอบ', editable: true });
    expect(res.body.expectedIdentity).not.toHaveProperty('birthDate');
    expect(await expectedOf(personId)).toEqual({ first: 'สมศรี', last: 'ทดสอบ', birth: null });

    const logs = (await logsFor(personId)).filter((l) => l.reason === 'แก้ตามสำเนาทะเบียนบ้าน');
    expect(logs.map((l) => [l.field_name, l.old_value, l.new_value])).toEqual([['person.expected_first_name_th', 'สมชาย', 'สมศรี']]);
    expect(logs.every((l) => l.changed_by === 'HR' && l.actor_sub === auth.sub && l.actor_client === 'hr-console' && l.table_name === 'person')).toBe(true);
    expect((await outboxFor(personId)).filter((e) => e.event_type !== 'PERSON_CLAIMED')).toEqual([]); // PENDING_CLAIM ไม่ส่ง outbox

    const same = await call('patch', `/persons/${personId}/expected-identity`, auth, { expectedVersion: version + 1, reason: 'ส่งค่าเดิมซ้ำ', firstNameTh: 'สมศรี' });
    expect(same.status).toBe(200);
    expect(await versionOf(personId)).toBe(version + 1);
    expect((await logsFor(personId)).filter((l) => l.reason === 'ส่งค่าเดิมซ้ำ')).toEqual([]);
  });

  test('ส่ง birthDate (ค่าใดก็ตาม รวม null) -> 400 และไม่เขียนอะไร; ส่งชื่อมาด้วยก็ปฏิเสธทั้งคำขอ; ค่าเดิมในคอลัมน์ไม่ถูกแตะ', async () => {
    const { personId, version } = await provision();
    // แถวเก่าที่มีวันเกิดอยู่ก่อนเลิกเก็บ: ต้องไม่ถูกลบ/แก้ และไม่ถูกคืนใน manage-profile
    await adminPool.query(`UPDATE mdm.person SET expected_birth_date = '1990-05-17' WHERE person_id = $1`, [personId]);
    const send = (body) => call('patch', `/persons/${personId}/expected-identity`, mgr(), { expectedVersion: version, reason: 'ทดสอบเลิกเก็บวันเกิด', ...body });
    for (const body of [{ birthDate: '1991-02-03' }, { birthDate: null }, { birthDate: '2999-01-01' }, { firstNameTh: 'สมศรี', birthDate: '1991-02-03' }]) {
      // eslint-disable-next-line no-await-in-loop
      expect([body, (await send(body)).status]).toEqual([body, 400]);
    }
    expect(await versionOf(personId)).toBe(version);
    expect(await expectedOf(personId)).toEqual({ first: 'สมชาย', last: 'ทดสอบ', birth: '1990-05-17' });
    expect((await profile(personId)).expectedIdentity).not.toHaveProperty('birthDate');
  });

  test('ส่งชื่ออย่างเดียวสำเร็จตามเดิม และไม่แตะค่าวันเกิดเดิมในคอลัมน์', async () => {
    const { personId, version } = await provision();
    await adminPool.query(`UPDATE mdm.person SET expected_birth_date = '1990-05-17' WHERE person_id = $1`, [personId]);
    const res = await call('patch', `/persons/${personId}/expected-identity`, mgr(), { expectedVersion: version, reason: 'แก้เฉพาะชื่อ', lastNameTh: 'นามสกุลใหม่' });
    expect(res.status).toBe(200);
    expect(await expectedOf(personId)).toEqual({ first: 'สมชาย', last: 'นามสกุลใหม่', birth: '1990-05-17' });
    expect((await logsFor(personId)).filter((l) => l.reason === 'แก้เฉพาะชื่อ').map((l) => l.field_name)).toEqual(['person.expected_last_name_th']);
  });

  test('ตรวจข้อมูลเข้า: ไม่ส่งฟิลด์ -> 422; ชื่อว่าง -> 400/422; ชื่อมีเลข 13 หลัก -> 422; รูปแบบผิด/ยาวเกิน 200 -> 400; ไม่เขียนอะไร', async () => {
    const { personId, version } = await provision();
    const patch = (body) => call('patch', `/persons/${personId}/expected-identity`, mgr(), { expectedVersion: version, reason: 'ทดสอบตรวจข้อมูล', ...body });
    const pid = makeFakePid();

    expect((await patch({})).status).toBe(422);
    expect((await patch({ firstNameTh: '' })).status).toBe(400);
    expect((await patch({ firstNameTh: '   ' })).status).toBe(422);
    const named = await patch({ lastNameTh: `นามสกุล ${pid}` });
    expect(named.status).toBe(422);
    expect(JSON.stringify(named.body)).not.toContain(pid);
    expect((await patch({ firstNameTh: 'ก'.repeat(201) })).status).toBe(400);
    expect((await patch({ lastNameTh: 'ข'.repeat(201) })).status).toBe(400);
    expect((await patch({ firstNameTh: 'ก'.repeat(200) })).status).toBe(200);
    expect(await expectedOf(personId)).toMatchObject({ first: 'ก'.repeat(200), last: 'ทดสอบ', birth: null });
  });

  test('reason/expectedVersion บังคับ: ไม่ส่ง -> 400; ว่าง -> 422; มีเลข 13 หลัก (ติดกัน/ขีด) -> 422 ไม่สะท้อนเลข; version ไม่ตรง -> 409 ไม่เขียน', async () => {
    const { personId, version } = await provision();
    const auth = mgr();
    const send = (body) => call('patch', `/persons/${personId}/expected-identity`, auth, body);
    const pid = makeFakePid();

    expect((await send({ reason: 'ไม่มี version', firstNameTh: 'ก' })).status).toBe(400);
    expect((await send({ expectedVersion: version, firstNameTh: 'ก' })).status).toBe(400);
    const blank = await send({ expectedVersion: version, reason: '   ', firstNameTh: 'ก' });
    expect(blank.status).toBe(422);
    expect(blank.body.type).toMatch(/reason-required/);
    for (const text of [`อ้างถึง ${pid}`, `อ้างถึง ${dashed(pid)}`]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await send({ expectedVersion: version, reason: text, firstNameTh: 'ก' });
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(/reason-contains-pid/);
      expect(JSON.stringify(res.body)).not.toContain(pid);
    }
    expect((await send({ expectedVersion: version, reason: 'ก'.repeat(501), firstNameTh: 'ก' })).status).toBe(400);
    const stale = await send({ expectedVersion: version + 3, reason: 'version เก่า', firstNameTh: 'ก' });
    expect(stale.status).toBe(409);
    expect(stale.body.type).toMatch(/version-conflict/);
    expect(await expectedOf(personId)).toMatchObject({ first: 'สมชาย' });
    expect(await versionOf(personId)).toBe(version);
  });

  test('การแก้สองคนพร้อมกันด้วย version เดียวกัน: สำเร็จคนเดียว อีกคน 409', async () => {
    const { personId, version } = await provision();
    const [a, b] = await Promise.all([
      call('patch', `/persons/${personId}/expected-identity`, mgr(), { expectedVersion: version, reason: 'คนที่หนึ่ง', firstNameTh: 'หนึ่ง' }),
      call('patch', `/persons/${personId}/expected-identity`, mgr(), { expectedVersion: version, reason: 'คนที่สอง', firstNameTh: 'สอง' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await versionOf(personId)).toBe(version + 1);
  });
});

describe('คนที่เคยยืนยัน ThaID แล้วแก้ข้อมูลระบุตัวตนไม่ได้ (409 ที่ API + trigger ที่ DB)', () => {
  const patchName = (personId, version) =>
    call('patch', `/persons/${personId}/expected-identity`, mgr(), { expectedVersion: version, reason: 'พยายามแก้หลังยืนยัน', firstNameTh: 'แก้หลังยืนยัน' });

  async function claimViaThaid(pid) {
    return call('post', '/sync/thaid', { scope: 'sync:thaid', sub: 'check-broker', azp: 'check-broker' }, {
      claims: {
        pid, titleTh: 'นาย', firstNameTh: 'จาก', lastNameTh: 'ThaID', birthDate: '1980-01-01', gender: 'M',
        registeredAddress: { houseNo: '1', subdistrict: { code: '520101' }, district: { code: '5201' }, province: { code: '52' }, fullText: '1 ตำบลเวียงเหนือ' },
        ial: '2.3',
      },
      context: { appId: 'eoffice', audience: 'PERSONNEL', clientIp: '10.0.0.1', userAgent: 'jest' },
    });
  }

  test('หลัง claim จริงผ่าน /sync/thaid: ค่า expected_* ที่ HR กรอกยังอยู่ (ThaID เขียนลง person_identity ไม่ตรงกันก็เก็บเฉยๆ), manage-profile บอกว่าแก้ไม่ได้, PATCH -> 409 identity-locked', async () => {
    const { personId, pid } = await provision();
    expect((await claimViaThaid(pid)).status).toBe(200);

    const after = await profile(personId);
    expect(after.expectedIdentity).toEqual({ firstNameTh: 'สมชาย', lastNameTh: 'ทดสอบ', editable: false, lockedReason: 'THAID_VERIFIED' });
    const identity = (await adminPool.query(`SELECT first_name_th, birth_date::text AS birth FROM mdm.person_identity WHERE person_id = $1`, [personId])).rows[0];
    // ThaID เป็นหลัก ไม่ถูกแตะ/เทียบกับค่าของ HR; payload ยังส่ง birthDate มา แต่เลิกเก็บแล้ว -> birth_date เป็น NULL
    expect(identity).toEqual({ first_name_th: 'จาก', birth: null });

    const res = await patchName(personId, after.version);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/identity-locked/);
    expect(await expectedOf(personId)).toMatchObject({ first: 'สมชาย' });
    expect((await logsFor(personId)).filter((l) => l.reason === 'พยายามแก้หลังยืนยัน')).toEqual([]);
  });

  test.each([
    ['thaid_verified_at ไม่เป็น NULL', `UPDATE mdm.person SET thaid_verified_at = now() WHERE person_id = $1`, 'THAID_VERIFIED'],
    ['claimed_at ไม่เป็น NULL', `UPDATE mdm.person SET claimed_at = now() WHERE person_id = $1`, 'THAID_VERIFIED'],
    ['status ไม่ใช่ PENDING_CLAIM (ACTIVE)', `UPDATE mdm.person SET status = 'ACTIVE' WHERE person_id = $1`, 'NOT_PENDING_CLAIM'],
    ['status ไม่ใช่ PENDING_CLAIM (INACTIVE)', `UPDATE mdm.person SET status = 'INACTIVE' WHERE person_id = $1`, 'NOT_PENDING_CLAIM'],
  ])('%s -> 409 และ manage-profile ระบุเหตุผล %s', async (_label, sql, lockedReason) => {
    const { personId } = await provision();
    await adminPool.query(sql, [personId]);
    const p = await profile(personId);
    expect(p.expectedIdentity).toMatchObject({ editable: false, lockedReason });
    const res = await patchName(personId, p.version);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/identity-locked/);
  });

  test('ข้อมูลติดต่อ/ผู้ติดต่อฉุกเฉินแก้ได้ตลอด แม้ยืนยัน ThaID แล้ว', async () => {
    const { personId, pid } = await provision();
    await claimViaThaid(pid);
    const p = await profile(personId);
    const res = await call('patch', `/persons/${personId}/contact`, mgr(), { expectedVersion: p.version, reason: 'อัปเดตเบอร์', mobilePhone: '0877776666' });
    expect(res.status).toBe(200);
    expect(res.body.contact.mobilePhone).toBe('0877776666');
    expect((await outboxFor(personId)).some((e) => e.event_type === 'CONTACT_UPDATED')).toBe(true); // ACTIVE แล้วส่ง outbox
  });

  // ล็อกแถว person ค้างไว้ในอีก connection (แทน sync ที่กำลังทำงาน) แล้วดูว่ามี request ค้างรอล็อกครบกี่ตัวก่อนปล่อย - ไม่พึ่งเวลา
  async function waitForLockWaiters(n) {
    const deadline = Date.now() + 8000;
    let waiting = 0;
    while (waiting < n && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      waiting = (await adminPool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype IN ('transactionid', 'tuple') AND NOT granted`)).rows[0].n;
      // eslint-disable-next-line no-await-in-loop
      if (waiting < n) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return waiting;
  }

  async function race(firstIs) {
    const { personId, pid, version } = await provision();
    const holder = await adminPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM mdm.person WHERE person_id = $1 FOR UPDATE`, [personId]);

      const syncReq = () => claimViaThaid(pid);
      const patchReq = () => patchName(personId, version);
      const order = firstIs === 'sync' ? [syncReq, patchReq] : [patchReq, syncReq];
      const started = [];
      for (let i = 0; i < order.length; i += 1) {
        started.push(order[i]());
        // eslint-disable-next-line no-await-in-loop
        expect(await waitForLockWaiters(i + 1)).toBeGreaterThanOrEqual(i + 1); // ตัวแรกต้องเข้าคิวล็อกก่อนจึงเริ่มตัวที่สอง (คิวล็อกของ Postgres เป็น FIFO)
      }
      await holder.query('COMMIT');
      const [r1, r2] = await Promise.all(started);
      return { personId, syncRes: firstIs === 'sync' ? r1 : r2, patchRes: firstIs === 'sync' ? r2 : r1 };
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  }

  test('แข่งกับ /sync/thaid: sync ได้ล็อกก่อน -> claim สำเร็จ และ PATCH เห็นว่ายืนยันแล้ว -> 409 (ไม่เขียนทับ)', async () => {
    const { personId, syncRes, patchRes } = await race('sync');
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.result).toBe('CLAIMED');
    expect(patchRes.status).toBe(409);
    expect(patchRes.body.type).toMatch(/identity-locked/);
    expect(await expectedOf(personId)).toMatchObject({ first: 'สมชาย' });
  });

  test('แข่งกับ /sync/thaid: PATCH ได้ล็อกก่อน -> แก้สำเร็จ แล้ว claim ตามหลังได้ตามปกติ (ThaID ไม่ถูกกระทบ, ค่าของ HR คงอยู่)', async () => {
    const { personId, syncRes, patchRes } = await race('patch');
    expect(patchRes.status).toBe(200);
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.result).toBe('CLAIMED');
    expect(await expectedOf(personId)).toMatchObject({ first: 'แก้หลังยืนยัน' });
    expect((await adminPool.query(`SELECT first_name_th FROM mdm.person_identity WHERE person_id = $1`, [personId])).rows[0].first_name_th).toBe('จาก');
  });
});

describe('PATCH /persons/{id}/contact', () => {
  const patch = (personId, version, body, auth = mgr()) =>
    call('patch', `/persons/${personId}/contact`, auth, { expectedVersion: version, reason: 'ทดสอบแก้ข้อมูลติดต่อ', ...body });

  test('PATCH จริง: ฟิลด์ที่ไม่ส่งไม่ถูกแตะ, null/สตริงว่างล้างค่า, ที่อยู่ส่งบางส่วน, updated_by = HR, log ต่อฟิลด์พร้อมผู้กระทำ', async () => {
    const { personId, version } = await provision();
    const auth = mgr();
    const first = await patch(personId, version, {
      mobilePhone: '0812345678', phoneAlt: '021112222', emailPersonal: 'a@example.com', lineId: 'line.a',
    }, auth);
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(version + 1);
    expect(first.body.contact).toMatchObject({ mobilePhone: '0812345678', phoneAlt: '021112222', emailPersonal: 'a@example.com', lineId: 'line.a', updatedBy: 'HR' });

    // แก้เฉพาะเบอร์มือถือ + ล้าง lineId (null) + ล้าง phoneAlt (สตริงว่าง)
    const second = await patch(personId, first.body.version, { mobilePhone: '0899999999', lineId: null, phoneAlt: '   ' }, auth);
    expect(second.status).toBe(200);
    expect(second.body.contact).toMatchObject({ mobilePhone: '0899999999', lineId: null, phoneAlt: null, emailPersonal: 'a@example.com' });

    const logs = (await logsFor(personId)).filter((l) => l.table_name === 'person_contact');
    const secondLogs = logs.filter((l) => l.field_name === 'contact.mobile_phone');
    expect(secondLogs.map((l) => [l.old_value, l.new_value])).toEqual([[null, '0812345678'], ['0812345678', '0899999999']]);
    expect(logs.every((l) => l.changed_by === 'HR' && l.actor_sub === auth.sub && l.actor_client === 'hr-console' && l.reason === 'ทดสอบแก้ข้อมูลติดต่อ')).toBe(true);
    expect(logs.filter((l) => l.field_name === 'contact.email_personal')).toHaveLength(1); // email ไม่ได้ส่งรอบสอง -> ไม่มี log รอบสอง
  });

  test('ไม่มีอะไรเปลี่ยน -> ไม่เพิ่ม version/log/outbox; ไม่ส่งฟิลด์เลย -> 422', async () => {
    const { personId, version } = await provision();
    const one = await patch(personId, version, { lineId: 'same' });
    const base = { logs: (await logsFor(personId)).length, version: await versionOf(personId) };
    const again = await patch(personId, one.body.version, { lineId: 'same' });
    expect(again.status).toBe(200);
    expect({ logs: (await logsFor(personId)).length, version: await versionOf(personId) }).toEqual(base);
    expect((await patch(personId, one.body.version, {})).status).toBe(422);
  });

  test('outbox CONTACT_UPDATED เฉพาะบุคคลที่ claim แล้ว (PENDING_CLAIM ไม่ส่ง) และ payload ใช้สถานะจริง', async () => {
    const pending = await provision();
    await patch(pending.personId, pending.version, { lineId: 'p' });
    expect((await outboxFor(pending.personId)).filter((e) => e.event_type === 'CONTACT_UPDATED')).toEqual([]);

    const active = await provision();
    await setStatus(active.personId, 'ACTIVE');
    const v = await versionOf(active.personId);
    await patch(active.personId, v, { lineId: 'a', mobilePhone: '0811112222' });
    const events = (await outboxFor(active.personId)).filter((e) => e.event_type === 'CONTACT_UPDATED');
    expect(events).toHaveLength(1);
    expect(events[0].changed_fields.sort()).toEqual(['contact.line_id', 'contact.mobile_phone']);
    expect(events[0].payload).toMatchObject({ personId: active.personId, version: v + 1, status: 'ACTIVE' });
    expect(JSON.stringify(events[0])).not.toContain('0811112222');
  });

  test('ความยาว/รูปแบบเกินคอลัมน์ DB ทุกฟิลด์ -> 400 (ไม่ใช่ 500) และไม่เขียน; ความยาวสูงสุดพอดีผ่าน', async () => {
    const { personId, version } = await provision();
    const bad = [
      { mobilePhone: '0'.repeat(31) }, { phoneAlt: '0'.repeat(31) }, { emailPersonal: 'e'.repeat(301) },
      { lineId: 'l'.repeat(101) },
    ];
    for (const body of bad) {
      // eslint-disable-next-line no-await-in-loop
      const res = await patch(personId, version, body);
      expect([body, res.status]).toEqual([body, 400]);
    }
    expect(await versionOf(personId)).toBe(version);

    const max = await patch(personId, version, {
      phoneAlt: '0812345678', lineId: 'l'.repeat(100),
    });
    expect(max.status).toBe(200);
  });

  test('reason/expectedVersion บังคับเหมือน endpoint อื่น (ไม่ส่ง 400, ว่าง 422, มีเลข 13 หลัก 422, version ไม่ตรง 409) และไม่เขียน', async () => {
    const { personId, version } = await provision();
    const send = (body) => call('patch', `/persons/${personId}/contact`, mgr(), body);
    const pid = makeFakePid();
    expect((await send({ expectedVersion: version, lineId: 'x' })).status).toBe(400);
    expect((await send({ reason: 'ไม่มี version', lineId: 'x' })).status).toBe(400);
    expect((await send({ expectedVersion: version, reason: '  ', lineId: 'x' })).status).toBe(422);
    const withPid = await send({ expectedVersion: version, reason: `เบอร์ของ ${pid}`, lineId: 'x' });
    expect(withPid.status).toBe(422);
    expect(JSON.stringify(withPid.body)).not.toContain(pid);
    expect((await send({ expectedVersion: version + 1, reason: 'เก่า', lineId: 'x' })).status).toBe(409);
    expect(await versionOf(personId)).toBe(version);
  });

  test('เจ้าของแก้เองผ่าน portal (PUT /me/contact) แล้ว HR ที่เปิดหน้าค้างไว้ (version เก่า) แก้ -> 409 ไม่ทับ', async () => {
    const { personId, version } = await provision();
    const first = await patch(personId, version, { lineId: 'hr' });
    expect(first.status).toBe(200);
    const self = await call('put', '/me/contact', { scope: 'personnel:self', sub: 'service-account-mdm-portal', azp: 'mdm-portal', personId }, { mobilePhone: '0855554444' });
    expect(self.status).toBe(200);
    const stale = await patch(personId, first.body.version, { lineId: 'hr2' });
    expect(stale.status).toBe(409);
  });
});

describe('PUT /persons/{id}/emergency-contacts (HR)', () => {
  const put = (personId, version, contacts, auth = mgr(), reason = 'ปรับผู้ติดต่อฉุกเฉิน') =>
    call('put', `/persons/${personId}/emergency-contacts`, auth, { expectedVersion: version, reason, contacts });
  const emergencyLogs = async (personId) => (await logsFor(personId)).filter((l) => l.table_name === 'emergency_contact');

  test('บันทึกเฉพาะช่องที่เปลี่ยน ไม่เก็บค่า (เหมือน portal): ผู้กระทำ HR, reason = เหตุผล + ลำดับช่อง; ซ้ำ = ไม่เขียน; แก้ช่องเดียว = log ช่องนั้น', async () => {
    const { personId, version } = await provision();
    const auth = mgr();
    const list = [
      { fullName: 'นางสมมติ หนึ่ง', relationship: 'คู่สมรส', phone: '0811110001', priority: 1 },
      { fullName: 'นายสมมติ สอง', relationship: 'บิดา', phone: '0811110002', priority: 2 },
    ];
    const first = await put(personId, version, list, auth);
    expect(first.status).toBe(200);
    expect(first.body.emergencyContacts.map((c) => c.priority)).toEqual([1, 2]);
    const logs = await emergencyLogs(personId);
    expect(logs).toHaveLength(6);
    expect(logs.every((l) => l.old_value === null && l.new_value === null && l.changed_by === 'HR' && l.actor_sub === auth.sub && l.actor_client === 'hr-console')).toBe(true);
    expect(new Set(logs.map((l) => l.reason))).toEqual(new Set(['ปรับผู้ติดต่อฉุกเฉิน (ผู้ติดต่อฉุกเฉินลำดับที่ 1)', 'ปรับผู้ติดต่อฉุกเฉิน (ผู้ติดต่อฉุกเฉินลำดับที่ 2)']));
    const all = JSON.stringify(await logsFor(personId));
    for (const secret of ['นางสมมติ', 'นายสมมติ', '0811110001', '0811110002', 'คู่สมรส', 'บิดา']) expect(all).not.toContain(secret);

    const same = await put(personId, first.body.version, list, auth, 'ส่งซ้ำ');
    expect(same.status).toBe(200);
    expect(await versionOf(personId)).toBe(first.body.version);
    expect(await emergencyLogs(personId)).toHaveLength(6);

    const edited = await put(personId, first.body.version, [list[0], { ...list[1], phone: '0899990002' }], auth, 'แก้เบอร์ช่อง 2');
    expect(edited.status).toBe(200);
    expect((await emergencyLogs(personId)).slice(6).map((l) => [l.field_name, l.reason])).toEqual([['emergency_contact.phone', 'แก้เบอร์ช่อง 2 (ผู้ติดต่อฉุกเฉินลำดับที่ 2)']]);

    const cleared = await put(personId, edited.body.version, [], auth, 'ลบทั้งหมด');
    expect(cleared.body.emergencyContacts).toEqual([]);
    expect(await emergencyLogs(personId)).toHaveLength(6 + 1 + 6);
  });

  test('outbox CONTACT_UPDATED เฉพาะ claim แล้ว; version เพิ่มเมื่อมีการเปลี่ยน', async () => {
    const active = await provision();
    await setStatus(active.personId, 'ACTIVE');
    const v = await versionOf(active.personId);
    const res = await put(active.personId, v, [{ fullName: 'ก', relationship: 'ข', phone: '0811110003' }]);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(v + 1);
    const events = (await outboxFor(active.personId)).filter((e) => e.event_type === 'CONTACT_UPDATED');
    expect(events).toHaveLength(1);
    expect(events[0].payload.status).toBe('ACTIVE');

    const pending = await provision();
    await put(pending.personId, pending.version, [{ fullName: 'ก', relationship: 'ข', phone: '0811110003' }]);
    expect((await outboxFor(pending.personId)).filter((e) => e.event_type === 'CONTACT_UPDATED')).toEqual([]);
  });

  test('ตรวจข้อมูลเข้า: เกิน 3 -> 400; priority ซ้ำ -> 422; ความยาวเกินคอลัมน์ (200/50/20) -> 400; ไม่ครบ 3 ฟิลด์ -> 400; ไม่เขียนอะไร', async () => {
    const { personId, version } = await provision();
    const c = (n, extra = {}) => ({ fullName: `ผู้ติดต่อ ${n}`, relationship: 'เพื่อน', phone: `08111100${n}0`, priority: n, ...extra });
    expect((await put(personId, version, [c(1), c(2), c(3), c(1)])).status).toBe(400);
    const dup = await put(personId, version, [c(1), c(2, { priority: 1 })]);
    expect(dup.status).toBe(422);
    expect(dup.body.type).toMatch(/emergency-contacts-invalid/);
    expect((await put(personId, version, [c(1, { priority: 4 })])).status).toBe(400);
    expect((await put(personId, version, [c(1, { fullName: 'ก'.repeat(201) })])).status).toBe(400);
    expect((await put(personId, version, [c(1, { relationship: 'ก'.repeat(51) })])).status).toBe(400);
    expect((await put(personId, version, [c(1, { phone: '0'.repeat(21) })])).status).toBe(400);
    expect((await put(personId, version, [{ fullName: 'ก', phone: '081' }])).status).toBe(400);
    expect(await versionOf(personId)).toBe(version);
    expect(await emergencyLogs(personId)).toEqual([]);
    expect((await put(personId, version, [c(1, { fullName: 'ก'.repeat(200), relationship: 'ข'.repeat(50), phone: '0'.repeat(20) })])).status).toBe(200);
  });

  test('reason/expectedVersion บังคับ: มีเลข 13 หลัก -> 422; version ไม่ตรง -> 409 ไม่ลบรายการเดิม', async () => {
    const { personId, version } = await provision();
    const ok = await put(personId, version, [{ fullName: 'ผู้ติดต่อ', relationship: 'เพื่อน', phone: '0811110009' }]);
    const pid = makeFakePid();
    expect((await put(personId, ok.body.version, [], mgr(), `ลบเพราะ ${pid}`)).status).toBe(422);
    expect((await put(personId, ok.body.version + 4, [], mgr(), 'ลบทั้งหมด')).status).toBe(409);
    expect((await profile(personId)).emergencyContacts).toHaveLength(1);
  });

  test('PUT /me/emergency-contacts (portal): priority ซ้ำ -> 422 ไม่ใช่ 500', async () => {
    const { personId } = await provision();
    const res = await call('put', '/me/emergency-contacts', { scope: 'personnel:self', sub: 'service-account-mdm-portal', azp: 'mdm-portal', personId }, [
      { fullName: 'ก', relationship: 'ข', phone: '0811110001', priority: 1 },
      { fullName: 'ค', relationship: 'ง', phone: '0811110002', priority: 1 },
    ]);
    expect(res.status).toBe(422);
  });
});

describe('GET /persons/{id}/history', () => {
  test('เรียงใหม่ -> เก่า, มีผู้กระทำ/เหตุผล, ชื่อแสดงค่า แต่วันเกิด/ข้อมูลติดต่อ/ผู้ติดต่อฉุกเฉินปกปิดค่า (valuesHidden), ไม่มีเลข 13 หลัก, cursor ไม่ซ้ำ', async () => {
    const { personId, pid, version } = await provision();
    const auth = mgr();
    const a = await call('patch', `/persons/${personId}/expected-identity`, auth, { expectedVersion: version, reason: 'แก้ชื่อ', firstNameTh: 'ชื่อใหม่' });
    // แถวเก่าของ expected_birth_date (เขียนก่อนเลิกเก็บ) ต้องยังอ่านประวัติได้แต่ปกปิดค่า
    await adminPool.query(`INSERT INTO audit.data_change_log (person_id, table_name, field_name, old_value, new_value, changed_by) VALUES ($1, 'person', 'person.expected_birth_date', to_jsonb('1990-05-17'::text), to_jsonb('1992-01-01'::text), 'HR')`, [personId]);
    const b = await call('patch', `/persons/${personId}/contact`, auth, { expectedVersion: a.body.version, reason: 'แก้เบอร์', mobilePhone: '0811119999' });
    await call('put', `/persons/${personId}/emergency-contacts`, auth, { expectedVersion: b.body.version, reason: 'ผู้ติดต่อ', contacts: [{ fullName: 'ผู้ติดต่อลับ', relationship: 'เพื่อน', phone: '0822228888' }] });
    // แถวเก่าที่เลข 13 หลักหลุดมาใน reason (ก่อนมีการปฏิเสธ) ต้องถูกปกปิดตอนแสดง
    await adminPool.query(`INSERT INTO audit.data_change_log (person_id, table_name, field_name, changed_by, reason) VALUES ($1, 'person', 'status', 'HR', $2)`, [personId, `เก่า ${pid}`]);

    const res = await call('get', `/persons/${personId}/history`, mgr(), undefined);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((e) => e.logId);
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
    const byField = (name) => res.body.data.find((e) => e.fieldKey === name);

    expect(byField('person.expected_first_name_th')).toMatchObject({ oldValue: 'สมชาย', newValue: 'ชื่อใหม่', valuesHidden: false, reason: 'แก้ชื่อ', changedBy: 'HR', actorSub: auth.sub, actorClient: 'hr-console' });
    for (const hidden of ['person.expected_birth_date', 'contact.mobile_phone', 'emergency_contact.full_name']) {
      expect(byField(hidden)).toMatchObject({ valuesHidden: true, oldValue: null, newValue: null });
    }
    const text = JSON.stringify(res.body);
    for (const secret of [pid, '0811119999', '0822228888', 'ผู้ติดต่อลับ', '1992-01-01']) expect(text).not.toContain(secret);

    const seen = [];
    let cursor;
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const page = await call('get', `/persons/${personId}/history?limit=3${cursor ? `&cursor=${cursor}` : ''}`, mgr(), undefined);
      seen.push(...page.body.data.map((e) => e.logId));
      cursor = page.body.page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(ids);
  });

  test('เปิดดูประวัติเขียน access_log', async () => {
    const { personId } = await provision();
    const auth = mgr();
    await call('get', `/persons/${personId}/history`, auth, undefined);
    const { rows } = await adminPool.query(`SELECT endpoint FROM audit.access_log WHERE actor_sub = $1`, [auth.sub]);
    expect(rows.map((r) => r.endpoint)).toEqual([`/api/v1/persons/${personId}/history`]);
  });
});
