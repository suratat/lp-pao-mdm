const crypto = require('node:crypto');
const request = require('supertest');
const { buildIntegrationHarness } = require('./testHarness');

// หน้าแก้ไขข้อมูลติดต่อของ portal: ไม่มีบ้านเลขที่/ที่อยู่แบบเต็ม, ป้ายอีเมล, ตรวจรูปแบบอีเมล/เบอร์โทร, ปุ่มตรวจสอบอีเมล (mock DNS)
// ใช้ portal จริง -> MDM API จริง (ไม่ mock MDM API) ข้อมูลทั้งหมดสมมติ

const DNS_STATUS = { current: 'ok' };
let calls;
let harness;

beforeAll(async () => {
  calls = [];
  harness = await buildIntegrationHarness({
    emailCheck: {
      checkDomain: async (email) => {
        calls.push(email);
        if (DNS_STATUS.current === 'throw') throw new Error('boom');
        return DNS_STATUS.current;
      },
    },
  });
});

afterAll(async () => {
  await harness.close();
});

const db = (sql, params) => harness.apiCtx.pool.query(sql, params);

async function makePerson() {
  const personId = crypto.randomUUID();
  await db(`INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version) VALUES ($1, $2, 'ACTIVE', 'VERIFIED', 1)`, [
    personId,
    crypto.randomBytes(32).toString('hex'),
  ]);
  return personId;
}

async function login(personId) {
  const agent = request.agent(harness.portalApp);
  expect((await agent.post('/auth/dev-login').type('form').send({ personId })).status).toBe(302);
  return agent;
}

const stored = async (personId) => (await db(`SELECT * FROM mdm.person_contact WHERE person_id = $1`, [personId])).rows[0];

