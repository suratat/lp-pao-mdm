const crypto = require('node:crypto');
const { FIXTURE_PERSON_ID, FIXTURE_ORG_UNIT_ID, FIXTURE_POSITION_ID } = require('../src/constants');

// สร้าง person ตัวอย่างจริงใน DB (ไม่ใช่ค่าสมมติล้วนแบบ stub) เพื่อให้ access_log middleware เขียนแถวได้จริง
// (subject_person_id มี FK ไป mdm.person) pid_hash เป็น hex สุ่ม ไม่ใช่เลขบัตรจริงหรือแม้แต่ pid ปลอมที่ต้อง reverse ได้
async function insertFixturePerson(pool) {
  await pool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, thaid_verified_at, claimed_at, version)
     VALUES ($1, $2, 'ACTIVE', 'VERIFIED', now(), now(), 1)
     ON CONFLICT (person_id) DO NOTHING`,
    [FIXTURE_PERSON_ID, crypto.randomBytes(32).toString('hex')]
  );

  await pool.query(
    `INSERT INTO mdm.person_identity (person_id, title_th, first_name_th, last_name_th, birth_date, gender, synced_at)
     VALUES ($1, 'นาย', 'ทดสอบ', 'ระบบ', '1990-01-01', 'M', now())
     ON CONFLICT (person_id) DO NOTHING`,
    [FIXTURE_PERSON_ID]
  );

  await pool.query(
    `INSERT INTO mdm.person_contact (person_id, mobile_phone, email_personal, same_as_registered, updated_by, updated_at)
     VALUES ($1, '0812345678', 'test.system@example.com', true, 'SELF', now())
     ON CONFLICT (person_id) DO NOTHING`,
    [FIXTURE_PERSON_ID]
  );

  await pool.query(
    `INSERT INTO mdm.emergency_contact (person_id, full_name, relationship, phone, priority)
     VALUES ($1, 'นางสมมติ ระบบ', 'คู่สมรส', '0898765432', 1)
     ON CONFLICT (person_id, priority) DO NOTHING`,
    [FIXTURE_PERSON_ID]
  );

  // หมายเหตุ: personnel_type ใช้ค่าภาษาไทยตาม CHECK constraint ของ mdm.employment (T1) ซึ่งยังไม่ตรงกับ
  // enum ภาษาอังกฤษ (CIVIL_SERVANT ฯลฯ) ใน OpenAPI PersonnelType - ต้องทำ mapping ตอน implement service จริง (T3+)
  await pool.query(
    `INSERT INTO mdm.employment
      (person_id, employee_no, personnel_type, position_id, org_unit_id, level_code, appointed_date, effective_from, is_current, employment_status, updated_by)
     VALUES ($1, 'EMP-0001', 'ข้าราชการ อบจ.', $2, $3, 'ชำนาญการ', '2015-10-01', '2015-10-01', true, 'ACTIVE', 'test')
     ON CONFLICT DO NOTHING`,
    [FIXTURE_PERSON_ID, FIXTURE_POSITION_ID, FIXTURE_ORG_UNIT_ID]
  );
}

module.exports = { insertFixturePerson, FIXTURE_PERSON_ID };
