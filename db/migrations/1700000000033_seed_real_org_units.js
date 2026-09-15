/* eslint-disable camelcase */

exports.shorthands = undefined;

// แทนที่ข้อมูลตัวอย่างของ T8 (1700000000018_seed_org_structure.js) ด้วยโครงสร้างส่วนราชการจริงของ
// อบจ.ลำปาง (11 หน่วยงาน) ยืนยันกับผู้ใช้แล้ว (2026-09-15) ว่าทุกหน่วยงานเก็บที่ unit_level = DIVISION
// เท่านั้น เพราะองค์กรนี้เก็บลึกสุดแค่ระดับกอง/สำนักใน MDM (รายละเอียดฝ่าย/งานย่อยอยู่ในระบบ HR แยกต่างหาก)
// - ไม่แก้ CHECK constraint ของ unit_level (คงไว้ทั้ง DIVISION/SECTION/UNIT ตาม ER diagram เดิม เผื่ออนาคต)
//
// ไม่ hardcode UUID ของหน่วยงานใหม่ (ต่างจาก T18) - อ้างอิงกันด้วย code แทน เพื่อให้ down migration
// ไม่ต้องพึ่ง UUID คงที่ที่จำไว้ล่วงหน้า และลดความเสี่ยงชนกับ UUID คงที่อื่นที่ใช้อยู่แล้วในระบบ (fixture
// ของ test ต่าง ๆ) - รายชื่อ/รหัสหน่วยงานยืนยันจากผู้ใช้ตรง ๆ ไม่ได้มาจากเอกสารออกแบบ
const DIVISIONS = [
  { code: 'HQ', name_th: 'องค์การบริหารส่วนจังหวัดลำปาง' },
  { code: 'SP', name_th: 'สำนักปลัดองค์การบริหารส่วนจังหวัด' },
  { code: 'SL', name_th: 'สำนักงานเลขานุการองค์การบริหารส่วนจังหวัด' },
  { code: 'KL', name_th: 'กองคลัง' },
  { code: 'SC', name_th: 'สำนักช่าง' },
  { code: 'SS', name_th: 'กองสาธารณสุข' },
  { code: 'YB', name_th: 'กองยุทธศาสตร์และงบประมาณ' },
  { code: 'ED', name_th: 'กองการศึกษา ศาสนาและวัฒนธรรม' },
  { code: 'TS', name_th: 'หน่วยตรวจสอบภายใน' },
  { code: 'PD', name_th: 'กองพัสดุและทรัพย์สิน' },
  { code: 'PS', name_th: 'กองการเจ้าหน้าที่' },
];

const SEED_VALID_FROM = '2026-09-15'; // ยืนยันจากผู้ใช้: ไม่มีวันที่ประกาศจัดตั้ง/ปรับโครงสร้างที่แน่ชัด ใช้วันที่ seed ข้อมูลนี้แทน

const SAMPLE_POSITION_NOS = ['POS-0001', 'POS-0002', 'POS-0003'];
const SAMPLE_ORG_UNIT_CODES = ['STRATEGY', 'PERSONNEL', 'PERSONNEL-ADMIN', 'PERSONNEL-ADMIN-REG'];

exports.up = async (pgm) => {
  // ลบข้อมูลตัวอย่างของ T8 - ลบ position (ลูก) ก่อน org_unit (พ่อ) เพราะมี FK ON DELETE RESTRICT
  await pgm.db.query(`DELETE FROM mdm.position WHERE position_no = ANY($1::varchar[])`, [
    SAMPLE_POSITION_NOS,
  ]);
  await pgm.db.query(`DELETE FROM mdm.org_unit WHERE code = ANY($1::varchar[])`, [
    SAMPLE_ORG_UNIT_CODES,
  ]);

  const [hq, ...children] = DIVISIONS;

  const {
    rows: [hqRow],
  } = await pgm.db.query(
    `INSERT INTO mdm.org_unit (parent_id, code, name_th, unit_level, is_active, valid_from)
     VALUES (NULL, $1, $2, 'DIVISION', true, $3)
     RETURNING org_unit_id`,
    [hq.code, hq.name_th, SEED_VALID_FROM]
  );

  for (const division of children) {
    await pgm.db.query(
      `INSERT INTO mdm.org_unit (parent_id, code, name_th, unit_level, is_active, valid_from)
       VALUES ($1, $2, $3, 'DIVISION', true, $4)`,
      [hqRow.org_unit_id, division.code, division.name_th, SEED_VALID_FROM]
    );
  }
};

exports.down = async (pgm) => {
  await pgm.db.query(`DELETE FROM mdm.org_unit WHERE code = ANY($1::varchar[])`, [
    DIVISIONS.map((d) => d.code),
  ]);
};