describe('ฟอร์มแก้ไขข้อมูลติดต่อ (portal)', () => {
  test('ไม่มีช่องบ้านเลขที่/ที่อยู่แบบเต็ม และป้ายเป็น "อีเมล" (ไม่ใช่ "อีเมลส่วนตัว")', async () => {
    const agent = await login(await makePerson());
    const res = await agent.get('/portal/me/contact');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('บ้านเลขที่');
    expect(res.text).not.toContain('ที่อยู่แบบเต็ม');
    expect(res.text).not.toContain('name="houseNo"');
    expect(res.text).not.toContain('name="fullText"');
    expect(res.text).not.toContain('อีเมลส่วนตัว');
    expect(res.text).toContain('>อีเมล</label>');
    expect(res.text).toContain('name="emailPersonal"');
    expect(res.text).toContain('data-email-check'); // ปุ่มตรวจสอบอีเมล (ซ่อนจนกว่า JS ทำงาน)
    expect(res.text).toMatch(/<button type="button" data-email-check>/);
    expect(res.text).toContain('hidden'); // กล่องปุ่มซ่อนไว้ ถ้า JS ปิดจะไม่เห็นปุ่มที่ใช้ไม่ได้
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  test('ฟอร์มยังส่งได้โดยไม่ต้องใช้ JavaScript: ปุ่มบันทึกเป็น submit ธรรมดา และเซิร์ฟเวอร์เป็นผู้บันทึก', async () => {
    const personId = await makePerson();
    const agent = await login(personId);
    const res = await agent.post('/portal/me/contact').type('form').send({ mobilePhone: '081-234-5678', emailPersonal: ' a@example.com ' });

    expect(res.status).toBe(302);
    const row = await stored(personId);
    expect([row.mobile_phone, row.email_personal]).toEqual(['0812345678', 'a@example.com']);
  });

  test('เบอร์/อีเมลไม่ผ่าน -> 422 ข้อความไทย คงค่าที่พิมพ์ไว้ ไม่เขียนอะไรลง DB', async () => {
    const personId = await makePerson();
    const agent = await login(personId);
    const res = await agent.post('/portal/me/contact').type('form').send({ mobilePhone: '0712345678', phoneAlt: '02-12', emailPersonal: 'bad@@example', lineId: 'keepline' });

    expect(res.status).toBe(422);
    expect(res.text).toContain('เบอร์มือถือไม่ถูกต้อง');
    expect(res.text).toContain('โทรศัพท์สำรองไม่ถูกต้อง');
    expect(res.text).toContain('รูปแบบอีเมลไม่ถูกต้อง');
    expect(res.text).toContain('0712345678'); // ค่าที่พิมพ์ยังอยู่ในช่อง
    expect(res.text).toContain('keepline');
    expect(await stored(personId)).toBeUndefined();
  });

  test('ค่าว่าง = ไม่บังคับ; ล้างค่าเดิมได้', async () => {
    const personId = await makePerson();
    const agent = await login(personId);
    expect((await agent.post('/portal/me/contact').type('form').send({ mobilePhone: '0812345678', emailPersonal: 'a@example.com' })).status).toBe(302);
    expect((await agent.post('/portal/me/contact').type('form').send({ mobilePhone: '', phoneAlt: '', emailPersonal: '', lineId: '' })).status).toBe(302);
    const row = await stored(personId);
    expect([row.mobile_phone, row.phone_alt, row.email_personal]).toEqual([null, null, null]);
  });

  test('ค่าเดิมที่ไม่ผ่านกติกาใหม่ แต่ผู้ใช้ไม่ได้แก้ -> บันทึกฟิลด์อื่นได้ และค่าเดิมคงอยู่', async () => {
    const personId = await makePerson();
    await db(`INSERT INTO mdm.person_contact (person_id, mobile_phone, email_personal, updated_by, updated_at) VALUES ($1, '081-234-567', 'old@localhost', 'HR', now())`, [personId]);
    const agent = await login(personId);

    const page = await agent.get('/portal/me/contact');
    expect(page.text).toContain('value="081-234-567"');
    expect(page.text).toContain('data-original="081-234-567"');

    const ok = await agent.post('/portal/me/contact').type('form').send({ mobilePhone: '081-234-567', emailPersonal: 'old@localhost', lineId: 'newline' });
    expect(ok.status).toBe(302);
    const row = await stored(personId);
    expect([row.mobile_phone, row.email_personal, row.line_id]).toEqual(['081-234-567', 'old@localhost', 'newline']);

    const bad = await agent.post('/portal/me/contact').type('form').send({ mobilePhone: '081-234-566', emailPersonal: 'old@localhost' });
    expect(bad.status).toBe(422);
  });

  test('ไม่ล้างบ้านเลขที่/ที่อยู่แบบเต็มที่เก็บไว้เดิมเมื่อบันทึกจากหน้านี้', async () => {
    const personId = await makePerson();
    await db(`INSERT INTO mdm.person_contact (person_id, cur_house_no, cur_address_text, updated_by, updated_at) VALUES ($1, '99/1', 'ที่อยู่เดิม', 'HR', now())`, [personId]);
    const agent = await login(personId);
    expect((await agent.post('/portal/me/contact').type('form').send({ mobilePhone: '0812345678' })).status).toBe(302);
    const row = await stored(personId);
    expect([row.cur_house_no, row.cur_address_text]).toEqual(['99/1', 'ที่อยู่เดิม']);
  });

  test('ส่ง houseNo/fullText มาในฟอร์มก็ไม่ถูกเขียน (เซิร์ฟเวอร์ไม่อ่านฟิลด์เหล่านี้)', async () => {
    const personId = await makePerson();
    const agent = await login(personId);
    const res = await agent.post('/portal/me/contact').type('form').send({ mobilePhone: '0812345678', houseNo: '1/1', fullText: 'ไม่ควรถูกเก็บ' });
    expect(res.status).toBe(302);
    const row = await stored(personId);
    expect([row.cur_house_no, row.cur_address_text]).toEqual([null, null]);
  });
});

describe('POST /portal/me/contact/check-email', () => {
  const post = (agent, body) => agent.post('/portal/me/contact/check-email').send(body);

  beforeEach(() => {
    calls.length = 0;
    DNS_STATUS.current = 'ok';
  });

  test('ไม่ล็อกอิน -> 401 JSON (ไม่ redirect) และไม่ค้น DNS', async () => {
    const res = await request(harness.portalApp).post('/portal/me/contact/check-email').send({ email: 'a@example.com' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ status: 'unauthorized' });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ['ok', 'รูปแบบถูกต้องและโดเมนรับอีเมลได้'],
    ['no_mx', 'โดเมนนี้ไม่มีเซิร์ฟเวอร์รับอีเมล'],
    ['unavailable', 'ตรวจสอบไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง'],
  ])('ผลการตรวจ %s -> ข้อความไทยตามสเปก', async (status, message) => {
    DNS_STATUS.current = status;
    const agent = await login(await makePerson());
    const res = await post(agent, { email: 'somchai@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status, message });
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(calls).toEqual(['somchai@example.com']);
  });

  test('รูปแบบไม่ผ่าน -> ตอบ invalid พร้อมข้อความไทย โดยไม่ค้น DNS; ค่าว่าง -> ขอให้กรอกก่อน', async () => {
    const agent = await login(await makePerson());
    const bad = await post(agent, { email: 'not-an-email' });
    expect(bad.body.status).toBe('invalid');
    expect(bad.body.message).toContain('รูปแบบอีเมลไม่ถูกต้อง');
    const empty = await post(agent, { email: '  ' });
    expect(empty.body).toMatchObject({ status: 'invalid', message: 'กรุณากรอกอีเมลก่อนตรวจสอบ' });
    expect(calls).toHaveLength(0);
  });

  test('body ไม่ถูกต้อง -> 400', async () => {
    const agent = await login(await makePerson());
    expect((await post(agent, {})).status).toBe(400);
    expect((await post(agent, { email: 123 })).status).toBe(400);
  });

  test('rate limit 10 ครั้ง/นาทีต่อ session: ครั้งที่ 11 -> 429, อีก session ไม่โดนด้วย', async () => {
    const limited = await login(await makePerson());
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await post(limited, { email: 'a@example.com' })).status).toBe(200);
    }
    const eleventh = await post(limited, { email: 'a@example.com' });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toMatchObject({ status: 'rate_limited', message: 'ตรวจสอบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' });
    expect(calls).toHaveLength(10);

    const other = await login(await makePerson());
    expect((await post(other, { email: 'a@example.com' })).status).toBe(200);
  });
});
