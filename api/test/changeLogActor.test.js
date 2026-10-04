const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { buildTestApp } = require('./testApp');
const { makeFakePid, pidHash } = require('../src/security/pid');
const { insertFixtureOrgUnit } = require('./fixtures');
const { writeChangeLog, SYSTEM_ACTORS } = require('../src/services/changeLogWriter');

// PR-A (DPO): ทุก write path ที่เขียน audit.data_change_log ต้องได้ actor_sub/actor_client และ GET /audit/change-logs
// ต้องไม่คืนค่าของฟิลด์ที่ปกปิด/เลข 13 หลัก ข้อมูลทั้งหมดเป็นข้อมูลสมมติ (pid มาจาก makeFakePid())

let ctx;
let pepper;
let orgUnitId;

beforeAll(async () => {
  ctx = await buildTestApp();
  pepper = await ctx.vault.getPepper();
  orgUnitId = await insertFixtureOrgUnit(ctx.pool);
});

afterAll(async () => {
  await ctx.pool.end();
});

const uniqueSub = (prefix) => `${prefix}-${crypto.randomUUID()}`;

async function makePosition() {
  const { rows } = await ctx.pool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบ actor', 'GENERAL', $2) RETURNING position_id`,
    [`POS-ACTOR-${crypto.randomUUID()}`, orgUnitId]
  );
  return rows[0].position_id;
}

async function employmentBody(employeeNo, extra = {}) {
  return {
    employeeNo,
    personnelType: 'CIVIL_SERVANT',
    positionId: await makePosition(),
    orgUnitId,
    effectiveFrom: '2024-01-01',
    ...extra,
  };
}

// คืน object ที่มีแต่ .send()/.query() (ไม่ใช่ thenable) เพื่อให้ `(await api(...)).send(body)` ทำงานได้: การ await supertest Test ตรงๆ จะยิง request ทันที
async function api(method, urlPath, auth = {}) {
  const token = await ctx.auth.signToken(auth);
  const pending = (body, query) => ({
    then: (resolve, reject) => {
      let req = request(ctx.app)[method](`/api/v1${urlPath}`).set('Authorization', `Bearer ${token}`);
      if (query) req = req.query(query);
      if (body !== undefined) req = req.send(body);
      return req.then(resolve, reject);
    },
  });
  return { send: (body) => pending(body), query: (query) => pending(undefined, query) };
}

async function logsFor(personId) {
  const { rows } = await ctx.pool.query(
    `SELECT table_name, field_name, old_value, new_value, changed_by, actor_sub, actor_client, reason
     FROM audit.data_change_log WHERE person_id = $1 ORDER BY log_id`,
    [personId]
  );
  return rows;
}

function expectAllActor(rows, { sub, client, changedBy }) {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.actor_sub).toBe(sub);
    expect(row.actor_client).toBe(client);
    expect(row.changed_by).toBe(changedBy);
  }
}

// สร้างบุคคลผ่าน POST /persons ด้วย token ของ HR (ได้ทั้ง person + แถว log ชุดแรก)
async function provisionAs(hr, pid = makeFakePid()) {
  const res = await (await api('post', '/persons', { scope: 'personnel:provision personnel:read:basic', ...hr })).send({
    pid,
    expectedFirstNameTh: 'ก',
    expectedLastNameTh: 'ข',
    employment: await employmentBody(pid),
  });
  expect(res.status).toBe(201);
  return { personId: res.body.personId, pid };
}

