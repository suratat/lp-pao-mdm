/* eslint-disable camelcase */

exports.shorthands = undefined;

// seed ตำแหน่งจริงแรกเข้า mdm.position สำหรับทดสอบ provision คนจริง 1 คน (ยืนยันข้อมูลจากผู้ใช้ตรง ๆ
// 2026-09-16) - mdm.position ไม่มีคอลัมน์ valid_from/valid_to (มีเฉพาะใน mdm.org_unit) และไม่มี
// level_code (level_code เป็นคุณสมบัติของ mdm.employment คือระดับของ "คนที่ครองตำแหน่ง ณ ขณะนั้น" ไม่ใช่
// ของตำแหน่งเอง - จะใส่ตอน provision employment จริงแทน ไม่ใช่ที่นี่) position_type ยืนยันจากผู้ใช้ว่าเป็น
// ACADEMIC (วิชาการ) และ line_of_work เว้นว่างไว้ (NULL)
const POSITION_NO = '52-1-07-3106-003';
const TITLE_TH = 'นักวิชาการคอมพิวเตอร์';
const POSITION_TYPE = 'ACADEMIC';
const ORG_UNIT_CODE = 'YB'; // กองยุทธศาสตร์และงบประมาณ - seed แล้วใน 1700000000033_seed_real_org_units.js

exports.up = async (pgm) => {
  const {
    rows: [orgUnit],
  } = await pgm.db.query(`SELECT org_unit_id FROM mdm.org_unit WHERE code = $1`, [ORG_UNIT_CODE]);

  if (!orgUnit) {
    throw new Error(
      `ไม่พบ org_unit code=${ORG_UNIT_CODE} ใน mdm.org_unit - ต้อง apply migration 1700000000033_seed_real_org_units.js ก่อน`
    );
  }

  await pgm.db.query(
    `INSERT INTO mdm.position (position_no, title_th, line_of_work, position_type, org_unit_id, is_active)
     VALUES ($1, $2, NULL, $3, $4, true)`,
    [POSITION_NO, TITLE_TH, POSITION_TYPE, orgUnit.org_unit_id]
  );
};

exports.down = async (pgm) => {
  await pgm.db.query(`DELETE FROM mdm.position WHERE position_no = $1`, [POSITION_NO]);
};
