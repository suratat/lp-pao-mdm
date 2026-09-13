const crypto = require('node:crypto');
const request = require('supertest');
const { buildTestApp } = require('./testApp');
const { makeFakePid, pidHash } = require('../src/security/pid');
const { FIXTURE_ORG_UNIT_ID } = require('../src/constants');

let ctx;
let pepper;
let syncToken;

beforeAll(async () => {
  ctx = await buildTestApp();
  pepper = await ctx.vault.getPepper();
  syncToken = await ctx.auth.signToken({ scope: 'sync:thaid', sub: 'check-broker' });
});

afterAll(async () => {
  await ctx.pool.end();
});

function syncThaid(body) {
  return request(ctx.app).post('/api/v1/sync/thaid').set('Authorization', `Bearer ${syncToken}`).send(body);
}

async function insertPerson(overrides = {}) {
  const pid = overrides.pid || makeFakePid();
  const hash = pidHash(pid, pepper);
  const { rows } = await ctx.pool.query(
    `INSERT INTO mdm.person (pid_hash, status, verification_status, expected_first_name_th, expected_last_name_th)
     VALUES ($1, $2, $3, $4, $5) RETURNING person_id, version`,
    [
      hash,
      overrides.status ?? 'PENDING_CLAIM',
      overrides.verificationStatus ?? 'UNVERIFIED',
      overrides.expectedFirstNameTh ?? null,
      overrides.expectedLastNameTh ?? null,
    ]
  );
  return { pid, hash, personId: rows[0].person_id };
}

// สร้างตำแหน่งใหม่ต่อคน (ไม่ใช้ position เดียวกันซ้ำ) เพราะ mdm.employment มี EXCLUDE constraint
// (T1) ห้ามสองคนครองตำแหน่งเดียวกันซ้อนช่วงเวลากัน - ใช้ FIXTURE_POSITION_ID ร่วมกันหลายคนจะชนกันเอง
async function insertEmployment(personId, employeeNo) {
  const { rows } = await ctx.pool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบ', 'GENERAL', $2) RETURNING position_id`,
    [`POS-TEST-${crypto.randomUUID()}`, FIXTURE_ORG_UNIT_ID]
  );
  await ctx.pool.query(
    `INSERT INTO mdm.employment
      (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
     VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, CURRENT_DATE, true, 'ACTIVE', 'test')`,
    [personId, employeeNo, rows[0].position_id, FIXTURE_ORG_UNIT_ID]
  );
}

function baseClaims(pid, overrides = {}) {
  return {
    pid,
    titleTh: 'นาย',
    firstNameTh: 'ทดสอบ',
    lastNameTh: 'ระบบ',
    birthDate: '1990-01-01',
    gender: 'M',
    registeredAddress: {
      houseNo: '99/1',
      subdistrict: { code: '520101' },
      district: { code: '5201' },
      province: { code: '52' },
      fullText: '99/1 ตำบลเวียงเหนือ อำเภอเมืองลำปาง จังหวัดลำปาง',
    },
    ial: '2.3',
    ...overrides,
  };
}

function baseContext(overrides = {}) {
  return { appId: 'eoffice', audience: 'PERSONNEL', clientIp: '10.0.0.1', userAgent: 'jest', ...overrides };
}

function assertNoPidLeak(res, pid) {
  expect(JSON.stringify(res.body)).not.toContain(pid);
}

