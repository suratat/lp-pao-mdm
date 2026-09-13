/* eslint-disable camelcase */

exports.shorthands = undefined;

// seed mdm.processing_purpose (ตัวอย่าง) ตาม §0.2 หลักการข้อ 8 และตัวอย่าง purpose_code ใน §1.3
// HR_ADMIN/PAYROLL ใช้ฐานภารกิจ/หน้าที่ตามกฎหมาย (ไม่ต้องขอ consent);
// DIRECTORY_PUBLISH เป็นวัตถุประสงค์เสริมที่ต้องขอ consent ตามที่เอกสารยกตัวอย่างไว้
const ROWS = [
  [
    'HR_ADMIN',
    'งานบริหารทรัพยากรบุคคล',
    'PUBLIC_TASK',
    false,
    'P10Y',
    'บริหารจัดการทะเบียนประวัติ ตำแหน่ง สังกัด และสถานะการปฏิบัติงานของบุคลากร',
    null,
    true,
  ],
  [
    'PAYROLL',
    'การจ่ายเงินเดือนและสิทธิประโยชน์',
    'LEGAL_OBLIGATION',
    false,
    'P10Y',
    'คำนวณและจ่ายเงินเดือน ค่าตอบแทน และสิทธิประโยชน์ตามกฎหมาย',
    null,
    true,
  ],
  [
    'DIRECTORY_PUBLISH',
    'เผยแพร่ทำเนียบบุคลากรสาธารณะ',
    'CONSENT',
    true,
    'P1Y',
    'เผยแพร่รูปถ่ายและเบอร์โทรศัพท์ในทำเนียบบุคลากรที่เปิดเผยต่อสาธารณะ',
    null,
    true,
  ],
];

exports.up = async (pgm) => {
  for (const row of ROWS) {
    await pgm.db.query(
      `INSERT INTO mdm.processing_purpose
        (purpose_code, name_th, legal_basis, requires_consent, retention_period, description, ropa_ref, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      row
    );
  }
};

exports.down = async (pgm) => {
  const codes = ROWS.map(([purpose_code]) => purpose_code);
  await pgm.db.query(`DELETE FROM mdm.processing_purpose WHERE purpose_code = ANY($1::text[])`, [codes]);
};
