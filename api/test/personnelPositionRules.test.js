const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { makeFakePid, pidHash } = require('../src/security/pid');
const { insertFixtureOrgUnit } = require('./fixtures');
const { POSITION_RULES, positionRuleFor } = require('../src/services/personnelPositionRules');

// กฎเลขที่ตำแหน่งตามประเภทบุคลากร (ยืนยันโดยเจ้าของระบบ) - เขียนซ้ำเป็น literal ตรงนี้โดยตั้งใจ: ถ้าใครแก้ตารางกฎใน
// โค้ด test นี้ต้องล้มจนกว่าจะแก้ "สเปก" ตรงนี้อย่างจงใจด้วย
const SPEC = {
  REQUIRED: ['CIVIL_SERVANT', 'TEACHER', 'PERMANENT_EMPLOYEE', 'TRANSFERRED_HEALTH'],
  FORBIDDEN: ['CONTRACT_EMPLOYEE', 'GENERAL_EMPLOYEE', 'EXPERT_EMPLOYEE', 'OUTSOURCE_INDIVIDUAL', 'POLITICAL_APPOINTEE'],
  OPTIONAL: ['OTHER'],
};
const ALL_TYPES = [...SPEC.REQUIRED, ...SPEC.FORBIDDEN, ...SPEC.OPTIONAL];

let ctx;
let adminPool;
let pepper;
let orgUnitId;

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  pepper = await ctx.vault.getPepper();
  orgUnitId = await insertFixtureOrgUnit(adminPool);
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

// คืน object ธรรมดา (ไม่ใช่ supertest Request ตรงๆ): Request เป็น thenable - ถ้า async function คืนมันออกมา จะถูก await
// ส่ง request ทันทีทั้งที่ยังไม่มี body
const api = async (method, url, scope) => {
  const token = await ctx.auth.signToken({ scope });
  return { send: (body) => request(ctx.app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body) };
};

async function makePosition() {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบกฎประเภทบุคลากร', 'GENERAL', $2) RETURNING position_id`,
    [`POS-RULE-${crypto.randomUUID()}`, orgUnitId]
  );
  return rows[0].position_id;
}