describe('POST /sync/thaid - UNMATCHED', () => {
  test('audience=PERSONNEL: 202 UNMATCHED + สร้าง claim_request', async () => {
    const pid = makeFakePid();
    const hash = pidHash(pid, pepper);

    const res = await syncThaid({ claims: baseClaims(pid), context: baseContext() });

    expect(res.status).toBe(202);
    expect(res.body.result).toBe('UNMATCHED');
    expect(res.body.personId).toBeNull();
    assertNoPidLeak(res, pid);

    const claim = await ctx.pool.query(`SELECT * FROM mdm.claim_request WHERE pid_hash = $1`, [hash]);
    expect(claim.rows).toHaveLength(1);
    expect(claim.rows[0].status).toBe('PENDING_HR');
    expect(claim.rows[0].attempt_count).toBe(1);

    const syncEvent = await ctx.pool.query(
      `SELECT * FROM audit.thaid_sync_event WHERE person_id IS NULL AND result = 'UNMATCHED' ORDER BY occurred_at DESC LIMIT 1`
    );
    expect(syncEvent.rows).toHaveLength(1);
  });

  test('เรียกซ้ำด้วย pid เดิม -> attempt_count เพิ่ม ไม่สร้างแถวใหม่', async () => {
    const pid = makeFakePid();
    const hash = pidHash(pid, pepper);

    await syncThaid({ claims: baseClaims(pid), context: baseContext() });
    await syncThaid({ claims: baseClaims(pid), context: baseContext() });

    const claim = await ctx.pool.query(`SELECT * FROM mdm.claim_request WHERE pid_hash = $1`, [hash]);
    expect(claim.rows).toHaveLength(1);
    expect(claim.rows[0].attempt_count).toBe(2);
  });

  test('audience=CITIZEN: 202 UNMATCHED แต่ไม่สร้าง claim_request', async () => {
    const pid = makeFakePid();
    const hash = pidHash(pid, pepper);

    const res = await syncThaid({ claims: baseClaims(pid), context: baseContext({ audience: 'CITIZEN' }) });

    expect(res.status).toBe(202);
    expect(res.body.result).toBe('UNMATCHED');

    const claim = await ctx.pool.query(`SELECT * FROM mdm.claim_request WHERE pid_hash = $1`, [hash]);
    expect(claim.rows).toHaveLength(0);
  });
});

describe('POST /sync/thaid - CLAIMED', () => {
  test('PENDING_CLAIM -> ACTIVE, เติม identity/photo, data_change_log null->ค่าใหม่, PERSON_CLAIMED', async () => {
    const { pid, personId } = await insertPerson({
      expectedFirstNameTh: 'ทดสอบ',
      expectedLastNameTh: 'ระบบ',
    });
    await insertEmployment(personId, 'EMP-CLAIM-001');

    const onePixelPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const res = await syncThaid({
      claims: baseClaims(pid, { photo: { mimeType: 'image/png', base64: onePixelPngBase64 } }),
      context: baseContext(),
    });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('CLAIMED');
    expect(res.body.personId).toBe(personId);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.verificationStatus).toBe('VERIFIED');
    expect(res.body.nameMismatchWithHr).toBe(false);
    expect(res.body.changedFields).toEqual(expect.arrayContaining(['identity.first_name_th', 'identity.last_name_th']));
    expect(res.body.tokenClaims.employeeNo).toBe('EMP-CLAIM-001');
    expect(res.body.tokenClaims.orgUnitCode).toBeTruthy();
    assertNoPidLeak(res, pid);

    const person = await ctx.pool.query(`SELECT * FROM mdm.person WHERE person_id = $1`, [personId]);
    expect(person.rows[0].status).toBe('ACTIVE');
    expect(person.rows[0].version).toBe(2);
    expect(person.rows[0].key_id).toBe('vault:transit:mdm-pid:v1');
    expect(person.rows[0].pid_enc).not.toBeNull();

    // pid_enc ต้องถอดรหัสกลับมาตรงกับ pid เดิมได้ (ผูก context = person_id)
    const ciphertext = person.rows[0].pid_enc.toString('utf8');
    const decrypted = await ctx.vault.decrypt('mdm-pid', ciphertext, personId);
    expect(decrypted.toString('utf8')).toBe(pid);

    const identity = await ctx.pool.query(`SELECT * FROM mdm.person_identity WHERE person_id = $1`, [personId]);
    expect(identity.rows[0].first_name_th).toBe('ทดสอบ');
    expect(identity.rows[0].reg_house_no).toBe('99/1');

    const changeLog = await ctx.pool.query(
      `SELECT field_name, old_value, new_value FROM audit.data_change_log WHERE person_id = $1`,
      [personId]
    );
    expect(changeLog.rows.length).toBeGreaterThan(0);
    const firstNameChange = changeLog.rows.find((r) => r.field_name === 'identity.first_name_th');
    expect(firstNameChange.old_value).toBeNull();
    expect(firstNameChange.new_value).toBe('ทดสอบ'); // jsonb ถูก pg แปลงกลับเป็นค่า JS ให้แล้วตอนอ่าน

    const photo = await ctx.pool.query(`SELECT * FROM mdm.person_photo WHERE person_id = $1 AND is_current = true`, [
      personId,
    ]);
    expect(photo.rows).toHaveLength(1);

    const events = await ctx.pool.query(
      `SELECT event_type FROM integration.outbox_event WHERE person_id = $1 ORDER BY sequence`,
      [personId]
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(expect.arrayContaining(['PERSON_CLAIMED', 'PHOTO_UPDATED']));
  });

  test('ชื่อจาก ThaID ไม่ตรงกับที่ HR คาด -> nameMismatchWithHr=true แต่ยัง claim สำเร็จ (ThaID เป็นหลัก)', async () => {
    const { pid, personId } = await insertPerson({
      expectedFirstNameTh: 'ชื่อที่ HR คาดไว้',
      expectedLastNameTh: 'นามสกุลที่ HR คาดไว้',
    });
    await insertEmployment(personId, 'EMP-MISMATCH-001');

    const res = await syncThaid({ claims: baseClaims(pid), context: baseContext() });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('CLAIMED');
    expect(res.body.nameMismatchWithHr).toBe(true);

    const person = await ctx.pool.query(`SELECT status FROM mdm.person WHERE person_id = $1`, [personId]);
    expect(person.rows[0].status).toBe('ACTIVE');
  });
});

