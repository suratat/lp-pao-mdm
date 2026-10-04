const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsDpo } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { CookieAccessInfo } = require('cookiejar');
const { makeFakePid } = require('../../api/src/security/pid');
const { COOKIE_NAME } = require('../src/session/sessionCookie');

// PR-B: /dpo/pid-reveals (รายการรอรีวิว + ฟอร์มรีวิว) - ใช้ MDM API จริง + Postgres จริง (ดู testHarness.js) ข้อมูลสมมติทั้งหมด
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

async function makePerson() {
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version) VALUES ($1, $2, 'ACTIVE', 'VERIFIED', 1)`,
    [personId, crypto.randomBytes(32).toString('hex')]
  );
  return personId;
}

// แถว access_log ของการเปิด pid (รูปแบบเดียวกับที่ PidService.reveal เขียน); accessedAt ไม่ระบุ = now() ซึ่งมีความละเอียด µs
async function insertReveal(personId, { actorSub = `revealer-${crypto.randomUUID()}`, justification = 'ส่งข้อมูลให้ กบข. ตามหนังสือที่ 77', accessedAt } = {}) {
  const { rows } = await adminPool.query(
    `INSERT INTO audit.access_log
       (accessed_at, subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method, fields_returned, justification, request_id, response_status)
     VALUES (COALESCE($1::timestamptz, now()), $2, 'SERVICE', $3, 'hr-console', $4, 'GET', '["pid"]', $5, gen_random_uuid()::text, 200)
     RETURNING access_id`,
    [accessedAt ?? null, personId, actorSub, `/api/v1/persons/${personId}/pid`, justification]
  );
  return Number(rows[0].access_id);
}

async function reviewRows(accessId) {
  const { rows } = await adminPool.query(
    `SELECT status, note, reviewer_sub FROM audit.pid_access_review WHERE access_id = $1 ORDER BY review_id`,
    [accessId]
  );
  return rows;
}

// ดึงค่าจากฟอร์มรีวิวของรายการหนึ่งในหน้า HTML (ค่า hidden: _csrf, accessedAt, returnStatus)
function formFields(html, accessId) {
  const form = html.match(new RegExp(`action="/dpo/pid-reveals/${accessId}/review"[\\s\\S]*?</form>`));
  if (!form) return null;
  const hidden = (name) => (form[0].match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];
  const unescape = (v) => (v === undefined ? v : v.replace(/&amp;/g, '&'));
  return { _csrf: unescape(hidden('_csrf')), accessedAt: unescape(hidden('accessedAt')), returnStatus: unescape(hidden('returnStatus')) };
}

describe('GET /dpo/pid-reveals', () => {
  test('แสดงเฉพาะการเปิด pid ที่รอรีวิว พร้อม accessId, ผู้เปิด, justification และไม่แสดงรายการอื่นหรือเลขบัตร', async () => {
    const personId = await makePerson();
    const actorSub = `revealer-${crypto.randomUUID()}`;
    const accessId = await insertReveal(personId, { actorSub, justification: 'เหตุผลตรวจสอบรายการทดสอบ A' });
    await adminPool.query(
      `INSERT INTO audit.access_log (subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method, fields_returned, request_id, response_status)
       VALUES ($1, 'SERVICE', $2, 'hr-console', $3, 'GET', '["basic.firstNameTh"]', 'req-not-reveal-marker', 200)`,
      [personId, actorSub, `/api/v1/persons/${personId}`]
    );

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/pid-reveals').query({ personId });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(`<td>${accessId}</td>`);
    expect(res.text).toContain(actorSub);
    expect(res.text).toContain('เหตุผลตรวจสอบรายการทดสอบ A');
    expect(res.text).toContain('รอรีวิว');
    expect(res.text).not.toContain('req-not-reveal-marker');
    expect(res.text).not.toContain('/api/v1/persons/'); // ไม่แสดง endpoint ดิบ
  });

  test('เลข 13 หลักที่หลุดอยู่ใน justification ของแถวเก่าไม่ปรากฏในหน้าจอ', async () => {
    const personId = await makePerson();
    const leaked = makeFakePid();
    await insertReveal(personId, { justification: `เลขเก่า ${leaked} หลุดมา` });
    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/pid-reveals').query({ personId });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(leaked);
    expect(res.text).toContain('ปกปิดเลข 13 หลัก');
  });

  test('dpo เห็นฟอร์มรีวิวพร้อม CSRF; auditor อ่านอย่างเดียว (ไม่มีฟอร์ม)', async () => {
    const personId = await makePerson();
    const accessId = await insertReveal(personId);

    const dpo = await (await loginAsDpo(harness.dpoConsoleApp)).get('/dpo/pid-reveals').query({ personId });
    expect(formFields(dpo.text, accessId)._csrf).toBeTruthy();

    const auditor = await (await loginAsDpo(harness.dpoConsoleApp, 'good-auditor-code')).get('/dpo/pid-reveals').query({ personId });
    expect(auditor.status).toBe(200);
    expect(auditor.text).toContain(`<td>${accessId}</td>`);
    expect(formFields(auditor.text, accessId)).toBeNull();
    expect(auditor.text).toContain('อ่านอย่างเดียว');
  });

  test('ไม่ได้ล็อกอิน -> redirect ไป login (GET และ POST)', async () => {
    expect((await request(harness.dpoConsoleApp).get('/dpo/pid-reveals')).headers.location).toBe('/auth/login');
    const post = await request(harness.dpoConsoleApp).post('/dpo/pid-reveals/1/review').type('form').send({ status: 'REVIEWED' });
    expect(post.status).toBe(302);
    expect(post.headers.location).toBe('/auth/login');
  });
});

describe('POST /dpo/pid-reveals/{accessId}/review', () => {
  async function openAs(code, personId, accessId) {
    const agent = await loginAsDpo(harness.dpoConsoleApp, code);
    const page = await agent.get('/dpo/pid-reveals').query({ personId });
    return { agent, fields: formFields(page.text, accessId) };
  }

  test('dpo รีวิวรายการของผู้อื่น -> 303 กลับรายการ, สถานะเปลี่ยน (ย้ายไป REVIEWED), เก็บ reviewer_sub; ความละเอียด µs ผ่านฟอร์มได้', async () => {
    const personId = await makePerson();
    const accessId = await insertReveal(personId, { accessedAt: new Date(Date.now() - 3600_000).toISOString().replace('Z', '654Z').replace(/\.(\d{3})654Z/, '.$1654+00:00') });
    const { agent, fields } = await openAs('good-dpo-code', personId, accessId);

    const res = await agent.post(`/dpo/pid-reveals/${accessId}/review`).type('form').send({ ...fields, status: 'REVIEWED', note: 'ตรวจแล้วตรงกับหนังสือ' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/dpo/pid-reveals?reviewStatus=PENDING');
    expect(await reviewRows(accessId)).toEqual([{ status: 'REVIEWED', note: 'ตรวจแล้วตรงกับหนังสือ', reviewer_sub: 'dpo.one' }]);

    expect((await agent.get('/dpo/pid-reveals').query({ personId })).text).not.toContain(`<td>${accessId}</td>`);
    const done = await agent.get('/dpo/pid-reveals').query({ personId, reviewStatus: 'REVIEWED' });
    expect(done.text).toContain(`<td>${accessId}</td>`);
    expect(done.text).toContain('โดย dpo.one');
    expect(done.text).toContain('ตรวจแล้วตรงกับหนังสือ');
    // รายการที่รีวิวแล้วยังรีวิวซ้ำ (เปลี่ยนผล) ได้ - ฟอร์มยังอยู่
    expect(formFields(done.text, accessId)).not.toBeNull();
  });

  test('ขอคำชี้แจง (NEEDS_EXPLANATION) แล้วรีวิวซ้ำเป็น REVIEWED โดยอีกคน', async () => {
    const personId = await makePerson();
    const accessId = await insertReveal(personId);
    const one = await openAs('good-dpo-code', personId, accessId);
    expect((await one.agent.post(`/dpo/pid-reveals/${accessId}/review`).type('form').send({ ...one.fields, status: 'NEEDS_EXPLANATION', note: 'ชี้แจงหนังสืออ้างอิง' })).status).toBe(303);

    const two = await openAs('good-dpo-two-code', personId, accessId);
    // ขณะนี้อยู่ในสถานะ NEEDS_EXPLANATION ไม่ใช่ PENDING จึงไม่อยู่ในรายการแรก
    expect(two.fields).toBeNull();
    const page = await two.agent.get('/dpo/pid-reveals').query({ personId, reviewStatus: 'NEEDS_EXPLANATION' });
    const fields = formFields(page.text, accessId);
    expect((await two.agent.post(`/dpo/pid-reveals/${accessId}/review`).type('form').send({ ...fields, status: 'REVIEWED', note: 'ชี้แจงครบ' })).status).toBe(303);
    expect((await reviewRows(accessId)).map((r) => [r.status, r.reviewer_sub])).toEqual([
      ['NEEDS_EXPLANATION', 'dpo.one'],
      ['REVIEWED', 'dpo.two'],
    ]);
  });

  test('ห้ามรีวิวของตัวเอง: รายการที่ dpo.one เป็นผู้เปิด -> 403 พร้อมข้อความ และไม่เขียนแถว', async () => {
    const personId = await makePerson();
    const accessId = await insertReveal(personId, { actorSub: 'dpo.one' });
    const { agent, fields } = await openAs('good-dpo-code', personId, accessId);
    const res = await agent.post(`/dpo/pid-reveals/${accessId}/review`).type('form').send({ ...fields, status: 'REVIEWED' });
    expect(res.status).toBe(403);
    expect(res.text).toContain('รีวิวรายการของตนเองไม่ได้');
    expect(await reviewRows(accessId)).toEqual([]);
  });

  test('CSRF ไม่ถูกต้อง/ไม่มี -> 403 และไม่เขียนแถว', async () => {
    const personId = await makePerson();
    const accessId = await insertReveal(personId);
    const { agent, fields } = await openAs('good-dpo-code', personId, accessId);

    const wrong = await agent.post(`/dpo/pid-reveals/${accessId}/review`).type('form').send({ ...fields, _csrf: 'x'.repeat(fields._csrf.length), status: 'REVIEWED' });
    expect(wrong.status).toBe(403);
    expect(wrong.text).toContain('CSRF');
    const missing = await agent.post(`/dpo/pid-reveals/${accessId}/review`).type('form').send({ accessedAt: fields.accessedAt, status: 'REVIEWED' });
    expect(missing.status).toBe(403);
    expect(await reviewRows(accessId)).toEqual([]);
  });

  test('auditor ส่งฟอร์มเองด้วย CSRF ที่ถูกต้องของ session ตน -> 403 ไม่เขียนแถว (UI ซ่อนฟอร์ม + canReview ตรวจซ้ำที่ server)', async () => {
    const personId = await makePerson();
    const accessId = await insertReveal(personId);
    const dpoPage = await (await loginAsDpo(harness.dpoConsoleApp)).get('/dpo/pid-reveals').query({ personId });
    const fields = formFields(dpoPage.text, accessId);

    const auditor = await loginAsDpo(harness.dpoConsoleApp, 'good-auditor-code');
    // หน้าของ auditor ไม่มีฟอร์ม จึงไม่มี CSRF ให้อ่านจาก HTML - อ่านตรงจาก session store ของ console ผ่าน cookie ของ agent
    const sid = auditor.jar.getCookies(CookieAccessInfo.All).find((c) => c.name === COOKIE_NAME).value;
    const csrfToken = harness.sessionStore.get(sid).csrfToken;
    expect(csrfToken).toBeTruthy();

    const res = await auditor.post(`/dpo/pid-reveals/${accessId}/review`).type('form').send({ ...fields, _csrf: csrfToken, status: 'REVIEWED' });
    expect(res.status).toBe(403);
    expect(res.text).toContain('ต้องเป็น role dpo');
    expect(await reviewRows(accessId)).toEqual([]);
  });

  test('หมายเหตุ: ขอคำชี้แจงต้องมี note, ห้ามมีเลข 13 หลัก (ทั้งติดกันและมีขีด), ยาวเกิน 1000 -> 422 และไม่เขียนแถว', async () => {
    const personId = await makePerson();
    const accessId = await insertReveal(personId);
    const { agent, fields } = await openAs('good-dpo-code', personId, accessId);
    const post = (body) => agent.post(`/dpo/pid-reveals/${accessId}/review`).type('form').send({ ...fields, ...body });

    expect((await post({ status: 'NEEDS_EXPLANATION', note: '  ' })).status).toBe(422);
    const pid = makeFakePid();
    const dashed = `${pid.slice(0, 1)}-${pid.slice(1, 5)}-${pid.slice(5, 10)}-${pid.slice(10, 12)}-${pid.slice(12)}`;
    for (const note of [`เลข ${pid}`, `เลข ${dashed}`]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post({ status: 'REVIEWED', note });
      expect(res.status).toBe(422);
      expect(res.text).not.toContain(pid);
      expect(res.text).not.toContain(dashed);
    }
    expect((await post({ status: 'REVIEWED', note: 'ก'.repeat(1001) })).status).toBe(422);
    expect((await post({ status: 'PENDING' })).status).toBe(422);
    expect(await reviewRows(accessId)).toEqual([]);
  });

  test('หมายเหตุภาษาไทยยาวเต็ม 1000 ตัวอักษร (percent-encode ราว 27 KB) ต้องผ่าน ไม่โดน 413', async () => {
    const personId = await makePerson();
    const accessId = await insertReveal(personId);
    const { agent, fields } = await openAs('good-dpo-code', personId, accessId);
    const res = await agent.post(`/dpo/pid-reveals/${accessId}/review`).type('form').send({ ...fields, status: 'REVIEWED', note: 'ก'.repeat(1000) });
    expect(res.status).toBe(303);
    expect((await reviewRows(accessId))[0].note).toHaveLength(1000);
  });

  test('accessId ไม่ใช่ตัวเลข -> 404; accessId ที่ไม่มีอยู่ -> 404 จาก API', async () => {
    const personId = await makePerson();
    const accessId = await insertReveal(personId);
    const { agent, fields } = await openAs('good-dpo-code', personId, accessId);
    expect((await agent.post('/dpo/pid-reveals/abc/review').type('form').send({ ...fields, status: 'REVIEWED' })).status).toBe(404);
    expect((await agent.post(`/dpo/pid-reveals/${accessId + 999999999}/review`).type('form').send({ ...fields, status: 'REVIEWED' })).status).toBe(404);
  });
});

describe('หน้า access log และ change-logs', () => {
  test('/dpo/access-logs แสดง Access ID, justification และสถานะรีวิว', async () => {
    const personId = await makePerson();
    const accessId = await insertReveal(personId, { justification: 'เหตุผลที่ต้องแสดงในหน้า access log' });
    const res = await (await loginAsDpo(harness.dpoConsoleApp)).get('/dpo/access-logs').query({ personId });
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<td>${accessId}</td>`);
    expect(res.text).toContain('เหตุผลที่ต้องแสดงในหน้า access log');
    expect(res.text).toContain('badge-pending');
  });

  test('/dpo/change-logs: หัวข้อระบุว่าค่าชั้น CONFIDENTIAL ขึ้นไปถูกปกปิด (ไม่ใช่ "ข้อมูลส่วนบุคคลทั้งหมด")', async () => {
    const res = await (await loginAsDpo(harness.dpoConsoleApp)).get('/dpo/change-logs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ค่าของข้อมูลชั้น CONFIDENTIAL ขึ้นไปถูกปกปิด');
    expect(res.text).not.toContain('ค่าของข้อมูลส่วนบุคคลถูกปกปิด');
  });
});
