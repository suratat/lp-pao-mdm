const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { CookieAccessInfo } = require('cookiejar');
const { buildIntegrationHarness, loginAsDpo } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { makeFakePid } = require('../../api/src/security/pid');
const { COOKIE_NAME } = require('../src/session/sessionCookie');

// PR-C: /dpo/alerts - ใช้ MDM API จริง + Postgres จริง (alert ถูกแทรกตรงด้วย adminPool เพราะ worker เท่านั้นที่เขียนจริง)
// sub ของผู้ใช้ทดสอบ = username ใน scenario: 'dpo.one' / 'dpo.two' (role dpo), 'auditor.one' (role auditor)

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

async function insertAlert({ actor = `actor-${crypto.randomUUID()}`, rule = 'BULK_VIEW', client = 'hr-console' } = {}) {
  const { rows } = await adminPool.query(
    `INSERT INTO audit.access_alert (rule_code, dedupe_key, severity, actor_sub, actor_client, window_start, window_end, metric_count, threshold, details)
     VALUES ($1, $2, 'HIGH', $3, $4, now() - interval '10 minutes', now(), 31, 30, '{"distinctPersons": 31, "windowMinutes": 10}') RETURNING alert_id`,
    [rule, `UI:${crypto.randomUUID()}`, actor, client]
  );
  return { alertId: Number(rows[0].alert_id), actor };
}

const actionRows = async (alertId) =>
  (await adminPool.query(`SELECT action, note, actor_sub FROM audit.access_alert_action WHERE alert_id = $1 ORDER BY action_id`, [alertId])).rows;

// ดึงค่าจากฟอร์มของ alert ในหน้า HTML (hidden: _csrf, returnStatus)
function formFields(html, alertId) {
  const form = html.match(new RegExp(`action="/dpo/alerts/${alertId}/close"[\\s\\S]*?</form>`));
  if (!form) return null;
  const hidden = (name) => (form[0].match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];
  return { _csrf: hidden('_csrf'), returnStatus: hidden('returnStatus') };
}

async function openAs(code, actor) {
  const agent = await loginAsDpo(harness.dpoConsoleApp, code);
  const page = await agent.get('/dpo/alerts').query({ actorSub: actor });
  return { agent, page, fields: (id) => formFields(page.text, id) };
}

describe('GET /dpo/alerts', () => {
  test('แสดง alert ที่ตรวจพบ: กฎภาษาไทย, ความรุนแรง, บัญชี/ client, จำนวน/เกณฑ์, สถานะ; ไม่แสดงตัวตนบุคคลและไม่ cache', async () => {
    const { alertId, actor } = await insertAlert({ rule: 'PID_REVEAL_FREQUENT' });
    const res = await (await loginAsDpo(harness.dpoConsoleApp)).get('/dpo/alerts').query({ actorSub: actor });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(`<td>${alertId}</td>`);
    expect(res.text).toContain('เปิดเลขบัตรประชาชนบ่อยผิดปกติ');
    expect(res.text).toContain(actor);
    expect(res.text).toContain('hr-console');
    expect(res.text).toContain('31 / 30');
    expect(res.text).toContain('รอดำเนินการ');
    expect(res.text).toContain('/dpo/access-logs?clientId=hr-console'); // ลิงก์ไปดู access log ช่วงเวลานั้น
    expect(res.text).not.toMatch(/\d{13}/);
  });

  test('ตัวกรองสถานะ (ค่าเริ่มต้น OPEN) และกฎ', async () => {
    const a = await insertAlert({ rule: 'OFF_HOURS' });
    const agent = await loginAsDpo(harness.dpoConsoleApp);
    expect((await agent.get('/dpo/alerts').query({ actorSub: a.actor })).text).toContain(`<td>${a.alertId}</td>`);
    expect((await agent.get('/dpo/alerts').query({ actorSub: a.actor, status: 'CLOSED' })).text).not.toContain(`<td>${a.alertId}</td>`);
    expect((await agent.get('/dpo/alerts').query({ actorSub: a.actor, ruleCode: 'BULK_VIEW' })).text).not.toContain(`<td>${a.alertId}</td>`);
    expect((await agent.get('/dpo/alerts').query({ actorSub: a.actor, ruleCode: 'OFF_HOURS' })).text).toContain(`<td>${a.alertId}</td>`);
  });

  test('dpo เห็นฟอร์ม (CSRF + ปุ่มรับทราบ/ปิดเรื่อง); auditor อ่านอย่างเดียว ไม่มีฟอร์ม', async () => {
    const { alertId, actor } = await insertAlert();
    const dpoPage = await openAs('good-dpo-code', actor);
    const fields = dpoPage.fields(alertId);
    expect(fields._csrf).toBeTruthy();
    expect(dpoPage.page.text).toContain(`formaction="/dpo/alerts/${alertId}/ack"`);

    const auditor = await openAs('good-auditor-code', actor);
    expect(auditor.page.status).toBe(200);
    expect(auditor.page.text).toContain(`<td>${alertId}</td>`);
    expect(auditor.fields(alertId)).toBeNull();
    expect(auditor.page.text).toContain('อ่านอย่างเดียว');
  });

  test('ไม่ได้ล็อกอิน -> redirect ไป login (GET และ POST)', async () => {
    expect((await request(harness.dpoConsoleApp).get('/dpo/alerts')).headers.location).toBe('/auth/login');
    const post = await request(harness.dpoConsoleApp).post('/dpo/alerts/1/ack').type('form').send({});
    expect(post.status).toBe(302);
    expect(post.headers.location).toBe('/auth/login');
  });
});

