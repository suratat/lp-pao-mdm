const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { makeFakePid, pidHash } = require('../src/security/pid');
const { insertFixtureOrgUnit } = require('./fixtures');

let ctx;
let adminPool;
let pepper;
let fixtureOrgUnitId;

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  pepper = await ctx.vault.getPepper();
  fixtureOrgUnitId = await insertFixtureOrgUnit(adminPool);
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

async function makePosition() {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบนำเข้า', 'GENERAL', $2) RETURNING position_id`,
    [`POS-IMPORT-${crypto.randomUUID()}`, fixtureOrgUnitId]
  );
  return rows[0].position_id;
}

function importBatch(body, scope = 'personnel:import') {
  return ctx.auth.signToken({ scope }).then((token) =>
    request(ctx.app).post('/api/v1/sync/hr/employment-batch').set('Authorization', `Bearer ${token}`).send(body)
  );
}

describe('POST /sync/hr/employment-batch - DRY_RUN', () => {
  test('DRY_RUN สร้าง person ปลอมได้ในการตรวจสอบแต่ไม่บันทึกจริง (ROLLBACK)', async () => {
    const pid = makeFakePid();
    const positionId = await makePosition();

    const res = await importBatch({
      mode: 'DRY_RUN',
      createIfMissing: true,
      rows: [
        {
          rowRef: 'row-1',
          pid,
          expectedFirstNameTh: 'ทดสอบ',
          expectedLastNameTh: 'นำเข้า',
          employment: {
            employeeNo: `EMP-DRY-${crypto.randomUUID()}`,
            personnelType: 'CIVIL_SERVANT',
            positionId,
            orgUnitId: fixtureOrgUnitId,
            effectiveFrom: '2024-01-01',
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'DRY_RUN', total: 1, created: 1, updated: 0, unchanged: 0, errors: [] });
    expect(JSON.stringify(res.body)).not.toContain(pid);

    const hash = pidHash(pid, pepper);
    const { rows } = await adminPool.query(`SELECT 1 FROM mdm.person WHERE pid_hash = $1`, [hash]);
    expect(rows).toHaveLength(0); // ยืนยันว่าไม่มีการบันทึกจริง
  });
});

describe('POST /sync/hr/employment-batch - APPLY', () => {
  test('สร้างคนใหม่เป็น PENDING_CLAIM พร้อม pid_hash/pid_enc ตาม §3.4', async () => {
    const pid = makeFakePid();
    const positionId = await makePosition();

    const res = await importBatch({
      mode: 'APPLY',
      createIfMissing: true,
      rows: [
        {
          rowRef: 'row-1',
          pid,
          expectedFirstNameTh: 'ทดสอบ',
          expectedLastNameTh: 'นำเข้า',
          employment: {
            employeeNo: `EMP-APPLY-${crypto.randomUUID()}`,
            personnelType: 'CIVIL_SERVANT',
            positionId,
            orgUnitId: fixtureOrgUnitId,
            effectiveFrom: '2024-01-01',
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'APPLY', total: 1, created: 1, updated: 0, unchanged: 0, errors: [] });

    const hash = pidHash(pid, pepper);
    const { rows } = await adminPool.query(
      `SELECT person_id, status, pid_enc, key_id FROM mdm.person WHERE pid_hash = $1`,
      [hash]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PENDING_CLAIM');
    expect(rows[0].pid_enc).not.toBeNull();
    expect(rows[0].key_id).toBe('vault:transit:mdm-pid:v1');

    const decrypted = await ctx.vault.decrypt('mdm-pid', Buffer.from(rows[0].pid_enc).toString('utf8'), rows[0].person_id);
    expect(decrypted.toString('utf8')).toBe(pid);
  });

  test('createIfMissing=false และไม่พบคน -> error PERSON_NOT_FOUND แถวอื่นยังสำเร็จ', async () => {
    const missingPid = makeFakePid();
    const okPid = makeFakePid();
    const positionId = await makePosition();

    const res = await importBatch({
      mode: 'APPLY',
      createIfMissing: false,
      rows: [
        { rowRef: 'missing', pid: missingPid },
        {
          rowRef: 'ok',
          pid: okPid,
          expectedFirstNameTh: 'ก',
          expectedLastNameTh: 'ข',
        },
      ],
    });

    // createIfMissing=false และไม่มี employment ก็ยังต้อง PERSON_NOT_FOUND ทั้งคู่เพราะยังไม่เคย provision
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ rowRef: 'missing', code: 'PERSON_NOT_FOUND' })])
    );
  });

  test('pid checksum ผิด -> error PID_CHECKSUM_INVALID เฉพาะแถวนั้น แถวอื่นยังสำเร็จ', async () => {
    const goodPid = makeFakePid();
    const badPid = `${goodPid.slice(0, 12)}${(Number(goodPid[12]) + 1) % 10}`;
    const positionId = await makePosition();

    const res = await importBatch({
      mode: 'APPLY',
      createIfMissing: true,
      rows: [
        { rowRef: 'bad', pid: badPid, expectedFirstNameTh: 'ก', expectedLastNameTh: 'ข' },
        {
          rowRef: 'good',
          pid: goodPid,
          expectedFirstNameTh: 'ก',
          expectedLastNameTh: 'ข',
          employment: {
            employeeNo: `EMP-GOOD-${crypto.randomUUID()}`,
            personnelType: 'CIVIL_SERVANT',
            positionId,
            orgUnitId: fixtureOrgUnitId,
            effectiveFrom: '2024-01-01',
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toEqual([{ rowRef: 'bad', code: 'PID_CHECKSUM_INVALID', message: expect.any(String) }]);
    expect(JSON.stringify(res.body)).not.toContain(badPid);
    expect(JSON.stringify(res.body)).not.toContain(goodPid);
  });

  test('org_unit_id ไม่มีอยู่จริง -> error ORG_UNIT_NOT_FOUND', async () => {
    const pid = makeFakePid();
    const positionId = await makePosition();

    const res = await importBatch({
      mode: 'APPLY',
      createIfMissing: true,
      rows: [
        {
          rowRef: 'bad-org',
          pid,
          expectedFirstNameTh: 'ก',
          expectedLastNameTh: 'ข',
          employment: {
            employeeNo: `EMP-BADORG-${crypto.randomUUID()}`,
            personnelType: 'CIVIL_SERVANT',
            positionId,
            orgUnitId: '00000000-0000-0000-0000-000000000999',
            effectiveFrom: '2024-01-01',
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([
      { rowRef: 'bad-org', code: 'ORG_UNIT_NOT_FOUND', message: expect.any(String) },
    ]);

    // ยืนยันว่า person ไม่ถูกสร้างค้างไว้ (ธุรกรรมของแถวนี้ rollback ทั้งหมด)
    const hash = pidHash(pid, pepper);
    const { rows } = await adminPool.query(`SELECT 1 FROM mdm.person WHERE pid_hash = $1`, [hash]);
    expect(rows).toHaveLength(0);
  });

  test('เรียกซ้ำด้วยข้อมูลเดิมทุกประการ -> unchanged (ไม่ใช่ updated)', async () => {
    const pid = makeFakePid();
    const positionId = await makePosition();
    const employment = {
      employeeNo: `EMP-SAME-${crypto.randomUUID()}`,
      personnelType: 'CIVIL_SERVANT',
      positionId,
      orgUnitId: fixtureOrgUnitId,
      effectiveFrom: '2024-01-01',
    };
    const row = { rowRef: 'r1', pid, expectedFirstNameTh: 'ก', expectedLastNameTh: 'ข', employment };

    const first = await importBatch({ mode: 'APPLY', createIfMissing: true, rows: [row] });
    expect(first.body.created).toBe(1);

    const second = await importBatch({ mode: 'APPLY', createIfMissing: true, rows: [row] });
    expect(second.body.created).toBe(0);
    expect(second.body.unchanged).toBe(1);
    expect(second.body.updated).toBe(0);
  });

  test('เปลี่ยนตำแหน่งของคนเดิม -> updated และปิด employment เดิม (effective_to) เปิดใหม่', async () => {
    const pid = makeFakePid();
    const positionA = await makePosition();
    const positionB = await makePosition();
    const employeeNo = `EMP-MOVE-${crypto.randomUUID()}`;

    await importBatch({
      mode: 'APPLY',
      createIfMissing: true,
      rows: [
        {
          rowRef: 'r1',
          pid,
          expectedFirstNameTh: 'ก',
          expectedLastNameTh: 'ข',
          employment: {
            employeeNo,
            personnelType: 'CIVIL_SERVANT',
            positionId: positionA,
            orgUnitId: fixtureOrgUnitId,
            effectiveFrom: '2024-01-01',
          },
        },
      ],
    });

    const res = await importBatch({
      mode: 'APPLY',
      createIfMissing: true,
      rows: [
        {
          rowRef: 'r1',
          pid,
          employment: {
            employeeNo,
            personnelType: 'CIVIL_SERVANT',
            positionId: positionB,
            orgUnitId: fixtureOrgUnitId,
            effectiveFrom: '2024-06-01',
          },
        },
      ],
    });

    expect(res.body.updated).toBe(1);

    const hash = pidHash(pid, pepper);
    const person = await adminPool.query(`SELECT person_id FROM mdm.person WHERE pid_hash = $1`, [hash]);
    const history = await adminPool.query(
      `SELECT position_id, is_current, effective_to FROM mdm.employment WHERE person_id = $1 ORDER BY effective_from`,
      [person.rows[0].person_id]
    );
    expect(history.rows).toHaveLength(2);
    expect(history.rows[0].position_id).toBe(positionA);
    expect(history.rows[0].is_current).toBe(false);
    expect(history.rows[0].effective_to).toBe('2024-06-01');
    expect(history.rows[1].position_id).toBe(positionB);
    expect(history.rows[1].is_current).toBe(true);
  });
});
