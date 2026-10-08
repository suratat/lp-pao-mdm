const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { makeFakePid, pidHash } = require('../src/security/pid');
const { insertFixtureOrgUnit } = require('./fixtures');

// PR-D1: การเขียนข้อมูลบุคคลด้วยมือต้องมี realm role hr_master_data_admin + reason บังคับ (ไม่มีเลข 13 หลัก) + optimistic lock
// ไฟล์นี้ "ไม่ใช้" helper hrWrite.js (ที่เติม role/reason ให้เทสต์เก่า) เพื่อทดสอบการบังคับใช้จริง ข้อมูลทั้งหมดสมมติ (pid จาก makeFakePid())

let ctx;
let adminPool;
let pepper;
let orgUnitId;

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  pepper = await ctx.vault.getPepper();
  orgUnitId = await insertFixtureOrgUnit(ctx.pool);
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

const ROLE = 'hr_master_data_admin';
const uniqueSub = (prefix) => `${prefix}-${crypto.randomUUID()}`;

// คืน object ที่ไม่ใช่ thenable (การ await supertest Test ตรงๆ จะยิง request ทันที)
async function call(method, urlPath, auth, body) {
  const token = await ctx.auth.signToken(auth);
  let req = request(ctx.app)[method](`/api/v1${urlPath}`).set('Authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body);
  return req;
}

const WRITE = 'personnel:write:employment personnel:read:basic';
const hr = (extra = {}) => ({ scope: WRITE, sub: uniqueSub('hr'), azp: 'hr-console', roles: [ROLE], ...extra });
const provisionAuth = (extra = {}) => ({ scope: 'personnel:provision personnel:read:basic', sub: uniqueSub('hr'), azp: 'hr-console', roles: [ROLE], ...extra });

async function makePosition() {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบสัญญา', 'GENERAL', $2) RETURNING position_id`,
    [`POS-D1-${crypto.randomUUID()}`, orgUnitId]
  );
  return rows[0].position_id;
}

async function employmentOf(pid, extra = {}) {
  return { employeeNo: pid, personnelType: 'CIVIL_SERVANT', positionId: await makePosition(), orgUnitId, effectiveFrom: '2024-01-01', ...extra };
}

async function provision(extra = {}) {
  const pid = makeFakePid();
  const res = await call('post', '/persons', provisionAuth(), {
    pid,
    expectedFirstNameTh: 'ก',
    expectedLastNameTh: 'ข',
    reason: 'เพิ่มบุคลากรใหม่ตามคำสั่งบรรจุ',
    employment: await employmentOf(pid),
    ...extra,
  });
  expect(res.status).toBe(201);
  return { personId: res.body.personId, pid, version: res.body.version };
}

const setStatus = (personId, status) => adminPool.query(`UPDATE mdm.person SET status = $2 WHERE person_id = $1`, [personId, status]);
const logsFor = async (personId) =>
  (await adminPool.query(`SELECT table_name, field_name, old_value, new_value, changed_by, actor_sub, actor_client, reason FROM audit.data_change_log WHERE person_id = $1 ORDER BY log_id`, [personId])).rows;
const outboxFor = async (personId) =>
  (await adminPool.query(`SELECT event_type, changed_fields, payload FROM integration.outbox_event WHERE person_id = $1 ORDER BY sequence`, [personId])).rows;
const versionOf = async (personId) => (await adminPool.query(`SELECT version FROM mdm.person WHERE person_id = $1`, [personId])).rows[0].version;

function dashed(pid) {
  return `${pid.slice(0, 1)}-${pid.slice(1, 5)}-${pid.slice(5, 10)}-${pid.slice(10, 12)}-${pid.slice(12)}`;
}

