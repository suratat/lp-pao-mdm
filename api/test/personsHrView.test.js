const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { makeFakePid, maskPid } = require('../src/security/pid');
const { insertFixtureOrgUnit } = require('./fixtures');

// งาน "หน้าจัดการข้อมูลบุคคลใน hr-console (ดูอย่างเดียว)": read:inactive, ค้นชื่อเต็ม, access_log ของ search/get,
// employeeNoMasked (personnel:read:pid_masked) และ ?pidFormat=masked - ใช้ข้อมูลสมมติทั้งหมด เลขบัตรมาจาก makeFakePid()

let ctx;
let adminPool;
let orgUnitId;

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  orgUnitId = await insertFixtureOrgUnit(adminPool);
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

// ชื่อไม่ซ้ำต่อเทสต์ เพื่อกรองผลค้นหาให้เหลือเฉพาะแถวของเทสต์นั้น (DB ใช้ร่วมกับเทสต์อื่น)
function uniqueName() {
  const tag = crypto.randomBytes(4).toString('hex');
  return { first: `Fn${tag}`, last: `Ln${tag}` };
}

async function makePerson({ status = 'ACTIVE', first, last, pid = makeFakePid(), withIdentity = true } = {}) {
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, expected_first_name_th, expected_last_name_th, version)
     VALUES ($1, $2, $3, $4, $5, $6, 1)`,
    [
      personId,
      crypto.randomBytes(32).toString('hex'),
      status,
      status === 'PENDING_CLAIM' ? 'UNVERIFIED' : 'VERIFIED',
      withIdentity ? null : first,
      withIdentity ? null : last,
    ]
  );
  if (withIdentity) {
    await adminPool.query(
      `INSERT INTO mdm.person_identity (person_id, title_th, first_name_th, last_name_th, birth_date, gender, synced_at)
       VALUES ($1, 'นาย', $2, $3, '1990-01-01', 'M', now())`,
      [personId, first, last]
    );
  }
  const { rows: pos } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบ', 'GENERAL', $2) RETURNING position_id`,
    [`POS-HRV-${crypto.randomUUID()}`, orgUnitId]
  );
  await adminPool.query(
    `INSERT INTO mdm.employment
      (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
     VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, CURRENT_DATE, true, 'ACTIVE', 'test')`,
    [personId, pid, pos[0].position_id, orgUnitId]
  );
  const { ciphertext, keyId } = await ctx.vault.encrypt('mdm-pid', Buffer.from(pid, 'utf8'), personId);
  await adminPool.query('UPDATE mdm.person SET pid_enc = $2, key_id = $3 WHERE person_id = $1', [
    personId,
    Buffer.from(ciphertext, 'utf8'),
    keyId,
  ]);
  return { personId, pid };
}

const get = async (path, scope, opts = {}) => {
  const token = await ctx.auth.signToken({ scope, ...opts });
  return request(ctx.app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
};

describe('maskPid', () => {
  test('เหลือ 4 หลักท้าย รูปแบบ X-XXXX-XXXX5-67-8', () => {
    expect(maskPid('1234567890128')).toBe('X-XXXX-XXXX0-12-8');
    expect(maskPid('0000000005678')).toBe('X-XXXX-XXXX5-67-8');
  });

  test('ตัวอย่างในโจทย์: ...5678 -> X-XXXX-XXXX5-67-8', () => {
    expect(maskPid('3100000005678')).toBe('X-XXXX-XXXX5-67-8');
  });

  test('ไม่ใช่เลข 13 หลัก -> undefined (ไม่เดารูปแบบ)', () => {
    expect(maskPid('EMP-123')).toBeUndefined();
    expect(maskPid('12345')).toBeUndefined();
    expect(maskPid(undefined)).toBeUndefined();
    expect(maskPid(1234567890123)).toBeUndefined();
  });
});

describe('GET /persons: personnel:read:inactive', () => {
  test('status=INACTIVE โดยไม่มี read:inactive -> 403 insufficient-scope (ไม่ใช่ 500)', async () => {
    const res = await get('/persons?status=INACTIVE', 'personnel:read:basic');
    expect(res.status).toBe(403);
    expect(res.body.type).toMatch(/insufficient-scope/);
  });

  test('status=ACTIVE,INACTIVE (ปนกัน) โดยไม่มี read:inactive -> 403', async () => {
    const res = await get('/persons?status=ACTIVE,INACTIVE', 'personnel:read:basic');
    expect(res.status).toBe(403);
  });

  test('มี read:inactive -> เห็นผู้พ้นสภาพ', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ status: 'INACTIVE', first, last });
    const res = await get(`/persons?status=INACTIVE&q=${first}`, 'personnel:read:basic personnel:read:inactive');
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.personId)).toContain(personId);
  });

  test('ไม่ระบุ status / ระบุ PENDING_CLAIM ไม่ต้องใช้ read:inactive', async () => {
    expect((await get('/persons', 'personnel:read:basic')).status).toBe(200);
    expect((await get('/persons?status=PENDING_CLAIM', 'personnel:read:basic')).status).toBe(200);
  });
});