async function makePerson(status = 'ACTIVE') {
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version, deleted_at)
     VALUES ($1, $2, $3, 'VERIFIED', 1, ${status === 'INACTIVE' ? 'now()' : 'NULL'})`,
    [personId, crypto.randomBytes(32).toString('hex'), status]
  );
  return personId;
}

const employmentCount = async (personId) =>
  (await adminPool.query(`SELECT count(*)::int AS n FROM mdm.employment WHERE person_id = $1`, [personId])).rows[0].n;

async function employmentBody(personnelType, withPosition) {
  return {
    employeeNo: `EMP-RULE-${crypto.randomUUID()}`,
    personnelType,
    orgUnitId,
    ...(withPosition ? { positionId: await makePosition() } : {}),
    effectiveFrom: '2024-01-01',
  };
}

// ผลที่คาด: FORBIDDEN+มีตำแหน่ง -> 422 position-not-allowed; REQUIRED+ไม่มี -> 422 position-required; นอกนั้นผ่าน
function expectation(personnelType, withPosition) {
  const rule = positionRuleFor(personnelType);
  if (rule === 'FORBIDDEN' && withPosition) return { ok: false, type: /position-not-allowed$/ };
  if (rule === 'REQUIRED' && !withPosition) return { ok: false, type: /position-required$/ };
  return { ok: true };
}

const MATRIX = ALL_TYPES.flatMap((type) => [
  [type, true],
  [type, false],
]);

describe('ตารางกฎ (โมดูล)', () => {
  test('ตรงกับสเปกที่เจ้าของระบบยืนยันทุกประเภท', () => {
    for (const [rule, types] of Object.entries(SPEC)) {
      for (const type of types) expect([type, POSITION_RULES[type]]).toEqual([type, rule]);
    }
    expect(Object.keys(POSITION_RULES).sort()).toEqual([...ALL_TYPES].sort());
  });

  test('ทุกโค้ดใน mdm.personnel_type จริงต้องมีกฎกำกับ (มีประเภทใหม่ -> ต้องตัดสินกฎก่อน)', async () => {
    const { rows } = await adminPool.query(`SELECT code FROM mdm.personnel_type ORDER BY code`);
    const missing = rows.map((r) => r.code).filter((code) => !(code in POSITION_RULES));
    expect(missing).toEqual([]);
  });

  test('ประเภทที่ไม่อยู่ในตาราง = OPTIONAL (ไม่บล็อก)', () => {
    expect(positionRuleFor('SOME_NEW_TYPE')).toBe('OPTIONAL');
    expect(positionRuleFor(undefined)).toBe('OPTIONAL');
  });
});

describe('PUT /persons/{id}/employment - ทุกประเภท × มี/ไม่มีตำแหน่ง', () => {
  test.each(MATRIX)('%s, มีตำแหน่ง=%s', async (personnelType, withPosition) => {
    const personId = await makePerson();
    const exp = expectation(personnelType, withPosition);
    const res = await (await api('put', `/persons/${personId}/employment`, 'personnel:write:employment')).send(
      await employmentBody(personnelType, withPosition)
    );

    if (exp.ok) {
      expect(res.status).toBe(200);
      expect(await employmentCount(personId)).toBe(1);
    } else {
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(exp.type);
      expect(await employmentCount(personId)).toBe(0); // ไม่เขียนอะไรเลย
    }
  });

  test('บุคลากรที่มี employment อยู่แล้ว: เปลี่ยนเป็นประเภทห้ามมีตำแหน่งโดยยังส่ง positionId เดิม -> 422 และ employment เดิมไม่ถูกปิด', async () => {
    const personId = await makePerson();
    const positionId = await makePosition();
    const base = { employeeNo: `EMP-RULE-${crypto.randomUUID()}`, orgUnitId, effectiveFrom: '2024-01-01' };
    const first = await (await api('put', `/persons/${personId}/employment`, 'personnel:write:employment')).send({ ...base, personnelType: 'CIVIL_SERVANT', positionId });
    expect(first.status).toBe(200);

    const res = await (await api('put', `/persons/${personId}/employment`, 'personnel:write:employment')).send({ ...base, personnelType: 'GENERAL_EMPLOYEE', positionId, effectiveFrom: '2025-01-01' });
    expect(res.status).toBe(422);
    const { rows } = await adminPool.query(`SELECT personnel_type, is_current FROM mdm.employment WHERE person_id = $1`, [personId]);
    expect(rows).toEqual([{ personnel_type: 'CIVIL_SERVANT', is_current: true }]);
  });

  test('พนักงานจ้างที่ไม่ส่ง positionId เลย (สิ่งที่ฟอร์มส่งเมื่อช่องถูก disable) -> ผ่าน', async () => {
    const personId = await makePerson();
    const ok = await (await api('put', `/persons/${personId}/employment`, 'personnel:write:employment')).send({
      employeeNo: `EMP-RULE-${crypto.randomUUID()}`, personnelType: 'CONTRACT_EMPLOYEE', orgUnitId, effectiveFrom: '2024-01-01',
    });
    expect(ok.status).toBe(200);
  });
});

describe('POST /persons (provision) - ครอบคลุมด้วยกฎเดียวกัน และไม่สร้าง person ค้างเมื่อผิดกฎ', () => {
  test.each([
    ['POLITICAL_APPOINTEE', true, 422, /position-not-allowed$/],
    ['OUTSOURCE_INDIVIDUAL', true, 422, /position-not-allowed$/],
    ['PERMANENT_EMPLOYEE', false, 422, /position-required$/],
    ['POLITICAL_APPOINTEE', false, 201, null],
    ['PERMANENT_EMPLOYEE', true, 201, null],
    ['OTHER', true, 201, null],
    ['OTHER', false, 201, null],
  ])('%s มีตำแหน่ง=%s -> %s', async (personnelType, withPosition, status, typeRe) => {
    const pid = makeFakePid();
    const res = await (await api('post', '/persons', 'personnel:read:basic personnel:provision')).send({
      pid,
      expectedFirstNameTh: 'ทดสอบ',
      expectedLastNameTh: 'กฎตำแหน่ง',
      employment: await employmentBody(personnelType, withPosition),
    });
    expect(res.status).toBe(status);
    const { rows } = await adminPool.query(`SELECT 1 FROM mdm.person WHERE pid_hash = $1`, [pidHash(pid, pepper)]);
    if (typeRe) {
      expect(res.body.type).toMatch(typeRe);
      expect(rows).toHaveLength(0); // transaction ถูก rollback ทั้งก้อน
    } else {
      expect(rows).toHaveLength(1);
    }
  });
});

describe('POST /claim-requests/{id}/resolve (PROVISION)', () => {
  async function makeClaim() {
    const { rows } = await adminPool.query(
      `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
       VALUES ($1, 'นายทดสอบ กฎตำแหน่ง', 'PENDING_HR', 1, now(), now()) RETURNING claim_request_id`,
      [crypto.randomBytes(32).toString('hex')]
    );
    return rows[0].claim_request_id;
  }
  const resolve = async (claimId, personnelType, withPosition) =>
    (await api('post', `/claim-requests/${claimId}/resolve`, 'personnel:provision')).send({
      action: 'PROVISION',
      employment: await employmentBody(personnelType, withPosition),
    });

  test('พนักงานจ้างพร้อมตำแหน่ง -> 422 (ไม่ใช่ 500) และ claim ยังรอ HR อยู่', async () => {
    const claimId = await makeClaim();
    const res = await resolve(claimId, 'GENERAL_EMPLOYEE', true);
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/position-not-allowed$/);
    const { rows } = await adminPool.query(`SELECT status FROM mdm.claim_request WHERE claim_request_id = $1`, [claimId]);
    expect(rows[0].status).toBe('PENDING_HR');
  });

  test('ข้าราชการไม่มีตำแหน่ง -> 422 position-required', async () => {
    const res = await resolve(await makeClaim(), 'CIVIL_SERVANT', false);
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/position-required$/);
  });

  test('ลูกจ้างประจำพร้อมตำแหน่ง / พนักงานจ้างไม่มีตำแหน่ง -> ผ่าน', async () => {
    expect((await resolve(await makeClaim(), 'PERMANENT_EMPLOYEE', true)).status).toBe(200);
    expect((await resolve(await makeClaim(), 'CONTRACT_EMPLOYEE', false)).status).toBe(200);
  });
});

describe('POST /persons/{id}/reactivate', () => {
  const reactivate = async (personId, personnelType, withPosition) =>
    (await api('post', `/persons/${personId}/reactivate`, 'personnel:read:basic personnel:write:employment')).send(
      await employmentBody(personnelType, withPosition)
    );

  test('ผิดกฎ -> 422 และบุคคลยัง INACTIVE', async () => {
    const personId = await makePerson('INACTIVE');
    const res = await reactivate(personId, 'EXPERT_EMPLOYEE', true);
    expect(res.status).toBe(422);
    const { rows } = await adminPool.query(`SELECT status FROM mdm.person WHERE person_id = $1`, [personId]);
    expect(rows[0].status).toBe('INACTIVE');
  });

  test('ถูกกฎ -> 200', async () => {
    const personId = await makePerson('INACTIVE');
    expect((await reactivate(personId, 'TRANSFERRED_HEALTH', true)).status).toBe(200);
  });
});

describe('POST /sync/hr/employment-batch (DRY_RUN) - รายงานเป็น error รายแถวด้วยรหัสของกฎ', () => {
  test('แถวที่ผิดกฎได้ POSITION_NOT_ALLOWED / POSITION_REQUIRED ส่วนแถวถูกกฎนับตามปกติ', async () => {
    const mk = async (rowRef, personnelType, withPosition) => ({
      rowRef,
      pid: makeFakePid(),
      expectedFirstNameTh: 'ทดสอบ',
      expectedLastNameTh: 'นำเข้า',
      employment: await employmentBody(personnelType, withPosition),
    });
    const res = await (await api('post', '/sync/hr/employment-batch', 'personnel:import')).send({
      mode: 'DRY_RUN',
      createIfMissing: true,
      rows: [
        await mk('bad-forbidden', 'POLITICAL_APPOINTEE', true),
        await mk('bad-required', 'TEACHER', false),
        await mk('ok-forbidden', 'GENERAL_EMPLOYEE', false),
        await mk('ok-required', 'CIVIL_SERVANT', true),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.errors.map((e) => [e.rowRef, e.code]).sort()).toEqual([
      ['bad-forbidden', 'POSITION_NOT_ALLOWED'],
      ['bad-required', 'POSITION_REQUIRED'],
    ]);
    expect(res.body.created).toBe(2);
  });
});
