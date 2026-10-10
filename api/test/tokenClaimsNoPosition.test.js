const crypto = require('node:crypto');
const request = require('supertest');
const { buildTestApp } = require('./testApp');
const { makeFakePid, pidHash } = require('../src/security/pid');
const { insertFixtureOrgUnit } = require('./fixtures');

// POST /sync/thaid -> tokenClaims.positionTitle: บุคลากรที่ employment ไม่มีเลขที่ตำแหน่ง (พนักงานจ้าง/จ้างเหมา/ฝ่ายการเมือง/อื่นๆ)
// ต้องได้ 200 โดย "ไม่มีคีย์ positionTitle" (ไม่ส่ง null - สเปกกำหนด positionTitle เป็น string) ครอบคลุมทั้งสามเส้นทางที่เรียก
// buildTokenClaims: handleClaim (CLAIMED), handleActiveSync (NO_CHANGE และ UPDATED) ข้อมูลทดสอบเป็นข้อมูลสังเคราะห์ทั้งหมด

let ctx;
let pepper;
let syncToken;
let importToken;
let fixtureOrgUnitId;
let fixtureOrgUnitCode;

beforeAll(async () => {
  ctx = await buildTestApp();
  pepper = await ctx.vault.getPepper();
  syncToken = await ctx.auth.signToken({ scope: 'sync:thaid', sub: 'check-broker' });
  importToken = await ctx.auth.signToken({ scope: 'personnel:import' });
  fixtureOrgUnitId = await insertFixtureOrgUnit(ctx.pool);
  ({
    rows: [{ code: fixtureOrgUnitCode }],
  } = await ctx.pool.query(`SELECT code FROM mdm.org_unit WHERE org_unit_id = $1`, [fixtureOrgUnitId]));
});

afterAll(async () => {
  await ctx.pool.end();
});

function syncThaid(body) {
  return request(ctx.app).post('/api/v1/sync/thaid').set('Authorization', `Bearer ${syncToken}`).send(body);
}

function baseClaims(pid, overrides = {}) {
  return {
    pid,
    titleTh: 'นาย',
    firstNameTh: 'ทดสอบ',
    lastNameTh: 'ระบบ',
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

const baseContext = () => ({ appId: 'eoffice', audience: 'PERSONNEL', clientIp: '10.0.0.1', userAgent: 'jest' });

async function importPerson(pid, employment) {
  const res = await request(ctx.app)
    .post('/api/v1/sync/hr/employment-batch')
    .set('Authorization', `Bearer ${importToken}`)
    .send({
      mode: 'APPLY',
      reason: 'ทดสอบระบบ (เหตุผลสมมติ)',
      createIfMissing: true,
      rows: [
        {
          rowRef: 'r1',
          pid,
          expectedFirstNameTh: 'ทดสอบ',
          expectedLastNameTh: 'ระบบ',
          // employeeNo = pid เสมอ เหมือน migrate/src/mapping/toImportRow.js
          employment: { employeeNo: pid, orgUnitId: fixtureOrgUnitId, effectiveFrom: '2024-01-01', ...employment },
        },
      ],
    });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ created: 1, errors: [] });
}

async function findPersonIdByPid(pid) {
  const { rows } = await ctx.pool.query(`SELECT person_id FROM mdm.person WHERE pid_hash = $1`, [pidHash(pid, pepper)]);
  return rows[0].person_id;
}

async function fetchPersonState(personId) {
  const { rows } = await ctx.pool.query(
    `SELECT status, verification_status, claimed_at, thaid_verified_at, pid_enc, key_id, version
     FROM mdm.person WHERE person_id = $1`,
    [personId]
  );
  return rows[0];
}

async function fetchEmploymentRows(personId) {
  const { rows } = await ctx.pool.query(
    `SELECT employment_id, is_current, employee_no, personnel_type, position_id, org_unit_id,
            effective_from, effective_to, employment_status, updated_by
     FROM mdm.employment WHERE person_id = $1 ORDER BY employment_id`,
    [personId]
  );
  return rows;
}

// ต้องไม่มีคีย์ positionTitle เลย (ไม่ใช่ null) และยังมี claims อื่นครบ
function expectTokenClaimsWithoutPosition(res, personId) {
  expect(res.status).toBe(200);
  const { tokenClaims } = res.body;
  expect(tokenClaims).not.toHaveProperty('positionTitle');
  expect(tokenClaims.sub).toBe(personId);
  expect(tokenClaims.orgUnitCode).toBe(fixtureOrgUnitCode);
  expect(tokenClaims.employeeNo).toBeUndefined();
}

