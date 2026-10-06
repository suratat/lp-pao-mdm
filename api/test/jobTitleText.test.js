const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { rolesFor, withDefaultReason } = require('./hrWrite');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { makeFakePid, pidHash } = require('../src/security/pid');
const { insertFixtureOrgUnit, bindClaimToEmployeeNo } = require('./fixtures');
const { POSITION_RULES } = require('../src/services/personnelPositionRules');
const {
  MAX_LENGTH,
  jobTitleAllowedFor,
  normalizeJobTitleText,
  looksLikePid,
  validateJobTitleText,
  assertJobTitleMatchesPersonnelType,
} = require('../src/services/jobTitleText');

// ชื่อตำแหน่ง/ลักษณะงาน (ข้อความอิสระ) - เขียนสเปกซ้ำเป็น literal โดยตั้งใจ (ถ้ากฎในโค้ดเปลี่ยนโดยไม่แก้สเปกตรงนี้ เทสต์ต้องล้ม)
const REQUIRED_TYPES = ['CIVIL_SERVANT', 'TEACHER', 'PERMANENT_EMPLOYEE', 'TRANSFERRED_HEALTH'];
const FORBIDDEN_TYPES = ['CONTRACT_EMPLOYEE', 'GENERAL_EMPLOYEE', 'EXPERT_EMPLOYEE', 'OUTSOURCE_INDIVIDUAL', 'POLITICAL_APPOINTEE'];
const ALLOWED_TYPES = [...FORBIDDEN_TYPES, 'OTHER'];
const ALL_TYPES = [...REQUIRED_TYPES, ...ALLOWED_TYPES];

let ctx;
let adminPool;
let pepper;
let orgUnitId;

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  pepper = await ctx.vault.getPepper();
  orgUnitId = await insertFixtureOrgUnit(adminPool);
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

const api = async (method, url, scope) => {
  const token = await ctx.auth.signToken({ scope, roles: rolesFor(method, url) });
  return {
    send: (body) => request(ctx.app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(withDefaultReason(method, url, body)),
  };
};
const get = async (url, scope) => {
  const token = await ctx.auth.signToken({ scope });
  return request(ctx.app).get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`);
};

async function makePosition() {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบชื่อตำแหน่งข้อความ', 'GENERAL', $2) RETURNING position_id`,
    [`POS-JT-${crypto.randomUUID()}`, orgUnitId]
  );
  return rows[0].position_id;
}