describe('POST /dpo/alerts/{id}/ack และ /close', () => {
  test('รับทราบ -> 303 กลับรายการ OPEN, alert ย้ายไปสถานะ ACK พร้อมผู้ดำเนินการ; แล้วปิดเรื่องพร้อมหมายเหตุ -> CLOSED', async () => {
    const { alertId, actor } = await insertAlert();
    const { agent, fields } = await openAs('good-dpo-code', actor);

    const ack = await agent.post(`/dpo/alerts/${alertId}/ack`).type('form').send({ ...fields(alertId), note: 'รับเรื่อง กำลังตรวจสอบ' });
    expect(ack.status).toBe(303);
    expect(ack.headers.location).toBe('/dpo/alerts?status=OPEN');
    expect((await agent.get('/dpo/alerts').query({ actorSub: actor })).text).not.toContain(`<td>${alertId}</td>`);

    const acked = await agent.get('/dpo/alerts').query({ actorSub: actor, status: 'ACK' });
    expect(acked.text).toContain(`<td>${alertId}</td>`);
    expect(acked.text).toContain('โดย dpo.one');
    expect(acked.text).toContain('รับเรื่อง กำลังตรวจสอบ');
    expect(acked.text).not.toContain(`formaction="/dpo/alerts/${alertId}/ack"`); // รับทราบแล้ว ไม่มีปุ่มรับทราบซ้ำ

    const close = await agent.post(`/dpo/alerts/${alertId}/close`).type('form').send({ ...formFields(acked.text, alertId), note: 'เป็นงานตามคำสั่ง ไม่ผิดปกติ' });
    expect(close.status).toBe(303);
    expect(close.headers.location).toBe('/dpo/alerts?status=ACK');
    const closed = await agent.get('/dpo/alerts').query({ actorSub: actor, status: 'CLOSED' });
    expect(closed.text).toContain('ปิดเรื่องแล้ว');
    expect(closed.text).toContain('เป็นงานตามคำสั่ง ไม่ผิดปกติ');
    expect((await actionRows(alertId)).map((r) => [r.action, r.actor_sub])).toEqual([
      ['ACK', 'dpo.one'],
      ['CLOSE', 'dpo.one'],
    ]);
  });

  test('ปิดเรื่องต้องมีหมายเหตุ (422) ไม่เรียก API; หมายเหตุมีเลข 13 หลัก/ยาวเกิน -> 422 และไม่สะท้อนเลข', async () => {
    const { alertId, actor } = await insertAlert();
    const { agent, fields } = await openAs('good-dpo-code', actor);
    const post = (body) => agent.post(`/dpo/alerts/${alertId}/close`).type('form').send({ ...fields(alertId), ...body });

    expect((await post({ note: '   ' })).status).toBe(422);
    const pid = makeFakePid();
    const dashed = `${pid.slice(0, 1)}-${pid.slice(1, 5)}-${pid.slice(5, 10)}-${pid.slice(10, 12)}-${pid.slice(12)}`;
    for (const note of [`เลข ${pid}`, `เลข ${dashed}`]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post({ note });
      expect(res.status).toBe(422);
      expect(res.text).not.toContain(pid);
      expect(res.text).not.toContain(dashed);
    }
    expect((await post({ note: 'ก'.repeat(1001) })).status).toBe(422);
    expect(await actionRows(alertId)).toEqual([]);
  });

  test('หมายเหตุภาษาไทยยาวเต็ม 1000 ตัวอักษร (percent-encode ราว 27 KB) ต้องผ่าน ไม่โดน 413', async () => {
    const { alertId, actor } = await insertAlert();
    const { agent, fields } = await openAs('good-dpo-code', actor);
    const res = await agent.post(`/dpo/alerts/${alertId}/close`).type('form').send({ ...fields(alertId), note: 'ก'.repeat(1000) });
    expect(res.status).toBe(303);
    expect((await actionRows(alertId))[0].note).toHaveLength(1000);
  });

  test('ห้ามดำเนินการกับ alert ของตัวเอง: alert ของ dpo.one -> 403 พร้อมข้อความจาก API และไม่เขียนแถว', async () => {
    const { alertId, actor } = await insertAlert({ actor: 'dpo.one' });
    const { agent, fields } = await openAs('good-dpo-code', actor);
    const res = await agent.post(`/dpo/alerts/${alertId}/close`).type('form').send({ ...fields(alertId), note: 'ลองปิดเอง' });
    expect(res.status).toBe(403);
    expect(res.text).toContain('บัญชีคุณเอง');
    expect(await actionRows(alertId)).toEqual([]);
  });

  test('ปิดไปแล้ว -> 409 แสดงข้อความจาก API (ผู้ใช้สองคนกดพร้อมกัน)', async () => {
    const { alertId, actor } = await insertAlert();
    const one = await openAs('good-dpo-code', actor);
    const two = await openAs('good-dpo-two-code', actor);
    expect((await one.agent.post(`/dpo/alerts/${alertId}/close`).type('form').send({ ...one.fields(alertId), note: 'ปิดโดยคนแรก' })).status).toBe(303);
    const res = await two.agent.post(`/dpo/alerts/${alertId}/close`).type('form').send({ ...two.fields(alertId), note: 'ปิดโดยคนที่สอง' });
    expect(res.status).toBe(409);
    expect(res.text).toContain('ปิดแล้วดำเนินการต่อไม่ได้');
    expect(await actionRows(alertId)).toHaveLength(1);
  });

  test('CSRF ผิด/ไม่มี -> 403 ไม่เขียนแถว', async () => {
    const { alertId, actor } = await insertAlert();
    const { agent, fields } = await openAs('good-dpo-code', actor);
    const wrong = await agent.post(`/dpo/alerts/${alertId}/ack`).type('form').send({ ...fields(alertId), _csrf: 'x'.repeat(fields(alertId)._csrf.length) });
    expect(wrong.status).toBe(403);
    expect(wrong.text).toContain('CSRF');
    expect((await agent.post(`/dpo/alerts/${alertId}/ack`).type('form').send({ returnStatus: 'OPEN' })).status).toBe(403);
    expect(await actionRows(alertId)).toEqual([]);
  });

  test('auditor ส่งฟอร์มเองด้วย CSRF ที่ถูกต้องของ session ตน -> 403 ไม่เขียนแถว (UI ซ่อนฟอร์ม + canReview ตรวจซ้ำที่ server)', async () => {
    const { alertId } = await insertAlert();
    const auditor = await loginAsDpo(harness.dpoConsoleApp, 'good-auditor-code');
    const sid = auditor.jar.getCookies(CookieAccessInfo.All).find((c) => c.name === COOKIE_NAME).value;
    const csrfToken = harness.sessionStore.get(sid).csrfToken;
    const res = await auditor.post(`/dpo/alerts/${alertId}/close`).type('form').send({ _csrf: csrfToken, note: 'auditor ลองปิดเรื่อง' });
    expect(res.status).toBe(403);
    expect(res.text).toContain('ต้องเป็น role dpo');
    expect(await actionRows(alertId)).toEqual([]);
  });

  test('alertId ไม่ใช่ตัวเลข -> 404 (ไม่ตรงเส้นทาง action); ไม่มีอยู่ -> 404 จาก API', async () => {
    const { alertId, actor } = await insertAlert();
    const { agent, fields } = await openAs('good-dpo-code', actor);
    expect((await agent.post('/dpo/alerts/abc/ack').type('form').send({ ...fields(alertId), note: 'x' })).status).toBe(404);
    expect((await agent.post(`/dpo/alerts/${alertId + 999999999}/ack`).type('form').send({ ...fields(alertId), note: 'x' })).status).toBe(404);
  });
});