describe('GET /persons: ค้นชื่อเต็ม', () => {
  test('"ชื่อ นามสกุล" จับคู่ prefix ของชื่อและนามสกุล', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ first, last });
    const other = await makePerson({ first, last: `Zz${last}` }); // ชื่อเดียวกัน คนละนามสกุล

    const full = await get(`/persons?q=${encodeURIComponent(`${first} ${last}`)}`, 'personnel:read:basic');
    expect(full.status).toBe(200);
    expect(full.body.data.map((p) => p.personId)).toEqual([personId]);

    const prefix = await get(`/persons?q=${encodeURIComponent(`${first.slice(0, 5)} ${last.slice(0, 4)}`)}`, 'personnel:read:basic');
    expect(prefix.body.data.map((p) => p.personId)).toContain(personId);

    // ชื่อเดียว -> ตรงกับทั้งสองคน
    const single = await get(`/persons?q=${first}`, 'personnel:read:basic');
    expect(single.body.data.map((p) => p.personId).sort()).toEqual([personId, other.personId].sort());
  });

  test('คั่นด้วยช่องว่างหลายตัว/ต้นท้ายมีช่องว่างก็ได้', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ first, last });
    const res = await get(`/persons?q=${encodeURIComponent(`  ${first}   ${last} `)}`, 'personnel:read:basic');
    expect(res.body.data.map((p) => p.personId)).toEqual([personId]);
  });

  test('ชื่อไม่ตรง หรือสลับชื่อ/นามสกุล -> ไม่พบ', async () => {
    const { first, last } = uniqueName();
    await makePerson({ first, last });
    const swapped = await get(`/persons?q=${encodeURIComponent(`${last} ${first}`)}`, 'personnel:read:basic');
    expect(swapped.body.data).toEqual([]);
  });

  test('wildcard ของ LIKE (% _) ถือเป็นตัวอักษรธรรมดา และสตริงแปลกๆ ไม่ทำให้ query พัง', async () => {
    const { first, last } = uniqueName();
    await makePerson({ first, last });
    for (const q of ['%%', '__', `${first} %`, "x'; DROP TABLE mdm.person;--", '\\\\']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await get(`/persons?q=${encodeURIComponent(q)}`, 'personnel:read:basic');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    }
  });

  test('PENDING_CLAIM ที่ยังไม่มี person_identity ค้นได้จากชื่อที่ HR คาดไว้ (expected_*)', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ status: 'PENDING_CLAIM', first, last, withIdentity: false });
    const res = await get(`/persons?status=PENDING_CLAIM&q=${encodeURIComponent(`${first} ${last}`)}`, 'personnel:read:basic');
    expect(res.body.data.map((p) => p.personId)).toEqual([personId]);
    expect(res.body.data[0].basic.firstNameTh).toBe(first);
  });
});