describe('actor_sub / actor_client ของทุก write path', () => {
  const hr = { sub: uniqueSub('hr-user'), azp: 'hr-console' };

  test('POST /persons: actor = sub ของ token HR, employee_no ไม่เก็บค่า (log_values_in_audit=false)', async () => {
    const { personId } = await provisionAs(hr);
    const rows = await logsFor(personId);
    expectAllActor(rows, { sub: hr.sub, client: 'hr-console', changedBy: 'HR' });

    const employeeNo = rows.find((r) => r.field_name === 'employment.employee_no');
    expect(employeeNo).toBeDefined();
    expect(employeeNo.old_value).toBeNull();
    expect(employeeNo.new_value).toBeNull();
    // ฟิลด์อื่นของ employment ยังเก็บค่าตามปกติ
    expect(rows.find((r) => r.field_name === 'employment.personnel_type').new_value).toBe('CIVIL_SERVANT');
  });

  test('PUT employment / deactivate / reactivate: actor ตรงกับ token และ reason ถูกปกปิดเลข 13 หลัก', async () => {
    const { personId, pid } = await provisionAs(hr);
    const before = (await logsFor(personId)).length;

    const put = await (await api('put', `/persons/${personId}/employment`, { scope: 'personnel:write:employment', ...hr })).send(
      await employmentBody(pid, { effectiveFrom: '2024-06-01', levelCode: 'ชำนาญการ', referenceDocument: `คำสั่ง ${pid}` })
    );
    expect(put.status).toBe(200);

    const deactivate = await (
      await api('post', `/persons/${personId}/deactivate`, { scope: 'personnel:write:employment personnel:read:basic', ...hr })
    ).send({ employmentStatus: 'RESIGNED', separationDate: '2025-01-01', reason: `ลาออก ${pid}` });
    expect(deactivate.status).toBe(200);

    const reactivate = await (
      await api('post', `/persons/${personId}/reactivate`, { scope: 'personnel:write:employment personnel:read:basic', ...hr })
    ).send(await employmentBody(pid, { effectiveFrom: '2025-02-01', referenceDocument: 'กลับเข้าทำงาน' }));
    expect(reactivate.status).toBe(200);

    const added = (await logsFor(personId)).slice(before);
    expect(added.length).toBeGreaterThanOrEqual(4);
    expectAllActor(added, { sub: hr.sub, client: 'hr-console', changedBy: 'HR' });
    expect(added.some((r) => r.field_name === 'status' && r.new_value === 'INACTIVE')).toBe(true);
    expect(added.some((r) => r.field_name === 'status' && r.new_value === 'ACTIVE')).toBe(true);

    const everything = JSON.stringify(await logsFor(personId));
    expect(everything).not.toContain(pid);
  });

  test('POST /claim-requests/{id}/resolve (PROVISION และ LINK): actor = sub ของผู้อนุมัติ', async () => {
    const insertClaim = async (hash) => {
      const { rows } = await ctx.pool.query(
        `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
         VALUES ($1, 'ผู้ทดสอบ actor', 'PENDING_HR', 1, now(), now()) RETURNING claim_request_id`,
        [hash]
      );
      return rows[0].claim_request_id;
    };

    const pid = makeFakePid();
    const provision = await (await api('post', `/claim-requests/${await insertClaim(pidHash(pid, pepper))}/resolve`, {
      scope: 'personnel:provision',
      ...hr,
    })).send({ action: 'PROVISION', note: `อนุมัติ ${pid}`, employment: await employmentBody(pid) });
    expect(provision.status).toBe(200);
    const provisioned = await logsFor(provision.body.resolvedPersonId);
    expectAllActor(provisioned, { sub: hr.sub, client: 'hr-console', changedBy: 'HR' });
    expect(JSON.stringify(provisioned)).not.toContain(pid);

    const { rows } = await ctx.pool.query(
      `INSERT INTO mdm.person (pid_hash, status, verification_status) VALUES (NULL, 'PENDING_CLAIM', 'UNVERIFIED') RETURNING person_id`
    );
    const linkPid = makeFakePid();
    const link = await (await api('post', `/claim-requests/${await insertClaim(pidHash(linkPid, pepper))}/resolve`, {
      scope: 'personnel:provision',
      ...hr,
    })).send({ action: 'LINK', personId: rows[0].person_id, note: 'เชื่อมคำขอ' });
    expect(link.status).toBe(200);
    const linked = await logsFor(rows[0].person_id);
    expectAllActor(linked, { sub: hr.sub, client: 'hr-console', changedBy: 'HR' });
    expect(linked[0].field_name).toBe('pid_hash');
    expect(linked[0].new_value).toBeNull();
  });

  test('POST /sync/thaid: actor = system:thaid-sync, actor_client = azp ของ check-broker', async () => {
    const pid = makeFakePid();
    const { rows } = await ctx.pool.query(
      `INSERT INTO mdm.person (pid_hash, status, verification_status) VALUES ($1, 'PENDING_CLAIM', 'UNVERIFIED') RETURNING person_id`,
      [pidHash(pid, pepper)]
    );
    const res = await (await api('post', '/sync/thaid', { scope: 'sync:thaid', sub: 'check-broker', azp: 'check-broker' })).send({
      claims: {
        pid,
        titleTh: 'นาย',
        firstNameTh: 'ทดสอบ',
        lastNameTh: 'ซิงก์',
        birthDate: '1990-01-01',
        gender: 'M',
        registeredAddress: {
          houseNo: '1',
          subdistrict: { code: '520101' },
          district: { code: '5201' },
          province: { code: '52' },
          fullText: '1 ตำบลเวียงเหนือ',
        },
        ial: '2.3',
      },
      context: { appId: 'eoffice', audience: 'PERSONNEL', clientIp: '10.0.0.1', userAgent: 'jest' },
    });
    expect(res.status).toBe(200);
    expectAllActor(await logsFor(rows[0].person_id), {
      sub: SYSTEM_ACTORS.THAID_SYNC,
      client: 'check-broker',
      changedBy: 'THAID_SYNC',
    });
  });

  test('POST /sync/hr/employment-batch: APPLY เขียน log (system:hr-import) แต่ DRY_RUN ไม่ทิ้งแถวไว้', async () => {
    const importer = { sub: uniqueSub('svc-migrate'), azp: 'migrate-tool' };
    const countImportRows = async () =>
      Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM audit.data_change_log WHERE changed_by = 'HR_IMPORT'`)).rows[0].n);
    const body = async (mode, pid) => ({
      mode,
      createIfMissing: true,
      rows: [{ rowRef: 'r1', pid, expectedFirstNameTh: 'ก', expectedLastNameTh: 'ข', employment: await employmentBody(pid) }],
    });

    const before = await countImportRows();
    const pid = makeFakePid();
    const dry = await (await api('post', '/sync/hr/employment-batch', { scope: 'personnel:import', ...importer })).send(await body('DRY_RUN', pid));
    expect(dry.status).toBe(200);
    expect(await countImportRows()).toBe(before);

    const applyPid = makeFakePid();
    const apply = await (await api('post', '/sync/hr/employment-batch', { scope: 'personnel:import', ...importer })).send(await body('APPLY', applyPid));
    expect(apply.status).toBe(200);
    expect(apply.body.created).toBe(1);

    const { rows } = await ctx.pool.query(
      `SELECT dcl.field_name, dcl.new_value, dcl.actor_sub, dcl.actor_client, dcl.changed_by
       FROM audit.data_change_log dcl JOIN mdm.person p ON p.person_id = dcl.person_id
       WHERE p.pid_hash = $1`,
      [pidHash(applyPid, pepper)]
    );
    expectAllActor(rows, { sub: SYSTEM_ACTORS.HR_IMPORT, client: 'migrate-tool', changedBy: 'HR_IMPORT' });
    expect(rows.find((r) => r.field_name === 'employment.employee_no').new_value).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(applyPid);
  });

  test('PUT /me/contact และ POST /me/report-identity-issue: actor = personId ของเจ้าของข้อมูล (ไม่ใช่ service account)', async () => {
    const { personId } = await provisionAs(hr);
    const self = { scope: 'personnel:self', sub: 'service-account-mdm-portal', azp: 'mdm-portal', personId };
    const before = (await logsFor(personId)).length;

    const contact = await (await api('put', '/me/contact', self)).send({ mobilePhone: '0812345678' });
    expect(contact.status).toBe(200);
    const pid = makeFakePid();
    const report = await (await api('post', '/me/report-identity-issue', self)).send({
      fieldKey: 'identity.first_name_th',
      description: `ชื่อผิด เลขบัตร ${pid}`,
    });
    expect(report.status).toBe(202);

    const added = (await logsFor(personId)).slice(before);
    expect(added.map((r) => r.field_name).sort()).toEqual(['contact.mobile_phone', 'identity.first_name_th']);
    expectAllActor(added, { sub: personId, client: 'mdm-portal', changedBy: 'SELF' });
    expect(JSON.stringify(added)).not.toContain(pid);
  });
});

describe('changeLogWriter', () => {
  test('ไม่มี actor -> throw (ไม่เขียนแถวที่ไม่รู้ว่าใครทำ)', async () => {
    await expect(
      writeChangeLog(ctx.pool, { personId: crypto.randomUUID(), tableName: 'person', fieldName: 'status', changedBy: 'HR' })
    ).rejects.toThrow('actor');
  });

  test('ยามเฝ้า: ไม่มีไฟล์ใน api/src นอกจาก changeLogWriter.js ที่ INSERT audit.data_change_log ตรงๆ', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && /INSERT\s+INTO\s+audit\.data_change_log/i.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(path.join(__dirname, '..'), full));
        }
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    expect(offenders).toEqual([path.join('src', 'services', 'changeLogWriter.js')]);
  });
});

describe('GET /audit/change-logs', () => {
  const hr = { sub: uniqueSub('hr-audit'), azp: 'hr-console' };
  let personId;
  let pid;

  beforeAll(async () => {
    ({ personId, pid } = await provisionAs(hr));
    await (await api('post', `/persons/${personId}/deactivate`, { scope: 'personnel:write:employment personnel:read:basic', ...hr })).send({
      employmentStatus: 'RESIGNED',
      separationDate: '2025-01-01',
      reason: 'ลาออก',
    });
    await (
      await api('put', '/me/contact', { scope: 'personnel:self', sub: 'service-account-mdm-portal', azp: 'mdm-portal', personId })
    ).send({ mobilePhone: '0812345678' });
  });

  const list = async (query = {}, scope = 'audit:read') => (await api('get', '/audit/change-logs', { scope })).query(query);

  test('ไม่มี scope audit:read -> 403', async () => {
    expect((await list({}, 'personnel:read:basic')).status).toBe(403);
  });

  test('filter ด้วย actorSub / personId / changedBy / tableName', async () => {
    const byActor = await list({ actorSub: hr.sub });
    expect(byActor.status).toBe(200);
    expect(byActor.body.data.length).toBeGreaterThan(0);
    for (const e of byActor.body.data) {
      expect(e.source).toBe('PERSON');
      expect(e.actorSub).toBe(hr.sub);
      expect(e.actorClient).toBe('hr-console');
    }

    const self = await list({ personId, changedBy: 'SELF' });
    expect(self.body.data.map((e) => e.fieldKey)).toEqual(['contact.mobile_phone']);

    const table = await list({ personId, tableName: 'person' });
    expect(table.body.data.every((e) => e.tableName === 'person' && e.personId === personId)).toBe(true);
    expect(table.body.data.length).toBeGreaterThan(0);

    const none = await list({ actorSub: uniqueSub('nobody') });
    expect(none.body.data).toEqual([]);
  });

  test('ช่วงเวลา from/to', async () => {
    const future = await list({ personId, from: new Date(Date.now() + 3600_000).toISOString() });
    expect(future.body.data).toEqual([]);
    const past = await list({ personId, to: new Date(Date.now() + 3600_000).toISOString() });
    expect(past.body.data.length).toBeGreaterThan(0);
  });

  test('ปกปิดค่าของฟิลด์ CONFIDENTIAL/RESTRICTED เหลือชื่อฟิลด์ แต่ค่าของฟิลด์ที่ไม่อยู่ในกลุ่มนั้นยังแสดง', async () => {
    const res = await list({ personId, limit: 100 });
    const byField = (name) => res.body.data.find((e) => e.fieldKey === name);

    const phone = byField('contact.mobile_phone'); // CONFIDENTIAL
    expect(phone.valuesHidden).toBe(true);
    expect(phone.oldValue).toBeNull();
    expect(phone.newValue).toBeNull();

    const employeeNo = byField('employment.employee_no'); // RESTRICTED
    expect(employeeNo.valuesHidden).toBe(true);
    expect(employeeNo.newValue).toBeNull();

    const status = byField('status');
    expect(status.valuesHidden).toBe(false);
    expect(status.newValue).toBe('INACTIVE');

    expect(JSON.stringify(res.body)).not.toContain(pid);
    expect(JSON.stringify(res.body)).not.toContain('0812345678');
  });

  test('ปกปิดเลข 13 หลักที่หลุดอยู่ในค่า/reason ของแถวเก่า แม้เป็นฟิลด์ที่แสดงค่า', async () => {
    const leaked = makeFakePid();
    await ctx.pool.query(
      `INSERT INTO audit.data_change_log (person_id, table_name, field_name, old_value, new_value, changed_by, reason)
       VALUES ($1, 'person', 'status', $2, $3, 'HR', $4)`,
      [personId, JSON.stringify(leaked), JSON.stringify({ note: `เลข ${leaked}` }), `ตรวจ ${leaked.slice(0, 1)}-${leaked.slice(1, 5)}-${leaked.slice(5, 10)}-${leaked.slice(10, 12)}-${leaked.slice(12)}`]
    );
    const res = await list({ personId, limit: 100 });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(leaked);
    expect(text).not.toContain(`${leaked.slice(0, 1)}-${leaked.slice(1, 5)}`);
    expect(text).toContain('ปกปิดเลข 13 หลัก');

    const perPerson = await (await api('get', `/persons/${personId}/change-log`, { scope: 'audit:read' })).query({ limit: 100 });
    expect(JSON.stringify(perPerson.body)).not.toContain(leaked);
  });

  test('แถวที่เขียนก่อน PR-A (actor_sub NULL) -> actorSub/actorClient เป็น null', async () => {
    const marker = uniqueSub('legacy-field');
    await ctx.pool.query(
      `INSERT INTO audit.data_change_log (person_id, table_name, field_name, changed_by) VALUES ($1, 'person', $2, 'HR')`,
      [personId, marker]
    );
    const res = await list({ personId, tableName: 'person', limit: 100 });
    const entry = res.body.data.find((e) => e.fieldKey === marker);
    expect(entry.actorSub).toBeNull();
    expect(entry.actorClient).toBeNull();
  });

  test('เรียงใหม่ -> เก่า และ cursor ไม่ซ้ำ/ไม่ตกหล่น', async () => {
    const all = (await list({ personId, limit: 100 })).body.data;
    expect(all.length).toBeGreaterThan(3);
    expect(all.map((e) => e.logId)).toEqual([...all.map((e) => e.logId)].sort((a, b) => b - a));

    const seen = [];
    let cursor;
    for (let i = 0; i < 50; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const page = await list({ personId, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.body.data.map((e) => e.logId));
      cursor = page.body.page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all.map((e) => e.logId));
  });

  test('source=REFERENCE: กรองด้วย action/tableName/actorSub และไม่รับ personId/changedBy', async () => {
    const sub = uniqueSub('hr-master');
    const recordId = crypto.randomUUID();
    await ctx.pool.query(
      `INSERT INTO audit.reference_change_log (table_name, record_id, action, field_name, old_value, new_value, actor_sub, actor_client)
       VALUES ('org_unit', $1, 'CREATE', 'name_th', NULL, $2, $3, 'hr-console'),
              ('position', $1, 'UPDATE', 'title_th', $4, $2, $3, 'hr-console')`,
      [recordId, JSON.stringify('หน่วยงานทดสอบ'), sub, JSON.stringify('เดิม')]
    );

    const created = await list({ source: 'REFERENCE', actorSub: sub, action: 'CREATE' });
    expect(created.status).toBe(200);
    expect(created.body.data).toHaveLength(1);
    expect(created.body.data[0]).toMatchObject({
      source: 'REFERENCE',
      tableName: 'org_unit',
      recordId,
      action: 'CREATE',
      newValue: 'หน่วยงานทดสอบ',
      actorSub: sub,
      actorClient: 'hr-console',
    });

    const position = await list({ source: 'REFERENCE', actorSub: sub, tableName: 'position' });
    expect(position.body.data.map((e) => e.action)).toEqual(['UPDATE']);

    expect((await list({ source: 'REFERENCE', personId })).status).toBe(400);
    expect((await list({ source: 'REFERENCE', changedBy: 'HR' })).status).toBe(400);
    expect((await list({ source: 'PERSON', action: 'CREATE' })).status).toBe(400);
  });
});