describe('POST /sync/thaid - NO_CHANGE / UPDATED (person ACTIVE)', () => {
  test('claims เหมือนเดิมทุกประการ -> NO_CHANGE, version ไม่เพิ่ม', async () => {
    const { pid, personId } = await insertPerson({ expectedFirstNameTh: 'ทดสอบ', expectedLastNameTh: 'ระบบ' });
    await insertEmployment(personId, 'EMP-NOCHANGE-001');

    const claims = baseClaims(pid);
    await syncThaid({ claims, context: baseContext() }); // CLAIM ก่อน (version -> 2)

    const res = await syncThaid({ claims, context: baseContext() });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('NO_CHANGE');
    expect(res.body.changedFields).toEqual([]);

    const person = await ctx.pool.query(`SELECT version FROM mdm.person WHERE person_id = $1`, [personId]);
    expect(person.rows[0].version).toBe(2);
  });

  test('เปลี่ยนฟิลด์ที่ส่งมา -> UPDATED, version+1, data_change_log, IDENTITY_UPDATED; ฟิลด์ที่ไม่ได้ส่งไม่ถูกเขียนทับ', async () => {
    const { pid, personId } = await insertPerson({ expectedFirstNameTh: 'ทดสอบ', expectedLastNameTh: 'ระบบ' });
    await insertEmployment(personId, 'EMP-UPDATE-001');

    await syncThaid({ claims: baseClaims(pid, { titleEn: 'Mr.' }), context: baseContext() });

    const updatedClaims = baseClaims(pid); // ไม่มี titleEn รอบนี้ - ต้องไม่ถูกเขียนทับเป็น null
    updatedClaims.lastNameTh = 'ระบบใหม่';

    const res = await syncThaid({ claims: updatedClaims, context: baseContext() });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('UPDATED');
    expect(res.body.changedFields).toEqual(['identity.last_name_th']);

    const person = await ctx.pool.query(`SELECT version FROM mdm.person WHERE person_id = $1`, [personId]);
    expect(person.rows[0].version).toBe(3);

    const identity = await ctx.pool.query(
      `SELECT last_name_th, title_en FROM mdm.person_identity WHERE person_id = $1`,
      [personId]
    );
    expect(identity.rows[0].last_name_th).toBe('ระบบใหม่');
    expect(identity.rows[0].title_en).toBe('Mr.'); // ฟิลด์ที่ไม่ได้ส่งรอบล่าสุดต้องยังอยู่ค่าเดิม

    // สองแถว: ตอน CLAIM (null -> 'ระบบ') และตอน UPDATE (ระบบ -> ระบบใหม่) - เอาแถวล่าสุด
    const changeLog = await ctx.pool.query(
      `SELECT field_name, old_value, new_value FROM audit.data_change_log
       WHERE person_id = $1 AND field_name = 'identity.last_name_th'
       ORDER BY changed_at DESC LIMIT 1`,
      [personId]
    );
    expect(changeLog.rows[0].old_value).toBe('ระบบ');
    expect(changeLog.rows[0].new_value).toBe('ระบบใหม่');

    const events = await ctx.pool.query(
      `SELECT event_type FROM integration.outbox_event WHERE person_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [personId]
    );
    expect(events.rows[0].event_type).toBe('IDENTITY_UPDATED');
  });

  test('person อยู่ในสถานะ STALE -> trigger บันทึกเป็น REVERIFY และล้าง reverify_requested_at/reverify_due_at', async () => {
    const { pid, personId } = await insertPerson({ expectedFirstNameTh: 'ทดสอบ', expectedLastNameTh: 'ระบบ' });
    await insertEmployment(personId, 'EMP-STALE-001');

    const claims = baseClaims(pid);
    await syncThaid({ claims, context: baseContext() }); // claim

    await ctx.pool.query(
      `UPDATE mdm.person SET verification_status = 'STALE', reverify_requested_at = now(), reverify_due_at = now() + interval '30 days'
       WHERE person_id = $1`,
      [personId]
    );

    const res = await syncThaid({ claims, context: baseContext() });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('NO_CHANGE');
    expect(res.body.verificationStatus).toBe('VERIFIED');

    const person = await ctx.pool.query(
      `SELECT verification_status, reverify_requested_at, reverify_due_at FROM mdm.person WHERE person_id = $1`,
      [personId]
    );
    expect(person.rows[0].verification_status).toBe('VERIFIED');
    expect(person.rows[0].reverify_requested_at).toBeNull();
    expect(person.rows[0].reverify_due_at).toBeNull();

    const syncEvent = await ctx.pool.query(
      `SELECT trigger FROM audit.thaid_sync_event WHERE person_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [personId]
    );
    expect(syncEvent.rows[0].trigger).toBe('REVERIFY');
  });
});

