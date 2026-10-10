const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { makeFakePid } = require('../src/security/pid');
const { insertFixtureOrgUnit } = require('./fixtures');
const { validateEmail, validateMobile, validatePhoneAlt } = require('../src/security/contactValidation');

// ตัวตรวจอีเมล/เบอร์โทรของข้อมูลติดต่อ (หน้าแก้ไขข้อมูลติดต่อของ portal/hr-console) + การเลิกเก็บ houseNo/fullText ข้อมูลทั้งหมดสมมติ

describe('สำเนาของ contactValidation.js ในแต่ละ workspace ต้องเหมือนกัน', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  test('contactValidation.js: api = portal = hr-console', () => {
    const apiCopy = read('api/src/security/contactValidation.js');
    expect(read('portal/src/contactValidation.js')).toBe(apiCopy);
    expect(read('hr-console/src/contactValidation.js')).toBe(apiCopy);
  });

  test.each(['emailCheck.js', 'contactFormUi.js'])('%s: portal = hr-console', (file) => {
    expect(read(`hr-console/src/${file}`)).toBe(read(`portal/src/${file}`));
  });
});

describe('validateEmail', () => {
  const okCases = [
    ['somchai@example.com', 'somchai@example.com'],
    ['  somchai@example.com  ', 'somchai@example.com'],
    ['a.b+tag@sub.example.co.th', 'a.b+tag@sub.example.co.th'],
    ["o'brien@example.org", "o'brien@example.org"],
    ['x@a-b.example.com', 'x@a-b.example.com'],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
  ];
  test.each(okCases)('ผ่าน: %j', (input, value) => {
    expect(validateEmail(input)).toEqual({ ok: true, value });
  });

  const badCases = [
    ['ไม่มี @', 'somchai.example.com'],
    ['@ สองตัว', 'a@b@example.com'],
    ['ไม่มีส่วนหน้า @', '@example.com'],
    ['ช่องว่างกลาง', 'som chai@example.com'],
    ['โดเมนไม่มีจุด', 'somchai@localhost'],
    ['โดเมนขึ้นต้นด้วยจุด', 'a@.example.com'],
    ['โดเมนลงท้ายด้วยจุด', 'a@example.com.'],
    ['จุดซ้อน', 'a@example..com'],
    ['label ขึ้นต้นด้วย -', 'a@-example.com'],
    ['label ลงท้ายด้วย -', 'a@example-.com'],
    ['local ขึ้นต้นด้วยจุด', '.a@example.com'],
    ['local ลงท้ายด้วยจุด', 'a.@example.com'],
    ['IPv4 เป็นโดเมน', 'a@192.168.0.1'],
    ['IP literal', 'a@[192.168.0.1]'],
    ['TLD ตัวเดียว', 'a@example.c'],
    ['ตัวอักษรไทยในโดเมน', 'a@ตัวอย่าง.com'],
    ['local ยาวเกิน 64', `${'a'.repeat(65)}@example.com`],
    ['ยาวเกิน 254', `${'a'.repeat(60)}@${`${'b'.repeat(60)}.`.repeat(4)}com`],
  ];
  test.each(badCases)('ไม่ผ่าน: %s', (_name, input) => {
    const result = validateEmail(input);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/[ก-๙]/); // ข้อความไทย
  });

  test('ยาว 254 พอดีผ่าน / 255 ไม่ผ่าน', () => {
    const make = (x) => `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(x)}.com`;
    expect(make(57)).toHaveLength(254);
    expect(validateEmail(make(57)).ok).toBe(true);
    expect(make(58)).toHaveLength(255);
    expect(validateEmail(make(58))).toMatchObject({ ok: false, message: 'อีเมลยาวเกิน 254 ตัวอักษร' });
  });

  test('ข้อความผิดพลาดไม่สะท้อนค่าที่กรอกกลับ', () => {
    const result = validateEmail('zz-sentinel-value@bad_domain');
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('sentinel');
  });
});

describe('validateMobile (มือถือ)', () => {
  test.each([
    ['0812345678', '0812345678'],
    ['081-234-5678', '0812345678'],
    ['081 234 5678', '0812345678'],
    ['(081) 234.5678', '0812345678'],
    ['+66812345678', '0812345678'],
    ['+66 81 234 5678', '0812345678'],
    ['66812345678', '0812345678'],
    ['0612345678', '0612345678'],
    ['0912345678', '0912345678'],
    ['', null],
    [null, null],
  ])('ผ่าน: %j', (input, value) => {
    expect(validateMobile(input)).toEqual({ ok: true, value });
  });

  test.each([
    ['0712345678', 'ขึ้นต้น 07'],
    ['0112345678', 'ขึ้นต้น 01'],
    ['081234567', '9 หลัก'],
    ['08123456789', '11 หลัก'],
    ['812345678', 'ไม่มี 0 นำหน้า'],
    ['08123abc78', 'มีตัวอักษร'],
    ['+6612345', 'สั้นเกิน'],
    ['+668123456789', 'ยาวเกิน'],
    ['021234567', 'โทรศัพท์บ้านใช้เป็นมือถือไม่ได้'],
    ['0812345678 ต่อ 12', 'มีต่อ'],
  ])('ไม่ผ่าน: %s (%s)', (input) => {
    const result = validateMobile(input);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('06, 08 หรือ 09');
  });
});

