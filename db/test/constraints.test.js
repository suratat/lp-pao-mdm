const crypto = require('node:crypto');
const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

// หมายเหตุ: ค่านี้เป็นสตริง hex สุ่มจำลอง pid_hash (ผลลัพธ์ของ HMAC) ไม่ใช่เลขบัตรประชาชนจริงหรือรูปแบบ pid
// การสร้าง pid ปลอมที่ผ่าน checksum จริง (makeFakePid()) จะถูก implement ใน T3 (security/pid.js)
function fakePidHash() {
  return crypto.randomBytes(32).toString('hex');
}

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

async function insertPerson(overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO mdm.person (pid_hash, status, verification_status)
     VALUES ($1, $2, $3) RETURNING person_id`,
    [
      overrides.pid_hash === undefined ? fakePidHash() : overrides.pid_hash,
      overrides.status ?? 'ACTIVE',
      overrides.verification_status ?? 'VERIFIED',
    ]
  );
  return rows[0].person_id;
}

describe('UNIQUE (pid_hash) ของ mdm.person', () => {
  test('ปฏิเสธ pid_hash ซ้ำ', async () => {
    const pidHash = fakePidHash();
    await insertPerson({ pid_hash: pidHash });
    await expect(insertPerson({ pid_hash: pidHash })).rejects.toThrow(/duplicate key value/);
  });

  test('อนุญาตหลายแถวที่ pid_hash เป็น NULL (ยังไม่ผูก pid)', async () => {
    await expect(insertPerson({ pid_hash: null })).resolves.toEqual(expect.any(String));
    await expect(insertPerson({ pid_hash: null })).resolves.toEqual(expect.any(String));
  });
});

describe('partial UNIQUE (employee_no) WHERE is_current ของ mdm.employment', () => {
  const ORG_UNIT_ID = '00000000-0000-0000-0000-000000000002';
  const POSITION_A = '00000000-0000-0000-0000-000000000101';
  const POSITION_B = '00000000-0000-0000-0000-000000000102';

  async function insertCurrentEmployment(personId, employeeNo, positionId) {
    return pool.query(
      `INSERT INTO mdm.employment
        (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
       VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, CURRENT_DATE, true, 'ACTIVE', 'test')`,
      [personId, employeeNo, positionId, ORG_UNIT_ID]
    );
  }

  test('ปฏิเสธ employee_no ซ้ำระหว่างสองคนที่ is_current พร้อมกัน', async () => {
    const personA = await insertPerson();
    const personB = await insertPerson();
    const employeeNo = `EMP-DUP-${Date.now()}`;

    await insertCurrentEmployment(personA, employeeNo, POSITION_A);
    await expect(insertCurrentEmployment(personB, employeeNo, POSITION_B)).rejects.toThrow(
      /duplicate key value/
    );
  });
});

describe('EXCLUDE ตำแหน่งซ้อนทับ (position_id + ช่วงวันที่) ของ mdm.employment', () => {
  const ORG_UNIT_ID = '00000000-0000-0000-0000-000000000002';
  const POSITION_ID = '00000000-0000-0000-0000-000000000103';

  async function insertEmployment(personId, employeeNo, from, to) {
    return pool.query(
      `INSERT INTO mdm.employment
        (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, effective_to, is_current, employment_status, updated_by)
       VALUES ($1, $2, 'GENERAL_EMPLOYEE', $3, $4, $5, $6, false, 'ACTIVE', 'test')`,
      [personId, employeeNo, POSITION_ID, ORG_UNIT_ID, from, to]
    );
  }

  test('ปฏิเสธช่วงเวลาซ้อนทับกันบนตำแหน่งเดียวกัน (ทั้งคู่ ACTIVE)', async () => {
    const personA = await insertPerson();
    const personB = await insertPerson();

    await insertEmployment(personA, `EMP-OVL-A-${Date.now()}`, '2024-01-01', '2024-06-30');
    await expect(
      insertEmployment(personB, `EMP-OVL-B-${Date.now()}`, '2024-03-01', '2024-09-30')
    ).rejects.toThrow(/conflicting key value/);
  });

  test('อนุญาตช่วงเวลาที่ไม่ซ้อนทับกันบนตำแหน่งเดียวกัน', async () => {
    const personA = await insertPerson();
    const personB = await insertPerson();

    await insertEmployment(personA, `EMP-OK-A-${Date.now()}`, '2020-01-01', '2020-06-30');
    await expect(
      insertEmployment(personB, `EMP-OK-B-${Date.now()}`, '2020-07-01', '2020-12-31')
    ).resolves.toBeDefined();
  });

  // พนักงานจ้าง/จ้างเหมาบริการรายบุคคลไม่มีเลขที่ตำแหน่ง (position_id เป็น NULL ได้ตั้งแต่
  // 1700000000031) - ต้องยืนยันด้วย test จริงว่า Postgres ไม่ apply EXCLUDE กับแถวที่ position_id เป็น
  // NULL (operator "=" คืน NULL ไม่ใช่ TRUE เมื่อเทียบกับ NULL เหมือน UNIQUE ที่ปล่อยผ่านหลาย NULL ได้)
  // ไม่ใช่การสันนิษฐาน
  test('อนุญาตหลายแถวที่ position_id เป็น NULL ช่วงเวลาซ้อนทับกันได้ (EXCLUDE ไม่ apply กับ NULL)', async () => {
    const personA = await insertPerson();
    const personB = await insertPerson();

    async function insertNoPositionEmployment(personId, employeeNo, from, to) {
      return pool.query(
        `INSERT INTO mdm.employment
          (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, effective_to, is_current, employment_status, updated_by)
         VALUES ($1, $2, 'GENERAL_EMPLOYEE', NULL, $3, $4, $5, false, 'ACTIVE', 'test')`,
        [personId, employeeNo, ORG_UNIT_ID, from, to]
      );
    }

    await insertNoPositionEmployment(personA, `EMP-NOPOS-A-${Date.now()}`, '2024-01-01', '2024-06-30');
    await expect(
      insertNoPositionEmployment(personB, `EMP-NOPOS-B-${Date.now()}`, '2024-03-01', '2024-09-30')
    ).resolves.toBeDefined();
  });
});

describe('audit append-only (trigger ปฏิเสธ UPDATE/DELETE)', () => {
  test('audit.thaid_sync_event', async () => {
    const { rows } = await pool.query(
      `INSERT INTO audit.thaid_sync_event (trigger, result) VALUES ('LOGIN', 'UNMATCHED') RETURNING sync_event_id`
    );
    const id = rows[0].sync_event_id;
    await expect(
      pool.query(`UPDATE audit.thaid_sync_event SET result = 'CLAIMED' WHERE sync_event_id = $1`, [id])
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`DELETE FROM audit.thaid_sync_event WHERE sync_event_id = $1`, [id])
    ).rejects.toThrow(/append-only/);
  });

  test('audit.data_change_log', async () => {
    const personId = await insertPerson();
    const { rows } = await pool.query(
      `INSERT INTO audit.data_change_log (person_id, table_name, field_name, changed_by)
       VALUES ($1, 'person_identity', 'first_name_th', 'THAID_SYNC') RETURNING log_id`,
      [personId]
    );
    const id = rows[0].log_id;
    await expect(
      pool.query(`UPDATE audit.data_change_log SET reason = 'x' WHERE log_id = $1`, [id])
    ).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit.data_change_log WHERE log_id = $1`, [id])).rejects.toThrow(
      /append-only/
    );
  });

  test('audit.access_log (ผ่าน partition รายเดือน)', async () => {
    // ใช้ access_id (bigserial คีย์เดียวก็เพียงพอ) แทนคู่คีย์ (access_id, accessed_at) เพื่อเลี่ยงปัญหาความละเอียด
    // ของ timestamptz ที่หายไปเมื่อผ่าน JS Date แล้วส่งกลับเป็นพารามิเตอร์ WHERE (ไม่งั้นจะไม่ match แถวใดเลย)
    const personId = await insertPerson();
    const { rows } = await pool.query(
      `INSERT INTO audit.access_log (subject_person_id, actor_type, endpoint, http_method, response_status)
       VALUES ($1, 'SERVICE', '/persons/x', 'GET', 200) RETURNING access_id`,
      [personId]
    );
    const { access_id } = rows[0];
    await expect(
      pool.query(`UPDATE audit.access_log SET response_status = 500 WHERE access_id = $1`, [access_id])
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`DELETE FROM audit.access_log WHERE access_id = $1`, [access_id])
    ).rejects.toThrow(/append-only/);
  });
});