describe('employeeNoMasked / ไม่ส่งเลขเต็ม', () => {
  test('มี read:pid_masked -> employeeNoMasked ปิดที่ API และไม่มีเลขเต็มทั้ง search และ get', async () => {
    const { first, last } = uniqueName();
    const pid = makeFakePid();
    const { personId } = await makePerson({ first, last, pid });
    const expected = `X-XXXX-XXXX${pid[9]}-${pid.slice(10, 12)}-${pid[12]}`;

    const search = await get(`/persons?q=${first}`, 'personnel:read:basic personnel:read:pid_masked');
    expect(search.status).toBe(200);
    expect(search.body.data[0].basic.employeeNoMasked).toBe(expected);
    expect(search.body.data[0].basic).not.toHaveProperty('employeeNo');
    expect(JSON.stringify(search.body)).not.toContain(pid);

    const one = await get(`/persons/${personId}`, 'personnel:read:basic personnel:read:pid_masked');
    expect(one.status).toBe(200);
    expect(one.body.basic.employeeNoMasked).toBe(expected);
    expect(one.headers).toBeDefined();
    expect(JSON.stringify(one.body)).not.toContain(pid);
  });

  test('ไม่มี read:pid_masked -> ไม่มี key employeeNoMasked (และไม่มี employeeNo)', async () => {
    const { first, last } = uniqueName();
    const pid = makeFakePid();
    const { personId } = await makePerson({ first, last, pid });

    const search = await get(`/persons?q=${first}`, 'personnel:read:basic');
    expect(search.body.data[0].basic).not.toHaveProperty('employeeNoMasked');
    expect(search.body.data[0].basic).not.toHaveProperty('employeeNo');

    const one = await get(`/persons/${personId}`, 'personnel:read:basic personnel:read:employment');
    expect(one.body.basic).not.toHaveProperty('employeeNoMasked');
    expect(JSON.stringify(one.body)).not.toContain(pid);
  });

  test('employeeNo เลขเต็มยังต้องมี read:pid เหมือนเดิม (ไม่ส่ง pidFormat = พฤติกรรมเดิม)', async () => {
    const { first, last } = uniqueName();
    const pid = makeFakePid();
    const { personId } = await makePerson({ first, last, pid });
    const res = await get(`/persons/${personId}`, 'personnel:read:basic personnel:read:pid personnel:read:pid_masked');
    expect(res.body.basic.employeeNo).toBe(pid);
    expect(res.body.basic.employeeNoMasked).toBe(maskPid(pid));
  });

  test('?pidFormat=masked ทั้ง search/get/getEmployment: ไม่ส่งเลขเต็มแม้ token มี read:pid (แต่ยังได้ employeeNoMasked)', async () => {
    const { first, last } = uniqueName();
    const pid = makeFakePid();
    const { personId } = await makePerson({ first, last, pid });
    const scope = 'personnel:read:basic personnel:read:employment personnel:read:pid personnel:read:pid_masked';

    const search = await get(`/persons?q=${first}&pidFormat=masked`, scope);
    const one = await get(`/persons/${personId}?pidFormat=masked`, scope);
    const history = await get(`/persons/${personId}/employment?pidFormat=masked`, scope);

    for (const res of [search, one, history]) {
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(pid);
    }
    expect(search.body.data[0].basic.employeeNoMasked).toBe(maskPid(pid));
    expect(one.body.basic.employeeNoMasked).toBe(maskPid(pid));
    expect(one.body.employment).not.toHaveProperty('employeeNo');
    expect(history.body[0]).not.toHaveProperty('employeeNo');
  });

  test('pidFormat ที่ไม่ใช่ masked -> 400', async () => {
    const res = await get('/persons?pidFormat=full', 'personnel:read:basic');
    expect(res.status).toBe(400);
  });

  test('access_log ของ fields_returned ไม่มี employeeNo เมื่อใช้ pidFormat=masked', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ first, last });
    await get(`/persons/${personId}?pidFormat=masked`, 'personnel:read:basic personnel:read:pid personnel:read:pid_masked');
    const { rows } = await adminPool.query(
      'SELECT fields_returned FROM audit.access_log WHERE subject_person_id = $1 ORDER BY accessed_at DESC LIMIT 1',
      [personId]
    );
    expect(rows[0].fields_returned).toContain('basic.employeeNoMasked');
    expect(rows[0].fields_returned).not.toContain('basic.employeeNo');
  });
});