describe('validatePhoneAlt (โทรศัพท์สำรอง)', () => {
  test.each([
    ['0812345678', '0812345678'],
    ['+66 81 234 5678', '0812345678'],
    ['021234567', '021234567'],
    ['(02) 123-4567', '021234567'],
    ['+66 2 123 4567', '021234567'],
    ['054-123-456', '054123456'],
    ['032123456', '032123456'],
    ['042123456', '042123456'],
    ['072123456', '072123456'],
    ['', null],
  ])('ผ่าน: %j', (input, value) => {
    expect(validatePhoneAlt(input)).toEqual({ ok: true, value });
  });

  test.each([
    ['0112345678', 'ขึ้นต้น 01'],
    ['062123456', '9 หลักแต่ขึ้นต้น 06 (มือถือต้อง 10 หลัก)'],
    ['02123456', '8 หลัก'],
    ['0212345678', '10 หลักขึ้นต้น 02'],
    ['012345678', 'ขึ้นต้น 01'],
    ['02-123-45xy', 'มีตัวอักษร'],
  ])('ไม่ผ่าน: %s (%s)', (input) => {
    const result = validatePhoneAlt(input);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('02, 03, 04, 05 หรือ 07');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- ผ่าน API จริง

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
const mgr = () => ({ scope: 'personnel:manage:person personnel:read:inactive', sub: `hr-${crypto.randomUUID()}`, azp: 'hr-console', roles: [ROLE] });

async function call(method, urlPath, auth, body) {
  const token = await ctx.auth.signToken(auth);
  let req = request(ctx.app)[method](`/api/v1${urlPath}`).set('Authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body);
  return req;
}

async function provision() {
  const pid = makeFakePid();
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id) VALUES ($1, 'ตำแหน่งทดสอบ contact', 'GENERAL', $2) RETURNING position_id`,
    [`POS-CV-${crypto.randomUUID()}`, orgUnitId]
  );
  const res = await call('post', '/persons', { scope: 'personnel:provision personnel:read:basic', sub: `hr-${crypto.randomUUID()}`, azp: 'hr-console', roles: [ROLE] }, {
    pid,
    expectedFirstNameTh: 'สมชาย',
    expectedLastNameTh: 'ทดสอบ',
    reason: 'เพิ่มบุคลากรใหม่ตามคำสั่งบรรจุ',
    employment: { employeeNo: pid, personnelType: 'CIVIL_SERVANT', positionId: rows[0].position_id, orgUnitId, effectiveFrom: '2024-01-01' },
  });
  expect(res.status).toBe(201);
  return { personId: res.body.personId, version: res.body.version };
}

const patch = (personId, version, body) => call('patch', `/persons/${personId}/contact`, mgr(), { expectedVersion: version, reason: 'ทดสอบตรวจรูปแบบ', ...body });
const put = (personId, body) => call('put', '/me/contact', { scope: 'personnel:self', sub: 'service-account-mdm-portal', azp: 'mdm-portal', personId }, body);
const contactRow = async (personId) => (await adminPool.query(`SELECT * FROM mdm.person_contact WHERE person_id = $1`, [personId])).rows[0];
const versionOf = async (personId) => (await adminPool.query(`SELECT version FROM mdm.person WHERE person_id = $1`, [personId])).rows[0].version;
const contactLogs = async (personId) =>
  (await adminPool.query(`SELECT field_name FROM audit.data_change_log WHERE person_id = $1 AND table_name = 'person_contact' ORDER BY log_id`, [personId])).rows.map((r) => r.field_name);

describe.each([
  ['PATCH /persons/{id}/contact (HR)', async (personId, version, body) => patch(personId, version, body)],
  ['PUT /me/contact (เจ้าตัว)', async (personId, _version, body) => put(personId, body)],
])('%s: ตรวจรูปแบบที่ API', (_name, send) => {
  test('ไม่ผ่าน -> 422 invalid-contact พร้อม errors[{field, message}] ภาษาไทย, ไม่เขียนอะไร, ไม่สะท้อนค่ากลับ', async () => {
    const { personId, version } = await provision();
    const secret = 'secret.person@bad_domain';
    const res = await send(personId, version, { mobilePhone: '0712345678', phoneAlt: '02-12', emailPersonal: secret });

    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/invalid-contact/);
    expect(res.body.errors.map((e) => e.field).sort()).toEqual(['emailPersonal', 'mobilePhone', 'phoneAlt']);
    for (const e of res.body.errors) expect(e.message).toMatch(/[ก-๙]/);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(JSON.stringify(res.body)).not.toContain('0712345678');
    expect(await contactRow(personId)).toBeUndefined();
    expect(await versionOf(personId)).toBe(version);
  });

  test('ผ่าน: เบอร์เก็บเป็นตัวเลขล้วน (+66/66 -> 0, ลบช่องว่าง/ขีด), อีเมล trim', async () => {
    const { personId, version } = await provision();
    const res = await send(personId, version, { mobilePhone: '+66 81-234-5678', phoneAlt: '(02) 123-4567', emailPersonal: '  Somchai@Example.com ' });

    expect(res.status).toBe(200);
    const row = await contactRow(personId);
    expect([row.mobile_phone, row.phone_alt, row.email_personal]).toEqual(['0812345678', '021234567', 'Somchai@Example.com']);
  });

  test('ค่าว่าง/ช่องว่างล้วน = ล้างค่า (null) ไม่ถูกบังคับ', async () => {
    const { personId, version } = await provision();
    const first = await send(personId, version, { mobilePhone: '0812345678', emailPersonal: 'a@example.com' });
    expect(first.status).toBe(200);
    const res = await send(personId, first.body.version ?? (await versionOf(personId)), { mobilePhone: '  ', phoneAlt: '', emailPersonal: '' });
    expect(res.status).toBe(200);
    const row = await contactRow(personId);
    expect([row.mobile_phone, row.phone_alt, row.email_personal]).toEqual([null, null, null]);
  });

  test('ค่าเดิมที่ไม่ผ่านกติกาใหม่ แต่ไม่ได้แก้ (ส่งค่าเดิมกลับมา) -> ไม่ถูกบังคับแก้ ค่าเดิมคงอยู่; เปลี่ยนเป็นค่าที่ไม่ผ่าน -> 422', async () => {
    const { personId, version } = await provision();
    await adminPool.query(
      `INSERT INTO mdm.person_contact (person_id, mobile_phone, email_personal, updated_by, updated_at) VALUES ($1, '081-234-567', 'legacy@localhost', 'HR', now())`,
      [personId]
    );
    const unchanged = await send(personId, version, { mobilePhone: '081-234-567', emailPersonal: 'legacy@localhost', lineId: 'newline' });
    expect(unchanged.status).toBe(200);
    const row = await contactRow(personId);
    expect([row.mobile_phone, row.email_personal, row.line_id]).toEqual(['081-234-567', 'legacy@localhost', 'newline']);

    const changed = await send(personId, await versionOf(personId), { mobilePhone: '081-234-566' });
    expect(changed.status).toBe(422);
  });
});

describe('เลิกเก็บ houseNo / fullText ของที่อยู่ปัจจุบัน', () => {
  test.each([
    ['houseNo', { houseNo: '99/1' }],
    ['fullText', { fullText: 'ที่อยู่ทดสอบ' }],
  ])('PATCH และ PUT ไม่รับ currentAddress.%s (400) และไม่เขียน', async (_field, address) => {
    const { personId, version } = await provision();
    const viaPatch = await patch(personId, version, { currentAddress: address });
    expect(viaPatch.status).toBe(400);
    const viaPut = await put(personId, { mobilePhone: '0812345678', currentAddress: address });
    expect(viaPut.status).toBe(400);
    expect(await contactRow(personId)).toBeUndefined();
    expect(await versionOf(personId)).toBe(version);
  });

  test('ช่องที่อยู่อื่น (moo/soi/road/postcode/รหัสพื้นที่) และ sameAsRegistered ยังรับตามเดิม', async () => {
    const { personId, version } = await provision();
    const res = await patch(personId, version, {
      sameAsRegistered: false,
      currentAddress: { moo: '3', soi: 'ซอย 5', road: 'ถนนทดสอบ', postcode: '52000', subdistrict: { code: '520101' } },
    });
    expect(res.status).toBe(200);
  });

  test('PUT /me/contact ไม่ล้างค่าเดิมของ houseNo/fullText ที่เก็บไว้ และไม่บันทึกว่าเปลี่ยน', async () => {
    const { personId } = await provision();
    await adminPool.query(
      `INSERT INTO mdm.person_contact (person_id, cur_house_no, cur_address_text, updated_by, updated_at) VALUES ($1, '99/1', 'ที่อยู่เดิมที่เก็บไว้', 'HR', now())`,
      [personId]
    );
    const res = await put(personId, { mobilePhone: '0812345678' });
    expect(res.status).toBe(200);

    const row = await contactRow(personId);
    expect([row.cur_house_no, row.cur_address_text]).toEqual(['99/1', 'ที่อยู่เดิมที่เก็บไว้']);
    expect(row.mobile_phone).toBe('0812345678');
    expect(await contactLogs(personId)).toEqual(['contact.mobile_phone']);
  });

  test('PATCH ของ HR ไม่แตะ houseNo/fullText ที่เก็บไว้', async () => {
    const { personId, version } = await provision();
    await adminPool.query(
      `INSERT INTO mdm.person_contact (person_id, cur_house_no, cur_address_text, updated_by, updated_at) VALUES ($1, '12/3', 'ที่อยู่เดิม', 'HR', now())`,
      [personId]
    );
    const res = await patch(personId, version, { lineId: 'hr.line', currentAddress: { road: 'ถนนใหม่' } });
    expect(res.status).toBe(200);
    const row = await contactRow(personId);
    expect([row.cur_house_no, row.cur_address_text, row.cur_road]).toEqual(['12/3', 'ที่อยู่เดิม', 'ถนนใหม่']);
  });
});
