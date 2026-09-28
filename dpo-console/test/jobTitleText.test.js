const crypto = require('node:crypto');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsDpo } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');

// หน้า change-log แสดงค่าเก่า/ใหม่ของ employment.job_title_text (ข้อความอิสระ) ซึ่งเก็บเต็มใน jsonb - ต้อง escape และไม่ทำให้ตารางล้น
let harness;
let adminPool;

beforeAll(async () => {
  harness = await buildIntegrationHarness();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
});

afterAll(async () => {
  await harness.close();
  await adminPool.end();
});

async function changeLogPage(oldText, newText) {
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version) VALUES ($1, $2, 'ACTIVE', 'VERIFIED', 1)`,
    [personId, crypto.randomBytes(32).toString('hex')]
  );
  await adminPool.query(
    `INSERT INTO audit.data_change_log (person_id, table_name, field_name, old_value, new_value, changed_by, reason)
     VALUES ($1, 'employment', 'employment.job_title_text', $2, $3, 'HR', 'ทดสอบ')`,
    [personId, JSON.stringify(oldText), JSON.stringify(newText)]
  );
  const agent = await loginAsDpo(harness.dpoConsoleApp);
  const res = await agent.get(`/dpo/persons/${personId}/change-log`);
  expect(res.status).toBe(200);
  return res.text;
}

describe('DPO Console change-log: employment.job_title_text', () => {
  test('แสดงค่าเก่า/ใหม่ของข้อความ', async () => {
    const html = await changeLogPage('ช่างไฟฟ้า', 'ช่างประปา');
    expect(html).toContain('employment.job_title_text');
    expect(html).toContain('ช่างไฟฟ้า');
    expect(html).toContain('ช่างประปา');
  });

  test('<script> และ " ถูก escape ไม่ทะลุเป็น HTML จริง (ทั้งค่าเก่าและค่าใหม่)', async () => {
    const xss = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
    const html = await changeLogPage(xss, xss);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
  });

  test('ข้อความยาว 255 ตัวอักษรไม่มีช่องว่างแสดงครบ และตารางมี overflow-wrap: anywhere', async () => {
    const long = 'ก'.repeat(255);
    const html = await changeLogPage(long, long);
    expect(html).toContain(long);
    expect(html).toMatch(/td, th \{[^}]*overflow-wrap: anywhere;[^}]*\}/);
  });
});