// ทั้ง 4 endpoint: ชื่อ, สร้าง request (ใช้ซ้ำในเทสต์ role/reason)
const ENDPOINTS = [
  {
    name: 'POST /persons',
    run: async (auth, { reason, extra = {} } = {}) => {
      const pid = makeFakePid();
      const res = await call('post', '/persons', auth, {
        pid,
        expectedFirstNameTh: 'ก',
        expectedLastNameTh: 'ข',
        ...(reason !== undefined ? { reason } : {}),
        employment: await employmentOf(pid, extra.employment),
      });
      return { res, pid };
    },
    authFor: provisionAuth,
  },
  {
    name: 'PUT /persons/{id}/employment',
    run: async (auth, { reason, extra = {} } = {}) => {
      const { personId, pid } = await provision();
      const res = await call('put', `/persons/${personId}/employment`, auth, { ...(await employmentOf(pid, { effectiveFrom: '2024-06-01', ...extra.employment })), ...(reason !== undefined ? { reason } : {}), ...extra.body });
      return { res, personId, pid };
    },
    authFor: hr,
  },
  {
    name: 'POST /persons/{id}/deactivate',
    run: async (auth, { reason, extra = {} } = {}) => {
      const { personId, pid } = await provision();
      const res = await call('post', `/persons/${personId}/deactivate`, auth, { employmentStatus: 'RESIGNED', separationDate: '2025-01-01', ...(reason !== undefined ? { reason } : {}), ...extra.body });
      return { res, personId, pid };
    },
    authFor: hr,
  },
  {
    name: 'POST /persons/{id}/reactivate',
    run: async (auth, { reason, extra = {} } = {}) => {
      const { personId, pid } = await provision();
      await setStatus(personId, 'INACTIVE');
      const res = await call('post', `/persons/${personId}/reactivate`, auth, { ...(await employmentOf(pid, { effectiveFrom: '2025-02-01', ...extra.employment })), ...(reason !== undefined ? { reason } : {}), ...extra.body });
      return { res, personId, pid };
    },
    authFor: hr,
  },
];

