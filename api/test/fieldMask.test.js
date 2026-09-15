const request = require('supertest');
const { maskBySchema } = require('../src/security/fieldMask');
const { buildTestApp } = require('./testApp');
const { FIXTURE_PERSON_ID } = require('../src/constants');

describe('maskBySchema (หน่วย, ไม่พึ่ง DB/Express)', () => {
  test('ตัดทั้ง group ออกเมื่อไม่มี scope ที่ x-required-scope ระบุ ไม่ใส่ null', () => {
    const schema = {
      type: 'object',
      properties: {
        personId: { type: 'string' },
        identity: {
          type: 'object',
          'x-required-scope': 'personnel:read:identity',
          properties: { birthDate: { type: 'string' } },
        },
      },
    };
    const data = { personId: 'x', identity: { birthDate: '1990-01-01' } };

    const result = maskBySchema(schema, data, []);

    expect(result).toEqual({ personId: 'x' });
    expect(Object.prototype.hasOwnProperty.call(result, 'identity')).toBe(false);
  });

  test('คงฟิลด์ไว้เมื่อ scope ตรงตามที่กำหนด', () => {
    const schema = {
      type: 'object',
      properties: {
        identity: {
          type: 'object',
          'x-required-scope': 'personnel:read:identity',
          properties: { birthDate: { type: 'string' } },
        },
      },
    };
    const data = { identity: { birthDate: '1990-01-01' } };

    const result = maskBySchema(schema, data, ['personnel:read:identity']);

    expect(result.identity.birthDate).toBe('1990-01-01');
  });

  test('เดินเข้า array items ได้ถูกต้อง', () => {
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: { contact: { type: 'object', 'x-required-scope': 'personnel:read:contact', properties: {} } },
      },
    };
    const data = [{ contact: {} }, { contact: {} }];

    const result = maskBySchema(schema, data, []);

    expect(result).toEqual([{}, {}]);
  });
});

describe('GET /persons/{personId} - field mask ตาม scope จริงผ่าน HTTP (§2.2 ข้อ 2-3)', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await buildTestApp();
  });

  afterAll(async () => {
    await ctx.pool.end();
  });

  test('มีเฉพาะ personnel:read:basic -> ไม่มี identity/contact/emergencyContacts/employment', async () => {
    const token = await ctx.auth.signToken({ scope: 'personnel:read:basic' });
    const res = await request(ctx.app)
      .get(`/api/v1/persons/${FIXTURE_PERSON_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.basic).toBeDefined();
    expect(res.body.verification).toBeDefined();
    expect(res.body.identity).toBeUndefined();
    expect(res.body.contact).toBeUndefined();
    expect(res.body.emergencyContacts).toBeUndefined();
    expect(res.body.employment).toBeUndefined();
  });

  test('เพิ่ม personnel:read:identity -> เห็น identity อย่างเดียว ไม่เห็น contact', async () => {
    const token = await ctx.auth.signToken({ scope: 'personnel:read:basic personnel:read:identity' });
    const res = await request(ctx.app)
      .get(`/api/v1/persons/${FIXTURE_PERSON_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.identity).toBeDefined();
    expect(res.body.identity.birthDate).toBe('1990-01-01');
    expect(res.body.contact).toBeUndefined();
    expect(res.body.employment).toBeUndefined();
  });

  test('มีครบทุก scope -> เห็นทุก group', async () => {
    const token = await ctx.auth.signToken({
      scope:
        'personnel:read:basic personnel:read:identity personnel:read:contact personnel:read:employment',
    });
    const res = await request(ctx.app)
      .get(`/api/v1/persons/${FIXTURE_PERSON_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.identity).toBeDefined();
    expect(res.body.contact).toBeDefined();
    expect(res.body.emergencyContacts).toBeDefined();
    expect(res.body.employment).toBeDefined();
  });

  test('เขียน audit.access_log พร้อม fields_returned ที่ตรงกับข้อมูลหลังกรอง (hard rule #6)', async () => {
    const token = await ctx.auth.signToken({ scope: 'personnel:read:basic' });
    await request(ctx.app).get(`/api/v1/persons/${FIXTURE_PERSON_ID}`).set('Authorization', `Bearer ${token}`);

    const { rows } = await ctx.pool.query(
      `SELECT fields_returned FROM audit.access_log
       WHERE subject_person_id = $1 ORDER BY accessed_at DESC LIMIT 1`,
      [FIXTURE_PERSON_ID]
    );

    expect(rows).toHaveLength(1);
    const fields = rows[0].fields_returned;
    expect(fields).toEqual(expect.arrayContaining(['personId', 'status', 'basic.firstNameTh']));
    expect(fields.some((f) => f.startsWith('identity.'))).toBe(false);
  });

  // T8: employeeNo = เลขบัตรประชาชน (pid) เสมอ (อบจ.ลำปางไม่มีเลขประจำตัวข้าราชการแยกต่างหาก) จึงต้อง
  // ถูก mask เหมือน pid_hash/pid_enc คือต้องมี scope personnel:read:pid โดยเฉพาะ แค่ personnel:read:basic
  // หรือ personnel:read:employment อย่างเดียวไม่พอ
  test('employeeNo ต้องใช้ scope personnel:read:pid เท่านั้น (basic/employment อย่างเดียวไม่พอ)', async () => {
    const token = await ctx.auth.signToken({
      scope: 'personnel:read:basic personnel:read:employment',
    });
    const res = await request(ctx.app)
      .get(`/api/v1/persons/${FIXTURE_PERSON_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.basic.employeeNo).toBeUndefined();
    expect(res.body.employment).toBeDefined();
    expect(res.body.employment.employeeNo).toBeUndefined();
  });

  test('เพิ่ม personnel:read:pid -> เห็น employeeNo ทั้งใน basic และ employment', async () => {
    const token = await ctx.auth.signToken({
      scope: 'personnel:read:basic personnel:read:employment personnel:read:pid',
    });
    const res = await request(ctx.app)
      .get(`/api/v1/persons/${FIXTURE_PERSON_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.basic.employeeNo).toBe('EMP-0001');
    expect(res.body.employment.employeeNo).toBe('EMP-0001');
  });
});