describe('access_log ของ GET /persons และ GET /persons/{id}', () => {
  test('GET /persons/{id} บันทึก access_log พร้อม actor_sub และ fields_returned ที่ส่งจริง', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ first, last });
    await get(`/persons/${personId}`, 'personnel:read:basic', { sub: 'hr-user-1', azp: 'hr-console' });
    const { rows } = await adminPool.query(
      'SELECT actor_sub, keycloak_client_id, http_method, response_status, fields_returned FROM audit.access_log WHERE subject_person_id = $1',
      [personId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_sub: 'hr-user-1', keycloak_client_id: 'hr-console', http_method: 'GET', response_status: 200 });
    expect(rows[0].fields_returned).toContain('basic.firstNameTh');
  });

  test('GET /persons บันทึกหนึ่งแถวต่อบุคคลที่อยู่ในผลลัพธ์ (และไม่บันทึกคนที่ไม่อยู่ในผล)', async () => {
    const { first, last } = uniqueName();
    const a = await makePerson({ first, last });
    const b = await makePerson({ first, last: `${last}2` });
    const outside = await makePerson({ first: `Out${first}`, last });

    const res = await get(`/persons?q=${first}`, 'personnel:read:basic personnel:read:pid_masked', { sub: 'hr-user-2', azp: 'hr-console' });
    expect(res.body.data).toHaveLength(2);

    const { rows } = await adminPool.query(
      'SELECT subject_person_id, actor_sub, endpoint, fields_returned FROM audit.access_log WHERE subject_person_id = ANY($1::uuid[])',
      [[a.personId, b.personId, outside.personId]]
    );
    expect(rows.map((r) => r.subject_person_id).sort()).toEqual([a.personId, b.personId].sort());
    for (const row of rows) {
      expect(row.actor_sub).toBe('hr-user-2');
      // query string (q = ชื่อคน) ต้องไม่ถูกเก็บลงคอลัมน์ endpoint
      expect(row.endpoint).toBe('/api/v1/persons');
      expect(row.fields_returned).toContain('basic.employeeNoMasked');
    }
  });

  test('GET /persons/{id}?pidFormat=masked -> endpoint ใน access_log ไม่มี query string', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ first, last });
    await get(`/persons/${personId}?pidFormat=masked`, 'personnel:read:basic');
    const { rows } = await adminPool.query('SELECT endpoint FROM audit.access_log WHERE subject_person_id = $1', [personId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe(`/api/v1/persons/${personId}`);
  });

  test('q ที่ใช้ + เป็นช่องว่าง (form-encoding) ค้น "ชื่อ นามสกุล" ได้ เหมือน %20', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ first, last });
    for (const sep of ['+', '%20']) {
      const res = await get(`/persons?q=${first}${sep}${last}`, 'personnel:read:basic');
      expect(res.status).toBe(200);
      expect(res.body.data.map((p) => p.personId)).toEqual([personId]);
    }
  });

  test('พารามิเตอร์อื่นที่ไม่ใช่ q ยังปฏิเสธ + ดิบ (updatedSince=...+07:00 -> 400)', async () => {
    const res = await get('/persons?updatedSince=2026-10-08T17:00:00+07:00', 'personnel:read:basic');
    expect(res.status).toBe(400);
  });

  test('ผลค้นหาว่าง -> ไม่เขียน access_log และตอบ 200', async () => {
    const res = await get(`/persons?q=${encodeURIComponent('ไม่มีใครชื่อนี้เลย')}`, 'personnel:read:basic');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /persons/{id}/pid: เหตุผลและผู้กดถูกบันทึก', () => {
  test('เขียน access_log พร้อม justification และ actor_sub ของผู้กด, ตอบ no-store', async () => {
    const { first, last } = uniqueName();
    const pid = makeFakePid();
    const { personId } = await makePerson({ first, last, pid });
    const justification = 'ตรวจสอบเอกสารประกอบการบรรจุ';

    const res = await get(`/persons/${personId}/pid?justification=${encodeURIComponent(justification)}`, 'personnel:read:pid', {
      sub: 'hr-user-3',
      azp: 'hr-console',
    });
    expect(res.status).toBe(200);
    expect(res.body.pid).toBe(pid);
    expect(res.headers['cache-control']).toBe('private, no-store');

    const { rows } = await adminPool.query(
      'SELECT actor_sub, justification, fields_returned, endpoint FROM audit.access_log WHERE subject_person_id = $1',
      [personId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_sub).toBe('hr-user-3');
    expect(rows[0].justification).toBe(justification);
    expect(rows[0].fields_returned).toEqual(['pid']);
    // justification อยู่ในคอลัมน์ของตัวเอง - endpoint ต้องไม่มี query string (ไม่งั้นเหตุผลซ้ำอยู่ในสองที่และรั่วไปกับ log ที่อ่าน endpoint)
    expect(rows[0].endpoint).toBe(`/api/v1/persons/${personId}/pid`);
    expect(rows[0].endpoint).not.toContain('?');
    expect(rows[0].endpoint).not.toContain(encodeURIComponent(justification));
    expect(JSON.stringify(rows[0])).not.toContain(pid);
  });

  test('เหตุผลสั้นกว่า 10 ตัวอักษร -> 400 และไม่เขียน access_log', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ first, last });
    const res = await get(`/persons/${personId}/pid?justification=short`, 'personnel:read:pid');
    expect(res.status).toBe(400);
    const { rows } = await adminPool.query('SELECT 1 FROM audit.access_log WHERE subject_person_id = $1', [personId]);
    expect(rows).toHaveLength(0);
  });

  test('ไม่มี read:pid -> 403', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ first, last });
    const res = await get(`/persons/${personId}/pid?justification=${encodeURIComponent('เหตุผลที่ยาวพอสมควร')}`, 'personnel:read:basic personnel:read:pid_masked');
    expect(res.status).toBe(403);
  });
});