describe.each(ENDPOINTS)('$name', (ep) => {
  test('ไม่มี role hr_master_data_admin -> 403 insufficient-role (มีแค่ hr_officer ก็ไม่ผ่าน) และไม่เขียนอะไร', async () => {
    for (const roles of [undefined, ['hr_officer'], ['dpo', 'auditor']]) {
      // eslint-disable-next-line no-await-in-loop
      const { res, pid, personId } = await ep.run(ep.authFor({ roles }), { reason: 'ทดสอบสิทธิ์' });
      expect(res.status).toBe(403);
      expect(res.body.type).toMatch(/insufficient-role/);
      if (ep.name === 'POST /persons') {
        const { rows } = await adminPool.query(`SELECT 1 FROM mdm.person WHERE pid_hash = $1`, [pidHash(pid, pepper)]);
        expect(rows).toEqual([]);
      } else {
        // ไม่มีแถว log ใหม่นอกจากที่เกิดตอน provision ในขั้นเตรียมข้อมูล
        expect((await logsFor(personId)).every((l) => l.reason === 'เพิ่มบุคลากรใหม่ตามคำสั่งบรรจุ')).toBe(true);
      }
    }
  });

  test('ไม่มี scope -> 403 insufficient-scope (ก่อนตรวจ role)', async () => {
    const { res } = await ep.run(ep.authFor({ scope: 'personnel:read:basic' }), { reason: 'ทดสอบสิทธิ์' });
    expect(res.status).toBe(403);
    expect(res.body.type).toMatch(/insufficient-scope/);
  });

  test('มี scope + role + reason -> สำเร็จ และเก็บ reason ใน data_change_log (ตัดช่องว่างหัวท้าย) พร้อม actor', async () => {
    const auth = ep.authFor();
    const { res, personId, pid } = await ep.run(auth, { reason: '  เหตุผลทดสอบการเขียน  ' });
    expect([200, 201]).toContain(res.status);
    const id = personId ?? res.body.personId;
    const rows = (await logsFor(id)).filter((l) => l.reason && l.reason.includes('เหตุผลทดสอบการเขียน'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((l) => l.reason === 'เหตุผลทดสอบการเขียน' && l.actor_sub === auth.sub && l.actor_client === 'hr-console')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(pid);
  });

  test('ไม่ส่ง reason -> 400 (schema); ช่องว่างล้วน -> 422 reason-required', async () => {
    expect((await ep.run(ep.authFor(), {})).res.status).toBe(400);
    const blank = await ep.run(ep.authFor(), { reason: '    ' });
    expect(blank.res.status).toBe(422);
    expect(blank.res.body.type).toMatch(/reason-required/);
  });

  test('reason มีเลข 13 หลัก (ติดกัน / มีขีด / มีช่องว่าง) -> 422 reason-contains-pid ไม่สะท้อนเลขกลับ และไม่เขียนอะไร', async () => {
    const fake = makeFakePid();
    const spaced = `${fake.slice(0, 1)} ${fake.slice(1, 5)} ${fake.slice(5, 10)} ${fake.slice(10, 12)} ${fake.slice(12)}`;
    for (const text of [`อ้างถึงเลข ${fake} ของพนักงาน`, `อ้างถึง ${dashed(fake)}`, `อ้างถึง ${spaced}`]) {
      // eslint-disable-next-line no-await-in-loop
      const { res, pid, personId } = await ep.run(ep.authFor(), { reason: text });
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(/reason-contains-pid/);
      expect(JSON.stringify(res.body)).not.toContain(fake);
      expect(JSON.stringify(res.body)).not.toContain(dashed(fake));
      if (ep.name === 'POST /persons') {
        expect((await adminPool.query(`SELECT 1 FROM mdm.person WHERE pid_hash = $1`, [pidHash(pid, pepper)])).rows).toEqual([]);
      } else {
        expect((await logsFor(personId)).every((l) => !l.reason?.includes('อ้างถึง'))).toBe(true);
      }
    }
  });

  test('reason ยาวเกิน 500 -> 400 (schema); ยาว 500 พอดีผ่าน', async () => {
    expect((await ep.run(ep.authFor(), { reason: 'ก'.repeat(501) })).res.status).toBe(400);
    expect([200, 201]).toContain((await ep.run(ep.authFor(), { reason: 'ก'.repeat(500) })).res.status);
  });
});

describe('referenceDocument ที่มีเลข 13 หลัก -> 422 reference-document-contains-pid (เลขที่เอกสารต่อท้าย reason ที่เก็บถาวร)', () => {
  test.each(ENDPOINTS.filter((e) => e.name !== 'POST /persons'))('$name', async (ep) => {
    const fake = makeFakePid();
    const { res, personId } = await ep.run(ep.authFor(), { reason: 'ทดสอบเอกสารอ้างอิง', extra: { body: { referenceDocument: `เอกสารเลขที่ ${fake}` } } });
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/reference-document-contains-pid/);
    expect(JSON.stringify(res.body)).not.toContain(fake);
    expect((await logsFor(personId)).every((l) => !l.reason?.includes('เอกสารเลขที่'))).toBe(true);
  });
});

describe('deactivate: เหตุผลเก็บเป็น separation_reason และ expectedVersion (optimistic lock)', () => {
  test('separation_reason = reason ที่ตัดช่องว่างแล้ว', async () => {
    const { personId } = await provision();
    const res = await call('post', `/persons/${personId}/deactivate`, hr(), { employmentStatus: 'RETIRED', separationDate: '2025-09-30', reason: '  เกษียณอายุราชการ  ' });
    expect(res.status).toBe(200);
    const { rows } = await adminPool.query(`SELECT separation_reason FROM mdm.employment WHERE person_id = $1`, [personId]);
    expect(rows[0].separation_reason).toBe('เกษียณอายุราชการ');
  });

  test('expectedVersion ไม่ตรง -> 409 version-conflict ไม่เปลี่ยนอะไร; ตรง -> 200 และ version เพิ่ม 1', async () => {
    const { personId, version } = await provision();
    const body = { employmentStatus: 'RESIGNED', separationDate: '2025-01-01', reason: 'ลาออก' };

    const stale = await call('post', `/persons/${personId}/deactivate`, hr(), { ...body, expectedVersion: version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.type).toMatch(/version-conflict/);
    expect((await adminPool.query(`SELECT status FROM mdm.person WHERE person_id = $1`, [personId])).rows[0].status).toBe('PENDING_CLAIM');
    expect(await versionOf(personId)).toBe(version);

    const ok = await call('post', `/persons/${personId}/deactivate`, hr(), { ...body, expectedVersion: version });
    expect(ok.status).toBe(200);
    expect(await versionOf(personId)).toBe(version + 1);
  });

  test('ไม่ส่ง expectedVersion = ไม่ตรวจ (สัญญาเดิม)', async () => {
    const { personId } = await provision();
    expect((await call('post', `/persons/${personId}/deactivate`, hr(), { employmentStatus: 'RESIGNED', separationDate: '2025-01-01', reason: 'ลาออก' })).status).toBe(200);
  });
});

describe('PUT /persons/{id}/employment: outbox ใช้สถานะจริง และไม่ส่งให้บุคคลที่ยัง PENDING_CLAIM', () => {
  async function changePosition(personId, pid) {
    return call('put', `/persons/${personId}/employment`, hr(), { ...(await employmentOf(pid, { effectiveFrom: '2024-06-01' })), reason: 'ย้ายตำแหน่งตามคำสั่ง' });
  }

  test('PENDING_CLAIM: version เพิ่มแต่ไม่มี outbox EMPLOYMENT_UPDATED', async () => {
    const { personId, pid, version } = await provision();
    expect((await changePosition(personId, pid)).status).toBe(200);
    expect(await versionOf(personId)).toBe(version + 1);
    expect((await outboxFor(personId)).filter((e) => e.event_type === 'EMPLOYMENT_UPDATED')).toEqual([]);
  });

  test.each(['ACTIVE', 'INACTIVE'])('%s: payload.status ตรงกับสถานะจริง (เดิมฝัง ACTIVE เสมอ)', async (status) => {
    const { personId, pid } = await provision();
    await setStatus(personId, status);
    expect((await changePosition(personId, pid)).status).toBe(200);
    const events = (await outboxFor(personId)).filter((e) => e.event_type === 'EMPLOYMENT_UPDATED');
    expect(events).toHaveLength(1);
    expect(events[0].payload.status).toBe(status);
  });
});

describe('เส้นทางที่ "ไม่" ถูกเปลี่ยน: ต้องไม่พังสำหรับผู้เรียกที่ไม่มี role', () => {
  test('POST /claim-requests/{id}/resolve (PROVISION) ด้วย scope personnel:provision อย่างเดียว ไม่มี role -> 200 (hr-console อนุมัติคำขอ)', async () => {
    const pid = makeFakePid();
    const { rows } = await adminPool.query(
      `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
       VALUES ($1, 'ผู้ทดสอบ', 'PENDING_HR', 1, now(), now()) RETURNING claim_request_id`,
      [pidHash(pid, pepper)]
    );
    const res = await call('post', `/claim-requests/${rows[0].claim_request_id}/resolve`, { scope: 'personnel:provision', sub: uniqueSub('hr'), azp: 'hr-console' }, {
      action: 'PROVISION',
      note: 'อนุมัติ',
      employment: await employmentOf(pid),
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('LINKED');
  });

  test('POST /sync/hr/employment-batch (client นำเข้า ไม่มี role): ต้องมี reason ระดับ batch; reason ถูกเก็บเป็น reason ของทุกแถว log', async () => {
    const importer = { scope: 'personnel:import', sub: uniqueSub('svc-migrate'), azp: 'migrate-tool' };
    const pid = makeFakePid();
    const row = async () => ({ rowRef: 'r1', pid, expectedFirstNameTh: 'ก', expectedLastNameTh: 'ข', employment: await employmentOf(pid) });
    const batchReason = `HR_IMPORT batch ${crypto.randomUUID()}`;

    expect((await call('post', '/sync/hr/employment-batch', importer, { mode: 'DRY_RUN', createIfMissing: true, rows: [await row()] })).status).toBe(400);
    const blank = await call('post', '/sync/hr/employment-batch', importer, { mode: 'DRY_RUN', reason: '  ', rows: [] });
    expect(blank.status).toBe(422);
    const withPid = await call('post', '/sync/hr/employment-batch', importer, { mode: 'APPLY', reason: `batch ของ ${pid}`, createIfMissing: true, rows: [await row()] });
    expect(withPid.status).toBe(422);
    expect(JSON.stringify(withPid.body)).not.toContain(pid);
    expect((await adminPool.query(`SELECT 1 FROM mdm.person WHERE pid_hash = $1`, [pidHash(pid, pepper)])).rows).toEqual([]);

    const ok = await call('post', '/sync/hr/employment-batch', importer, { mode: 'APPLY', reason: batchReason, createIfMissing: true, rows: [await row()] });
    expect(ok.status).toBe(200);
    expect(ok.body.created).toBe(1);
    const { rows } = await adminPool.query(
      `SELECT dcl.reason, dcl.changed_by FROM audit.data_change_log dcl JOIN mdm.person p ON p.person_id = dcl.person_id WHERE p.pid_hash = $1`,
      [pidHash(pid, pepper)]
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.reason === batchReason && r.changed_by === 'HR_IMPORT')).toBe(true);
  });
});

describe('PUT /me/emergency-contacts: ลง data_change_log (ไม่เก็บค่า) + outbox CONTACT_UPDATED + version ใน transaction เดียว', () => {
  const portal = (personId) => ({ scope: 'personnel:self', sub: 'service-account-mdm-portal', azp: 'mdm-portal', personId });
  const put = (personId, contacts) => call('put', '/me/emergency-contacts', portal(personId), contacts);
  const emergencyLogs = async (personId) => (await logsFor(personId)).filter((l) => l.table_name === 'emergency_contact');
  const contactEvents = async (personId) => (await outboxFor(personId)).filter((e) => e.event_type === 'CONTACT_UPDATED');

  test('ครั้งแรก 2 ผู้ติดต่อ: log รายฟิลด์ต่อช่อง (SELF, actor = personId), ไม่มีค่า, outbox + version เพิ่ม', async () => {
    const { personId } = await provision();
    const before = await versionOf(personId);
    const res = await put(personId, [
      { fullName: 'นางสมมติ หนึ่ง', relationship: 'คู่สมรส', phone: '0811110001', priority: 1 },
      { fullName: 'นายสมมติ สอง', relationship: 'บิดา', phone: '0811110002', priority: 2 },
    ]);
    expect(res.status).toBe(200);

    const logs = await emergencyLogs(personId);
    expect(logs.map((l) => [l.field_name, l.reason]).sort()).toEqual(
      [
        ['emergency_contact.full_name', 'ผู้ติดต่อฉุกเฉินลำดับที่ 1'],
        ['emergency_contact.phone', 'ผู้ติดต่อฉุกเฉินลำดับที่ 1'],
        ['emergency_contact.relationship', 'ผู้ติดต่อฉุกเฉินลำดับที่ 1'],
        ['emergency_contact.full_name', 'ผู้ติดต่อฉุกเฉินลำดับที่ 2'],
        ['emergency_contact.phone', 'ผู้ติดต่อฉุกเฉินลำดับที่ 2'],
        ['emergency_contact.relationship', 'ผู้ติดต่อฉุกเฉินลำดับที่ 2'],
      ].sort()
    );
    expect(logs.every((l) => l.old_value === null && l.new_value === null)).toBe(true);
    expect(logs.every((l) => l.changed_by === 'SELF' && l.actor_sub === personId && l.actor_client === 'mdm-portal')).toBe(true);
    const text = JSON.stringify(await logsFor(personId));
    for (const secret of ['นางสมมติ', 'นายสมมติ', '0811110001', 'คู่สมรส', 'บิดา']) expect(text).not.toContain(secret);

    expect(await versionOf(personId)).toBe(before + 1);
    const events = await contactEvents(personId);
    expect(events).toHaveLength(1);
    expect(events[0].changed_fields.sort()).toEqual(['emergency_contact.full_name', 'emergency_contact.phone', 'emergency_contact.relationship']);
    expect(events[0].payload).toMatchObject({ personId, version: before + 1, status: 'PENDING_CLAIM' });
    expect(JSON.stringify(events[0])).not.toContain('0811110001');
  });

  test('ส่งรายการเดิมซ้ำ -> ไม่มี log/outbox/version เพิ่ม; แก้เฉพาะเบอร์ช่อง 2 -> log เดียว (phone, ช่อง 2)', async () => {
    const { personId } = await provision();
    const list = [
      { fullName: 'ผู้ติดต่อ ก', relationship: 'เพื่อน', phone: '0822220001', priority: 1 },
      { fullName: 'ผู้ติดต่อ ข', relationship: 'ญาติ', phone: '0822220002', priority: 2 },
    ];
    expect((await put(personId, list)).status).toBe(200);
    const afterFirst = { logs: (await emergencyLogs(personId)).length, events: (await contactEvents(personId)).length, version: await versionOf(personId) };

    expect((await put(personId, list)).status).toBe(200);
    expect({ logs: (await emergencyLogs(personId)).length, events: (await contactEvents(personId)).length, version: await versionOf(personId) }).toEqual(afterFirst);

    const changed = [list[0], { ...list[1], phone: '0822229999' }];
    expect((await put(personId, changed)).status).toBe(200);
    const added = (await emergencyLogs(personId)).slice(afterFirst.logs);
    expect(added.map((l) => [l.field_name, l.reason])).toEqual([['emergency_contact.phone', 'ผู้ติดต่อฉุกเฉินลำดับที่ 2']]);
    expect(await versionOf(personId)).toBe(afterFirst.version + 1);
    expect((await contactEvents(personId)).at(-1).changed_fields).toEqual(['emergency_contact.phone']);
  });

  test('ลบทั้งรายการ ([]) -> log ทุกฟิลด์ที่เคยมีค่า (ไม่เก็บค่า) และคืนรายการว่าง', async () => {
    const { personId } = await provision();
    await put(personId, [{ fullName: 'ผู้ติดต่อ ค', relationship: 'เพื่อน', phone: '0833330001', priority: 1 }]);
    const before = (await emergencyLogs(personId)).length;
    const res = await put(personId, []);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    const added = (await emergencyLogs(personId)).slice(before);
    expect(added.map((l) => l.field_name).sort()).toEqual(['emergency_contact.full_name', 'emergency_contact.phone', 'emergency_contact.relationship']);
    expect(added.every((l) => l.old_value === null && l.new_value === null)).toBe(true);
  });

  test('field_policy: emergency_contact.* ตั้ง log_values_in_audit = false (กันผู้เขียนในอนาคต)', async () => {
    const { rows } = await adminPool.query(`SELECT field_key, log_values_in_audit FROM mdm.field_policy WHERE field_key LIKE 'emergency_contact.%'`);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.log_values_in_audit === false)).toBe(true);
  });
});

describe('PUT /me/emergency-contacts: payload รูปแบบเดียวกับที่ portal ส่งจริง (JSON array, priority ตามช่อง ข้ามช่องได้)', () => {
  const portal = (personId) => ({ scope: 'personnel:self', sub: 'service-account-mdm-portal', azp: 'mdm-portal', personId });

  test('ช่อง 1 และ 3 (ช่อง 2 ว่าง): บันทึกตามช่อง คืน priority 1,3 และ log ระบุช่อง 3 ไม่ใช่ช่อง 2; ส่ง [] = ลบทั้งหมดและ log การลบ', async () => {
    const { personId } = await provision();
    const payload = [
      { fullName: 'นายสมมติ หนึ่ง', relationship: 'บิดา', phone: '0811110001', priority: 1 },
      { fullName: 'นางสมมติ สาม', relationship: 'มารดา', phone: '0811110003', priority: 3 },
    ];
    const res = await call('put', '/me/emergency-contacts', portal(personId), payload);
    expect(res.status).toBe(200);
    expect(res.body.map((c) => c.priority)).toEqual([1, 3]);
    const slots = (await logsFor(personId)).filter((l) => l.table_name === 'emergency_contact').map((l) => l.reason);
    expect(new Set(slots)).toEqual(new Set(['ผู้ติดต่อฉุกเฉินลำดับที่ 1', 'ผู้ติดต่อฉุกเฉินลำดับที่ 3']));

    const cleared = await call('put', '/me/emergency-contacts', portal(personId), []);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual([]);
    expect((await logsFor(personId)).filter((l) => l.table_name === 'emergency_contact')).toHaveLength(6 + 6);
  });
});
