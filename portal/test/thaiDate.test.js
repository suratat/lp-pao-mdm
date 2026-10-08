const request = require('supertest');
const { Pool } = require('pg');
const { buildIntegrationHarness } = require('./testHarness');
const { FIXTURE_PERSON_ID } = require('../../api/test/fixtures');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { formatThaiDate, formatThaiDateTime, todayBangkok } = require('../src/thaiTime');

// ต้องผ่านไม่ว่า TZ ของเครื่องเป็นอะไร (รันด้วย TZ=UTC และ TZ=Asia/Bangkok)
describe('thaiTime helper (portal)', () => {
  test('วันที่ล้วน: ไม่เลื่อนวัน ไม่ว่า TZ ไหน; null = "-"', () => {
    expect(formatThaiDate('2026-10-08')).toBe('8 ต.ค. 2569');
    expect(formatThaiDate('2026-01-01')).toBe('1 ม.ค. 2569');
    expect(formatThaiDate('2026-12-31')).toBe('31 ธ.ค. 2569');
    for (const v of [null, undefined, '']) expect(formatThaiDate(v)).toBe('-');
  });
  test('วันเวลา: ข้ามวัน และ null = "-"', () => {
    expect(formatThaiDateTime('2026-10-08T18:30:00Z')).toBe('9 ต.ค. 2569 01:30:00');
    expect(formatThaiDateTime(null)).toBe('-');
  });
  test('todayBangkok: 2026-10-08T18:30Z เป็นวันที่ 9 ตามเวลาไทย', () => {
    expect(todayBangkok(new Date('2026-10-08T18:30:00Z'))).toBe('2026-10-09');
  });
});

describe('Portal /portal/me: วันบรรจุเป็น พ.ศ.', () => {
  let harness;
  let adminPool;
  let original;
  beforeAll(async () => {
    harness = await buildIntegrationHarness();
    adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
    original = (await adminPool.query(`SELECT appointed_date::text AS d FROM mdm.employment WHERE person_id = $1 AND is_current`, [FIXTURE_PERSON_ID])).rows[0]?.d ?? null;
  });
  afterAll(async () => {
    await adminPool.query(`UPDATE mdm.employment SET appointed_date = $2 WHERE person_id = $1 AND is_current`, [FIXTURE_PERSON_ID, original]);
    await harness.close();
    await adminPool.end();
  });
  async function me(date) {
    await adminPool.query(`UPDATE mdm.employment SET appointed_date = $2 WHERE person_id = $1 AND is_current`, [FIXTURE_PERSON_ID, date]);
    const agent = request.agent(harness.portalApp);
    await agent.post('/auth/dev-login').type('form').send({ personId: FIXTURE_PERSON_ID });
    return (await agent.get('/portal/me')).text;
  }
  test('แสดง 15 มี.ค. 2567 (ไม่ใช่ 2024-03-15) และไม่มีวัน = "-"', async () => {
    const html = await me('2024-03-15');
    expect(html).toMatch(/<th>วันบรรจุ<\/th><td>15 มี\.ค\. 2567<\/td>/);
    expect(html).not.toContain('2024-03-15');
    expect(await me(null)).toMatch(/<th>วันบรรจุ<\/th><td>-<\/td>/);
  });
});