async function makePerson(status = 'ACTIVE') {
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version, deleted_at)
     VALUES ($1, $2, $3, 'VERIFIED', 1, ${status === 'INACTIVE' ? 'now()' : 'NULL'})`,
    [personId, crypto.randomBytes(32).toString('hex'), status]
  );
  return personId;
}

const rowsOf = async (personId) =>
  (
    await adminPool.query(
      `SELECT job_title_text, is_current, effective_from::text AS effective_from FROM mdm.employment WHERE person_id = $1 ORDER BY effective_from, is_current`,
      [personId]
    )
  ).rows;

async function body(personnelType, { withPosition = false, jobTitleText, effectiveFrom = '2024-01-01', employeeNo } = {}) {
  return {
    employeeNo: employeeNo ?? `EMP-JT-${crypto.randomUUID()}`,
    personnelType,
    orgUnitId,
    ...(withPosition ? { positionId: await makePosition() } : {}),
    ...(jobTitleText !== undefined ? { jobTitleText } : {}),
    effectiveFrom,
  };
}

// Employment.jobTitleText มี x-required-scope personnel:read:basic - ผู้เรียกที่ไม่มี scope นี้จะไม่เห็นฟิลด์ใน response (มีเทสต์แยกด้านล่าง)
const put = async (personId, payload) => (await api('put', `/persons/${personId}/employment`, 'personnel:write:employment personnel:read:basic')).send(payload);

// ---------------------------------------------------------------------------------------------------------------------------------
describe('normalize / ตรวจข้อความ (หน่วย)', () => {
  test('trim, รวมขึ้นบรรทัดใหม่/tab เป็นช่องว่างเดียว, ข้อความว่าง = null', () => {
    expect(normalizeJobTitleText('  ช่างไฟฟ้า  ')).toBe('ช่างไฟฟ้า');
    expect(normalizeJobTitleText('ช่าง\r\nไฟฟ้า\n\nอาคาร\tสำนักงาน')).toBe('ช่าง ไฟฟ้า อาคาร สำนักงาน');
    expect(normalizeJobTitleText('ช่าง\u2028ไฟฟ้า\u2029อาคาร\u0085ชั้น 2')).toBe('ช่าง ไฟฟ้า อาคาร ชั้น 2');
    for (const empty of ['', '   ', '\n\t', undefined, null, '\u202E\u200B']) expect(normalizeJobTitleText(empty)).toBeNull();
  });

  test('ตัด control characters และอักขระ bidi/zero-width (เช่น U+202E) ทิ้ง', () => {
    expect(normalizeJobTitleText('ช่าง\u0000ไฟฟ้า\u0007')).toBe('ช่างไฟฟ้า');
    expect(normalizeJobTitleText('\u202Eช่างไฟฟ้า\u202C')).toBe('ช่างไฟฟ้า');
    expect(normalizeJobTitleText('ช่าง\u2066ไฟ\u2069ฟ้า\u200B\uFEFF')).toBe('ช่างไฟฟ้า');
  });

  test('ยาวได้ 255 ตัวอักษร (นับ code point) เกินนั้น -> 422 job-title-too-long โดยไม่มีข้อความใน error', () => {
    expect(validateJobTitleText('ก'.repeat(MAX_LENGTH))).toHaveLength(MAX_LENGTH);
    expect([...validateJobTitleText('😀'.repeat(MAX_LENGTH))]).toHaveLength(MAX_LENGTH); // astral ตัวละ 2 UTF-16 unit แต่ 1 ตัวอักษร
    let err;
    try {
      validateJobTitleText('ก'.repeat(MAX_LENGTH + 1));
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ status: 422, type: 'job-title-too-long', code: 'JOB_TITLE_TOO_LONG' });
    expect(JSON.stringify(err.detail) + err.message).not.toContain('กกกก');
  });

  test.each([
    ['ติดกัน', '1234567890123'],
    ['ขีดแบบบัตรประชาชน', '1-2345-67890-12-3'],
    ['เว้นวรรค', '1 2345 67890 12 3'],
    ['จุดคั่น', '1.2345.67890.12.3'],
    ['ขีดผสมเว้นวรรค', '1234 5678 9012-3'],
    ['เลขไทย', '๑๒๓๔๕๖๗๘๙๐๑๒๓'],
    ['เลขไทยมีขีด', '๑-๒๓๔๕-๖๗๘๙๐-๑๒-๓'],
    ['เลขเต็มความกว้าง', '１２３４５６７８９０１２３'],
    ['ฝังในประโยค', 'ช่างไฟฟ้า เลขบัตร 1-2345-67890-12-3 ประจำอาคาร'],
    ['เป็นส่วนหนึ่งของเลขที่ยาวกว่า', '123456789012345678'],
    ['มีอักขระล่องหนคั่นหลัก', '12345\u200B67890\u202E123'],
    ['มีขึ้นบรรทัดใหม่คั่น (ถูก normalize เป็นเว้นวรรค)', '1234567890\n123'],
  ])('เลขบัตร 13 หลักแบบ %s -> 422 job-title-contains-pid โดยไม่ echo ข้อความ', (_label, text) => {
    let err;
    try {
      validateJobTitleText(text);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ status: 422, type: 'job-title-contains-pid', code: 'JOB_TITLE_CONTAINS_PID' });
    expect(`${err.message}${err.detail}${err.title}`).not.toMatch(/\d{4}/);
  });

  test.each([
    'ช่างไฟฟ้า',
    'พนักงานขับรถยนต์ (ประจำสำนักปลัด)',
    'โทร 081-234-5678',
    'เลขที่ตำแหน่งเดิม 52-1-07-3106-003', // 12 หลัก
    'ปี 2567 ระดับ 3 ตำแหน่ง 12/3',
    '123456789012', // 12 หลัก
    '1234 5678 9012 ก 3', // มีตัวอักษรคั่น
  ])('ข้อความปกติ/ตัวเลขไม่ครบ 13 หลักผ่าน: %s', (text) => {
    expect(looksLikePid(text)).toBe(false);
    expect(validateJobTitleText(text)).toBe(text);
  });

  test('กฎตามประเภท (หน่วย): ตรงสเปกทุกประเภท และไม่แตะตาราง POSITION_RULES ของ PR #34', () => {
    for (const t of REQUIRED_TYPES) expect([t, jobTitleAllowedFor(t)]).toEqual([t, false]);
    for (const t of ALLOWED_TYPES) expect([t, jobTitleAllowedFor(t)]).toEqual([t, true]);
    expect(Object.keys(POSITION_RULES).sort()).toEqual([...ALL_TYPES].sort());
    expect(() => assertJobTitleMatchesPersonnelType('TEACHER', undefined, null)).not.toThrow(); // ไม่มีข้อความ = ไม่ตรวจ
  });
});

describe('ทุกโค้ดใน mdm.personnel_type ต้องมีกฎ jobTitleText (มีประเภทใหม่ -> ต้องตัดสินก่อน)', () => {
  test('ทุกประเภทใน DB อยู่ในสเปก', async () => {
    const { rows } = await adminPool.query(`SELECT code FROM mdm.personnel_type ORDER BY code`);
    expect(rows.map((r) => r.code).filter((c) => !ALL_TYPES.includes(c))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('PUT /persons/{id}/employment - ตารางกฎ 422 ทั้งสองทิศ', () => {
  test.each(REQUIRED_TYPES)('%s + มีตำแหน่ง + ส่ง jobTitleText -> 422 job-title-not-allowed และไม่เขียนอะไร', async (type) => {
    const personId = await makePerson();
    const res = await put(personId, await body(type, { withPosition: true, jobTitleText: 'ช่างทดสอบ' }));
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/job-title-not-allowed$/);
    expect(await rowsOf(personId)).toEqual([]);
  });

  test.each(REQUIRED_TYPES)('%s + มีตำแหน่ง + ไม่ส่งข้อความ -> ผ่านตามเดิม (กฎ PR #34 ไม่เปลี่ยน)', async (type) => {
    const personId = await makePerson();
    const res = await put(personId, await body(type, { withPosition: true }));
    expect(res.status).toBe(200);
    expect(res.body.jobTitleText).toBeUndefined();
  });

  test.each(REQUIRED_TYPES)('%s ไม่มีตำแหน่ง + ส่ง jobTitleText -> 422 position-required (กฎเดิมมาก่อน ข้อความเป็นตัวแทนตำแหน่งไม่ได้)', async (type) => {
    const personId = await makePerson();
    const res = await put(personId, await body(type, { jobTitleText: 'ช่างทดสอบ' }));
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/position-required$/);
  });

  test.each(FORBIDDEN_TYPES)('%s + jobTitleText (ไม่มีตำแหน่ง) -> 200 เก็บข้อความ และ response มี jobTitleText', async (type) => {
    const personId = await makePerson();
    const res = await put(personId, await body(type, { jobTitleText: '  ผู้ช่วยช่างไฟฟ้า  ' }));
    expect(res.status).toBe(200);
    expect(res.body.jobTitleText).toBe('ผู้ช่วยช่างไฟฟ้า');
    expect(res.body.position).toBeUndefined(); // ข้อความไม่ได้ไปอยู่ที่ position
    expect(await rowsOf(personId)).toEqual([expect.objectContaining({ job_title_text: 'ผู้ช่วยช่างไฟฟ้า', is_current: true })]);
  });

  test.each(FORBIDDEN_TYPES)('%s + positionId (ต่อให้มีข้อความหรือไม่) -> 422 position-not-allowed เหมือนเดิม', async (type) => {
    for (const jobTitleText of [undefined, 'ช่างทดสอบ']) {
      const personId = await makePerson();
      // eslint-disable-next-line no-await-in-loop
      const res = await put(personId, await body(type, { withPosition: true, jobTitleText }));
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(/position-not-allowed$/);
    }
  });

  test.each(FORBIDDEN_TYPES)('%s ไม่ใส่ข้อความ -> 200 และไม่มีฟิลด์ jobTitleText ใน response', async (type) => {
    const res = await put(await makePerson(), await body(type));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('jobTitleText');
  });
});

describe('ประเภท OTHER - 4 แบบ', () => {
  test('ไม่ใส่เลย -> 200', async () => {
    const personId = await makePerson();
    expect((await put(personId, await body('OTHER'))).status).toBe(200);
    expect(await rowsOf(personId)).toEqual([expect.objectContaining({ job_title_text: null })]);
  });

  test('ใส่ตำแหน่งอย่างเดียว -> 200 (ตำแหน่งผูก ข้อความว่าง)', async () => {
    const personId = await makePerson();
    const res = await put(personId, await body('OTHER', { withPosition: true }));
    expect(res.status).toBe(200);
    expect(res.body.position).toBeDefined();
    expect(res.body.jobTitleText).toBeUndefined();
  });

  test('ใส่ข้อความอย่างเดียว -> 200 (ไม่มีตำแหน่ง)', async () => {
    const personId = await makePerson();
    const res = await put(personId, await body('OTHER', { jobTitleText: 'อาสาสมัครประจำศูนย์' }));
    expect(res.status).toBe(200);
    expect(res.body.jobTitleText).toBe('อาสาสมัครประจำศูนย์');
    expect(res.body.position).toBeUndefined();
  });

  test('ใส่ทั้งสองอย่าง -> 422 position-and-job-title-conflict และไม่เขียนอะไร', async () => {
    const personId = await makePerson();
    const res = await put(personId, await body('OTHER', { withPosition: true, jobTitleText: 'อาสาสมัครประจำศูนย์' }));
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/position-and-job-title-conflict$/);
    expect(await rowsOf(personId)).toEqual([]);
  });

  test('ข้อความว่างหลัง normalize (เว้นวรรค/bidi ล้วน) ถือว่าไม่ได้ใส่ -> ใส่ตำแหน่งคู่กันได้ ไม่ชน conflict', async () => {
    const res = await put(await makePerson(), await body('OTHER', { withPosition: true, jobTitleText: '  \u202E  ' }));
    expect(res.status).toBe(200);
    expect(res.body.jobTitleText).toBeUndefined();
  });
});

describe('การตรวจข้อความผ่าน HTTP', () => {
  test('มีเลขบัตร 13 หลัก (ติดกัน/มีขีด/เว้นวรรค) -> 422 job-title-contains-pid ไม่ echo เลข ไม่เขียน DB', async () => {
    const pid = makeFakePid();
    const dashed = `${pid.slice(0, 1)}-${pid.slice(1, 5)}-${pid.slice(5, 10)}-${pid.slice(10, 12)}-${pid.slice(12)}`;
    for (const text of [`ช่าง ${pid}`, dashed, dashed.replace(/-/g, ' ')]) {
      const personId = await makePerson();
      // eslint-disable-next-line no-await-in-loop
      const res = await put(personId, await body('CONTRACT_EMPLOYEE', { jobTitleText: text }));
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(/job-title-contains-pid$/);
      expect(JSON.stringify(res.body)).not.toContain(pid);
      expect(JSON.stringify(res.body)).not.toContain(dashed);
      // eslint-disable-next-line no-await-in-loop
      expect(await rowsOf(personId)).toEqual([]);
    }
  });

  test('ยาวเกิน 255 -> ถูกปฏิเสธ (400 จาก OpenAPI maxLength) ไม่เขียน DB', async () => {
    const personId = await makePerson();
    const res = await put(personId, await body('CONTRACT_EMPLOYEE', { jobTitleText: 'ก'.repeat(256) }));
    expect(res.status).toBe(400);
    expect(await rowsOf(personId)).toEqual([]);
  });

  test('ยาวเกิน 255 เฉพาะเพราะมี control/bidi ใน 255 ตัวแรก: ผ่าน OpenAPI แต่หลัง normalize ต้องไม่เกิน 255 -> บันทึกได้', async () => {
    const personId = await makePerson();
    const res = await put(personId, await body('CONTRACT_EMPLOYEE', { jobTitleText: `${'ก'.repeat(250)}\u202E\u202E` }));
    expect(res.status).toBe(200);
    expect(res.body.jobTitleText).toBe('ก'.repeat(250));
  });

  test('ตัด control/bidi + รวมบรรทัดก่อนบันทึกจริง', async () => {
    const personId = await makePerson();
    const res = await put(personId, await body('GENERAL_EMPLOYEE', { jobTitleText: '\u202Eช่างไฟ\r\nฟ้า\u0000' }));
    expect(res.status).toBe(200);
    expect(res.body.jobTitleText).toBe('ช่างไฟ ฟ้า');
    expect((await rowsOf(personId))[0].job_title_text).toBe('ช่างไฟ ฟ้า');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('history / change log / outbox: แก้เฉพาะข้อความ -> ปิดแถวเก่า เปิดแถวใหม่', () => {
  test('แก้เฉพาะข้อความ: เกิดแถวใหม่ (แถวเก่าคงค่าเดิม) + data_change_log + outbox โดย payload ไม่มีข้อความ', async () => {
    const personId = await makePerson();
    const employeeNo = `EMP-JT-${crypto.randomUUID()}`;
    const OLD = 'ช่างไฟฟ้า-ค่าเดิม-XYZ';
    const NEW = 'ช่างประปา-ค่าใหม่-XYZ';
    expect((await put(personId, await body('CONTRACT_EMPLOYEE', { employeeNo, jobTitleText: OLD }))).status).toBe(200);
    const res = await put(personId, await body('CONTRACT_EMPLOYEE', { employeeNo, jobTitleText: NEW, effectiveFrom: '2025-01-01' }));
    expect(res.status).toBe(200);
    expect(res.body.jobTitleText).toBe(NEW);

    const rows = await rowsOf(personId);
    expect(rows).toEqual([
      { job_title_text: OLD, is_current: false, effective_from: '2024-01-01' },
      { job_title_text: NEW, is_current: true, effective_from: '2025-01-01' },
    ]);

    const { rows: log } = await adminPool.query(
      `SELECT field_name, old_value, new_value, changed_by FROM audit.data_change_log WHERE person_id = $1 AND table_name = 'employment' ORDER BY log_id DESC`,
      [personId]
    );
    // แก้เฉพาะข้อความ -> เปลี่ยนฟิลด์เดียว (แถวล่าสุดของ log)
    expect(log[0]).toMatchObject({ field_name: 'employment.job_title_text', old_value: OLD, new_value: NEW, changed_by: 'HR' });
    expect(log.filter((r) => r.field_name === 'employment.job_title_text')).toHaveLength(2); // ตอนตั้งค่าแรก (null -> OLD) + ตอนแก้

    const { rows: outbox } = await adminPool.query(
      `SELECT event_type, changed_fields, payload::text AS payload FROM integration.outbox_event WHERE person_id = $1 ORDER BY sequence DESC`,
      [personId]
    );
    expect(outbox[0].event_type).toBe('EMPLOYMENT_UPDATED');
    expect(outbox[0].changed_fields).toEqual(['employment.job_title_text']);
    for (const ev of outbox) {
      expect(JSON.stringify(ev)).not.toContain('XYZ'); // ไม่มีข้อความอิสระใน payload/changed_fields ของ outbox
    }

    // GET /events feed ก็ต้องไม่มีข้อความ
    const events = await get('/events?limit=200', 'events:read');
    expect(events.status).toBe(200);
    expect(events.text).not.toContain('XYZ');
  });

  test('ส่งข้อความเดิมซ้ำ (รวมกรณีต่างกันแค่ช่องว่าง/bidi ที่ normalize แล้วเท่ากัน) -> ไม่เกิดแถวใหม่/ไม่มี log เพิ่ม', async () => {
    const personId = await makePerson();
    const employeeNo = `EMP-JT-${crypto.randomUUID()}`;
    await put(personId, await body('GENERAL_EMPLOYEE', { employeeNo, jobTitleText: 'พนักงานขับรถ' }));
    const before = (await adminPool.query(`SELECT count(*)::int AS n FROM audit.data_change_log WHERE person_id = $1`, [personId])).rows[0].n;
    for (const same of ['พนักงานขับรถ', '  พนักงานขับรถ  ', '\u202Eพนักงานขับรถ']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await put(personId, await body('GENERAL_EMPLOYEE', { employeeNo, jobTitleText: same, effectiveFrom: '2025-06-01' }));
      expect(res.status).toBe(200);
    }
    expect(await rowsOf(personId)).toHaveLength(1);
    expect((await adminPool.query(`SELECT count(*)::int AS n FROM audit.data_change_log WHERE person_id = $1`, [personId])).rows[0].n).toBe(before);
  });

  test('ลบข้อความ (ไม่ส่งมา) -> แถวใหม่ที่ job_title_text เป็น NULL + log ค่าใหม่ null', async () => {
    const personId = await makePerson();
    const employeeNo = `EMP-JT-${crypto.randomUUID()}`;
    await put(personId, await body('GENERAL_EMPLOYEE', { employeeNo, jobTitleText: 'พนักงานขับรถ' }));
    const res = await put(personId, await body('GENERAL_EMPLOYEE', { employeeNo, effectiveFrom: '2025-01-01' }));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('jobTitleText');
    expect((await rowsOf(personId)).map((r) => r.job_title_text)).toEqual(['พนักงานขับรถ', null]);
    const { rows } = await adminPool.query(
      `SELECT old_value, new_value FROM audit.data_change_log WHERE person_id = $1 AND field_name = 'employment.job_title_text' ORDER BY log_id DESC LIMIT 1`,
      [personId]
    );
    expect(rows[0]).toEqual({ old_value: 'พนักงานขับรถ', new_value: null });
  });

  test('ย้ายจากประเภทห้ามมีตำแหน่ง (มีข้อความ) เป็นข้าราชการ + ตำแหน่ง โดยลืมล้างข้อความ -> 422 และแถวเดิมไม่ถูกปิด', async () => {
    const personId = await makePerson();
    const employeeNo = `EMP-JT-${crypto.randomUUID()}`;
    await put(personId, await body('GENERAL_EMPLOYEE', { employeeNo, jobTitleText: 'พนักงานขับรถ' }));
    const res = await put(personId, await body('CIVIL_SERVANT', { employeeNo, withPosition: true, jobTitleText: 'พนักงานขับรถ', effectiveFrom: '2025-01-01' }));
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/job-title-not-allowed$/);
    expect(await rowsOf(personId)).toEqual([expect.objectContaining({ job_title_text: 'พนักงานขับรถ', is_current: true })]);
  });
});

describe('การอ่าน: ฟิลด์แยก ไม่แทน positionTitle และไม่อยู่ใน token claims', () => {
  test('GET /persons/{id}: basic.jobTitleText (read:basic), employment.jobTitleText (read:employment) และ basic.positionTitle ยังว่าง', async () => {
    const personId = await makePerson();
    await put(personId, await body('OUTSOURCE_INDIVIDUAL', { jobTitleText: 'ผู้ช่วยนักวิชาการ' }));

    const basicOnly = await get(`/persons/${personId}`, 'personnel:read:basic');
    expect(basicOnly.status).toBe(200);
    expect(basicOnly.body.basic.jobTitleText).toBe('ผู้ช่วยนักวิชาการ');
    expect(basicOnly.body.basic).not.toHaveProperty('positionTitle'); // ไม่ถูกเอาไปแทน
    expect(basicOnly.body).not.toHaveProperty('employment'); // ต้องมี personnel:read:employment

    const withEmployment = await get(`/persons/${personId}`, 'personnel:read:basic personnel:read:employment');
    expect(withEmployment.body.employment.jobTitleText).toBe('ผู้ช่วยนักวิชาการ');
    expect(withEmployment.body.employment).not.toHaveProperty('position');

    const history = await get(`/persons/${personId}/employment`, 'personnel:read:employment personnel:read:basic');
    expect(history.status).toBe(200);
    expect(history.body[0].jobTitleText).toBe('ผู้ช่วยนักวิชาการ');
  });

  test('ผู้เรียกที่ไม่มี personnel:read:basic ไม่เห็น jobTitleText (x-required-scope) แม้มี read:employment', async () => {
    const personId = await makePerson();
    await put(personId, await body('OUTSOURCE_INDIVIDUAL', { jobTitleText: 'ผู้ช่วยนักวิชาการ' }));
    const noBasic = await (await api('put', `/persons/${personId}/employment`, 'personnel:write:employment')).send(
      await body('OUTSOURCE_INDIVIDUAL', { jobTitleText: 'ผู้ช่วยนักวิชาการ' })
    );
    expect(noBasic.status).toBe(200);
    expect(noBasic.body).not.toHaveProperty('jobTitleText');
    const history = await get(`/persons/${personId}/employment`, 'personnel:read:employment');
    expect(history.status).toBe(200);
    expect(history.body[0]).not.toHaveProperty('jobTitleText');
  });

  test('ไม่มีข้อความ -> ไม่มีฟิลด์ (ไม่ใช่ null)', async () => {
    const personId = await makePerson();
    await put(personId, await body('CONTRACT_EMPLOYEE'));
    const res = await get(`/persons/${personId}`, 'personnel:read:basic personnel:read:employment');
    expect(res.body.basic).not.toHaveProperty('jobTitleText');
    expect(res.body.employment).not.toHaveProperty('jobTitleText');
  });

  test('syncService (token claims) ไม่อ่านคอลัมน์ job_title_text', () => {
    const src = require('node:fs').readFileSync(require.resolve('../src/services/syncService'), 'utf8');
    expect(src).not.toMatch(/job_title_text|jobTitleText/);
  });

  test('field_policy มีแถว employment.job_title_text (HR, INTERNAL, personnel:read:basic, editable_by HR)', async () => {
    const { rows } = await adminPool.query(`SELECT * FROM mdm.field_policy WHERE field_key = 'employment.job_title_text'`);
    expect(rows).toEqual([
      expect.objectContaining({ table_name: 'employment', column_name: 'job_title_text', source: 'HR', classification: 'INTERNAL', required_scope: 'personnel:read:basic', editable_by: 'HR', log_values_in_audit: true }),
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('ทุกทางเขียน employment ใช้กฎเดียวกัน', () => {
  describe('POST /persons (provision)', () => {
    const provision = async (personnelType, opts) => {
      const pid = makeFakePid();
      const res = await (await api('post', '/persons', 'personnel:read:basic personnel:provision')).send({
        pid,
        expectedFirstNameTh: 'ทดสอบ',
        expectedLastNameTh: 'ข้อความตำแหน่ง',
        employment: await body(personnelType, opts),
      });
      const { rows } = await adminPool.query(`SELECT person_id FROM mdm.person WHERE pid_hash = $1`, [pidHash(pid, pepper)]);
      return { res, rows };
    };

    test('พนักงานจ้าง + ข้อความ -> 201 และเก็บข้อความ', async () => {
      const { res, rows } = await provision('CONTRACT_EMPLOYEE', { jobTitleText: 'พนักงานธุรการ' });
      expect(res.status).toBe(201);
      expect(rows).toHaveLength(1);
      expect((await rowsOf(rows[0].person_id))[0].job_title_text).toBe('พนักงานธุรการ');
    });

    test.each([
      ['TEACHER + ตำแหน่ง + ข้อความ', 'TEACHER', { withPosition: true, jobTitleText: 'ครู' }, /job-title-not-allowed$/],
      ['OTHER + ตำแหน่ง + ข้อความ', 'OTHER', { withPosition: true, jobTitleText: 'อาสา' }, /position-and-job-title-conflict$/],
      ['จ้างเหมา + เลขบัตรในข้อความ', 'OUTSOURCE_INDIVIDUAL', { jobTitleText: '1-2345-67890-12-3' }, /job-title-contains-pid$/],
    ])('%s -> 422 และไม่สร้าง person ค้าง (rollback)', async (_l, type, opts, typeRe) => {
      const { res, rows } = await provision(type, opts);
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(typeRe);
      expect(rows).toHaveLength(0);
    });
  });

  describe('POST /claim-requests/{id}/resolve (PROVISION)', () => {
    async function makeClaim() {
      const { rows } = await adminPool.query(
        `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
         VALUES ($1, 'นายทดสอบ ข้อความตำแหน่ง', 'PENDING_HR', 1, now(), now()) RETURNING claim_request_id`,
        [crypto.randomBytes(32).toString('hex')]
      );
      return rows[0].claim_request_id;
    }
    const resolve = async (claimId, type, opts) => {
      const employment = await body(type, opts);
      await bindClaimToEmployeeNo(adminPool, pepper, claimId, employment.employeeNo);
      return (await api('post', `/claim-requests/${claimId}/resolve`, 'personnel:provision')).send({ action: 'PROVISION', employment });
    };
    const status = async (id) => (await adminPool.query(`SELECT status FROM mdm.claim_request WHERE claim_request_id = $1`, [id])).rows[0].status;

    test('พนักงานจ้าง/OTHER + ข้อความ -> 200', async () => {
      expect((await resolve(await makeClaim(), 'GENERAL_EMPLOYEE', { jobTitleText: 'พนักงานทั่วไป' })).status).toBe(200);
      expect((await resolve(await makeClaim(), 'OTHER', { jobTitleText: 'อื่นๆ' })).status).toBe(200);
    });

    test.each([
      ['ข้าราชการ + ตำแหน่ง + ข้อความ', 'CIVIL_SERVANT', { withPosition: true, jobTitleText: 'x' }, /job-title-not-allowed$/],
      ['OTHER ทั้งคู่', 'OTHER', { withPosition: true, jobTitleText: 'x' }, /position-and-job-title-conflict$/],
      ['เลขบัตรในข้อความ', 'CONTRACT_EMPLOYEE', { jobTitleText: '1234567890123' }, /job-title-contains-pid$/],
    ])('%s -> 422 และ claim ยังรอ HR', async (_l, type, opts, typeRe) => {
      const claimId = await makeClaim();
      const res = await resolve(claimId, type, opts);
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(typeRe);
      expect(await status(claimId)).toBe('PENDING_HR');
    });
  });

  describe('POST /persons/{id}/reactivate', () => {
    const reactivate = async (personId, type, opts) =>
      (await api('post', `/persons/${personId}/reactivate`, 'personnel:read:basic personnel:write:employment')).send(await body(type, opts));

    test('ถูกกฎ -> 200 และเก็บข้อความ', async () => {
      const personId = await makePerson('INACTIVE');
      const res = await reactivate(personId, 'EXPERT_EMPLOYEE', { jobTitleText: 'ที่ปรึกษาด้านสารสนเทศ' });
      expect(res.status).toBe(200);
      expect((await rowsOf(personId))[0].job_title_text).toBe('ที่ปรึกษาด้านสารสนเทศ');
    });

    test.each([
      ['ข้าราชการ + ข้อความ', 'CIVIL_SERVANT', { withPosition: true, jobTitleText: 'x' }, /job-title-not-allowed$/],
      ['OTHER ทั้งคู่', 'OTHER', { withPosition: true, jobTitleText: 'x' }, /position-and-job-title-conflict$/],
      ['เลขบัตรในข้อความ', 'POLITICAL_APPOINTEE', { jobTitleText: '๑๒๓๔๕๖๗๘๙๐๑๒๓' }, /job-title-contains-pid$/],
    ])('%s -> 422 และบุคคลยัง INACTIVE', async (_l, type, opts, typeRe) => {
      const personId = await makePerson('INACTIVE');
      const res = await reactivate(personId, type, opts);
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(typeRe);
      expect((await adminPool.query(`SELECT status FROM mdm.person WHERE person_id = $1`, [personId])).rows[0].status).toBe('INACTIVE');
    });
  });

  describe('POST /sync/hr/employment-batch', () => {
    const mk = async (rowRef, type, opts) => ({
      rowRef,
      pid: makeFakePid(),
      expectedFirstNameTh: 'ทดสอบ',
      expectedLastNameTh: 'นำเข้า',
      employment: await body(type, opts),
    });

    test('DRY_RUN: error รายแถวด้วยรหัสของกฎใหม่ ส่วนแถวถูกกฎนับปกติ', async () => {
      const res = await (await api('post', '/sync/hr/employment-batch', 'personnel:import')).send({
        mode: 'DRY_RUN',
        createIfMissing: true,
        rows: [
          await mk('bad-required', 'TEACHER', { withPosition: true, jobTitleText: 'x' }),
          await mk('bad-conflict', 'OTHER', { withPosition: true, jobTitleText: 'x' }),
          await mk('bad-pid', 'CONTRACT_EMPLOYEE', { jobTitleText: 'เลข 1-2345-67890-12-3' }),
          await mk('ok-forbidden', 'GENERAL_EMPLOYEE', { jobTitleText: 'พนักงานทั่วไป' }),
          await mk('ok-other', 'OTHER', { jobTitleText: 'อื่นๆ' }),
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.errors.map((e) => [e.rowRef, e.code]).sort()).toEqual([
        ['bad-conflict', 'POSITION_AND_JOB_TITLE_CONFLICT'],
        ['bad-pid', 'JOB_TITLE_CONTAINS_PID'],
        ['bad-required', 'JOB_TITLE_NOT_ALLOWED'],
      ]);
      expect(res.body.created).toBe(2);
      expect(JSON.stringify(res.body)).not.toContain('1-2345-67890-12-3'); // error ต้องไม่ echo ข้อความ
    });

    test('APPLY: แถวที่ถูกกฎบันทึกข้อความจริง', async () => {
      const row = await mk('apply-ok', 'GENERAL_EMPLOYEE', { jobTitleText: '  พนักงานทั่วไป\r\nประจำอาคาร ' });
      const res = await (await api('post', '/sync/hr/employment-batch', 'personnel:import')).send({ mode: 'APPLY', createIfMissing: true, rows: [row] });
      expect(res.status).toBe(200);
      expect(res.body.errors).toEqual([]);
      const { rows } = await adminPool.query(`SELECT job_title_text FROM mdm.employment WHERE employee_no = $1`, [row.employment.employeeNo]);
      expect(rows).toEqual([{ job_title_text: 'พนักงานทั่วไป ประจำอาคาร' }]);
    });
  });
});