describe('tokenClaims ของบุคลากรที่ไม่มีเลขที่ตำแหน่ง ต้องได้ 200 และไม่มี positionTitle', () => {
  const NO_POSITION_TYPES = [
    ['GENERAL_EMPLOYEE', {}],
    ['OTHER', { jobTitleText: 'งานทดสอบ' }], // OTHER เลือกได้ระหว่างตำแหน่งกับ jobTitleText (ที่นี่ใช้ jobTitleText)
    ['OUTSOURCE_INDIVIDUAL', {}],
    ['POLITICAL_APPOINTEE', {}],
  ];

  test.each(NO_POSITION_TYPES)(
    '%s: claim ครั้งแรก (CLAIMED), ล็อกอินซ้ำ (NO_CHANGE) และเมื่อข้อมูลเปลี่ยน (UPDATED) ได้ 200 ทุกครั้ง',
    async (personnelType, extraEmployment) => {
      const pid = makeFakePid();
      await importPerson(pid, { personnelType, ...extraEmployment });
      const personId = await findPersonIdByPid(pid);

      const claimed = await syncThaid({ claims: baseClaims(pid), context: baseContext() });
      expect(claimed.body.result).toBe('CLAIMED');
      expectTokenClaimsWithoutPosition(claimed, personId);

      const unchanged = await syncThaid({ claims: baseClaims(pid), context: baseContext() });
      expect(unchanged.body.result).toBe('NO_CHANGE');
      expectTokenClaimsWithoutPosition(unchanged, personId);

      const updated = await syncThaid({ claims: baseClaims(pid, { lastNameTh: 'ระบบใหม่' }), context: baseContext() });
      expect(updated.body.result).toBe('UPDATED');
      expectTokenClaimsWithoutPosition(updated, personId);
    }
  );

  test('person ที่สร้างผ่าน POST /persons (GENERAL_EMPLOYEE, scope personnel:provision + personnel:read:basic) ล็อกอิน ThaID แล้ว ACTIVE/VERIFIED, pid_enc ถอดรหัสได้, employment ไม่ถูกแตะ', async () => {
    const pid = makeFakePid();
    // ต้องมี personnel:read:basic ด้วย: response ของ POST /persons ผ่านตัวกรองฟิลด์ตาม scope และสเปกบังคับให้มี `basic`
    const provisionToken = await ctx.auth.signToken({ scope: 'personnel:provision personnel:read:basic', roles: ['hr_master_data_admin'] });

    const provisioned = await request(ctx.app)
      .post('/api/v1/persons')
      .set('Authorization', `Bearer ${provisionToken}`)
      .send({ reason: 'ทดสอบระบบ (เหตุผลสมมติ)',
        pid,
        expectedFirstNameTh: 'ทดสอบ',
        expectedLastNameTh: 'ระบบ',
        employment: {
          employeeNo: pid,
          personnelType: 'GENERAL_EMPLOYEE',
          orgUnitId: fixtureOrgUnitId,
          effectiveFrom: '2024-01-01',
        },
      });
    expect(provisioned.status).toBe(201);

    const personId = await findPersonIdByPid(pid);
    const personBefore = await fetchPersonState(personId);
    expect(personBefore.status).toBe('PENDING_CLAIM');
    expect(personBefore.verification_status).toBe('UNVERIFIED');
    expect(personBefore.claimed_at).toBeNull();
    expect(personBefore.thaid_verified_at).toBeNull();
    expect(personBefore.pid_enc).not.toBeNull(); // provisionPerson เข้ารหัสไว้แล้วตอนสร้าง
    const employmentBefore = await fetchEmploymentRows(personId);
    expect(employmentBefore).toHaveLength(1);
    expect(employmentBefore[0].is_current).toBe(true);

    const res = await syncThaid({ claims: baseClaims(pid), context: baseContext() });

    expect(res.body.result).toBe('CLAIMED');
    expect(res.body.personId).toBe(personId);
    expectTokenClaimsWithoutPosition(res, personId);
    expect(JSON.stringify(res.body)).not.toContain(pid);

    const personAfter = await fetchPersonState(personId);
    expect(personAfter.status).toBe('ACTIVE');
    expect(personAfter.verification_status).toBe('VERIFIED');
    expect(personAfter.claimed_at).not.toBeNull();
    expect(personAfter.thaid_verified_at).not.toBeNull();
    expect(personAfter.version).toBe(personBefore.version + 1);
    expect(personAfter.key_id).toBe('vault:transit:mdm-pid:v1');
    const decrypted = await ctx.vault.decrypt('mdm-pid', personAfter.pid_enc.toString('utf8'), personId);
    expect(decrypted.toString('utf8')).toBe(pid);

    // employment เดิมไม่ถูกแตะ: employment_id/is_current/ตำแหน่ง/สังกัด เหมือนก่อน claim และไม่มีแถวใหม่
    expect(await fetchEmploymentRows(personId)).toEqual(employmentBefore);
  });
});

describe('tokenClaims ของบุคลากรที่มีตำแหน่ง ยังได้ positionTitle เหมือนเดิม', () => {
  test('CIVIL_SERVANT มีเลขที่ตำแหน่ง: CLAIMED และ NO_CHANGE ได้ positionTitle = ชื่อตำแหน่ง', async () => {
    const pid = makeFakePid();
    const titleTh = `ตำแหน่งทดสอบ ${crypto.randomUUID()}`;
    const {
      rows: [{ position_id: positionId }],
    } = await ctx.pool.query(
      `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
       VALUES ($1, $2, 'GENERAL', $3) RETURNING position_id`,
      [`POS-TEST-${crypto.randomUUID()}`, titleTh, fixtureOrgUnitId]
    );
    await importPerson(pid, { personnelType: 'CIVIL_SERVANT', positionId });
    const personId = await findPersonIdByPid(pid);

    for (const expectedResult of ['CLAIMED', 'NO_CHANGE']) {
      const res = await syncThaid({ claims: baseClaims(pid), context: baseContext() });
      expect(res.status).toBe(200);
      expect(res.body.result).toBe(expectedResult);
      expect(res.body.tokenClaims).toMatchObject({ sub: personId, orgUnitCode: fixtureOrgUnitCode, positionTitle: titleTh });
    }
  });
});
