const request = require('supertest');
const { Pool } = require('pg');
const { buildIntegrationHarness } = require('./testHarness');
const { FIXTURE_PERSON_ID } = require('../../api/test/fixtures');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');

// หน้า "ข้อมูลของฉัน": แสดงชื่อตำแหน่ง/ลักษณะงาน (ข้อความอิสระ) ต้อง escape ทุกจุดและไม่ทำให้ตารางล้นเมื่อข้อความยาว
let harness;
let adminPool;

beforeAll(async () => {
  harness = await buildIntegrationHarness();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
});

afterAll(async () => {
  await adminPool.query(`UPDATE mdm.employment SET job_title_text = NULL WHERE person_id = $1`, [FIXTURE_PERSON_ID]);
  await harness.close();
  await adminPool.end();
});

async function meWithText(text) {
  // UPDATE ตรง (ข้ามกฎของ API) เพื่อจำลองข้อมูลอันตราย/ยาวผิดปกติที่หลุดมาอยู่ใน DB
  await adminPool.query(`UPDATE mdm.employment SET job_title_text = $2 WHERE person_id = $1 AND is_current`, [FIXTURE_PERSON_ID, text]);
  const agent = request.agent(harness.portalApp);
  await agent.post('/auth/dev-login').type('form').send({ personId: FIXTURE_PERSON_ID });
  const res = await agent.get('/portal/me');
  expect(res.status).toBe(200);
  return res.text;
}

describe('Portal /portal/me: ชื่อตำแหน่ง/ลักษณะงาน', () => {
  test('ไม่มีข้อความ -> ไม่มีแถวนี้', async () => {
    expect(await meWithText(null)).not.toContain('ชื่อตำแหน่ง/ลักษณะงาน');
  });

  test('แสดงข้อความปกติเป็นแถวแยก ไม่ปนกับช่อง "ตำแหน่ง"', async () => {
    const html = await meWithText('ผู้ช่วยช่างไฟฟ้า');
    expect(html).toMatch(/<th>ชื่อตำแหน่ง\/ลักษณะงาน<\/th><td>ผู้ช่วยช่างไฟฟ้า<\/td>/);
  });

  test('<script> และ " ถูก escape ไม่ทะลุเป็น HTML จริง', async () => {
    const html = await meWithText('<script>alert(1)</script>"><img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
  });

  test('ข้อความยาว 255 ตัวอักษรไม่มีช่องว่างแสดงครบ และตารางมี overflow-wrap: anywhere', async () => {
    const long = 'ก'.repeat(255);
    const html = await meWithText(long);
    expect(html).toContain(long);
    expect(html).toMatch(/td, th \{[^}]*overflow-wrap: anywhere;[^}]*\}/);
  });
});