describe('POST /sync/thaid - REJECTED_INACTIVE', () => {
  test('person INACTIVE -> 403 REJECTED_INACTIVE', async () => {
    const { pid, personId } = await insertPerson({ status: 'INACTIVE', verificationStatus: 'VERIFIED' });

    const res = await syncThaid({ claims: baseClaims(pid), context: baseContext() });

    expect(res.status).toBe(403);
    expect(res.body.result).toBe('REJECTED_INACTIVE');
    assertNoPidLeak(res, pid);

    const syncEvent = await ctx.pool.query(
      `SELECT result FROM audit.thaid_sync_event WHERE person_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [personId]
    );
    expect(syncEvent.rows[0].result).toBe('REJECTED_INACTIVE');
  });
});

describe('POST /sync/thaid - การตรวจสอบ pid', () => {
  test('400 เมื่อ pid ไม่ผ่าน checksum mod 11 (รูปแบบ 13 หลักถูกต้องแต่เลขตรวจสอบผิด)', async () => {
    const pid = makeFakePid();
    const corrupted = pid.slice(0, 12) + String((Number(pid[12]) + 1) % 10);

    const res = await syncThaid({ claims: baseClaims(corrupted), context: baseContext() });

    expect(res.status).toBe(400);
    expect(res.type).toBe('application/problem+json');
    assertNoPidLeak(res, corrupted);
  });

  test('400 เมื่อ pid ไม่ใช่ 13 หลัก (express-openapi-validator ปฏิเสธตาม pattern ของสเปกเอง)', async () => {
    const res = await syncThaid({ claims: baseClaims('123'), context: baseContext() });
    expect(res.status).toBe(400);
  });
});
