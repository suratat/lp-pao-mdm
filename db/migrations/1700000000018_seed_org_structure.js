/* eslint-disable camelcase */

exports.shorthands = undefined;

// seed mdm.org_unit / mdm.position (ตัวอย่างสำหรับ dev/test เท่านั้น ไม่ใช่โครงสร้างจริงทั้งหมด)
// ใช้ UUID คงที่เพื่อให้ down migration และ test อ้างอิงได้แน่นอน
// ชื่อหน่วยงานอ้างอิงจากเอกสารออกแบบเอง (ผู้จัดทำ = กองยุทธศาสตร์และงบประมาณ; ภาคผนวก ก กล่าวถึงกองการเจ้าหน้าที่)
const ORG_UNITS = [
  {
    org_unit_id: '00000000-0000-0000-0000-000000000001',
    parent_id: null,
    code: 'STRATEGY',
    name_th: 'กองยุทธศาสตร์และงบประมาณ',
    name_en: 'Strategy and Budget Department',
    unit_level: 'สำนัก/กอง',
  },
  {
    org_unit_id: '00000000-0000-0000-0000-000000000002',
    parent_id: null,
    code: 'PERSONNEL',
    name_th: 'กองการเจ้าหน้าที่',
    name_en: 'Personnel Department',
    unit_level: 'สำนัก/กอง',
  },
  {
    org_unit_id: '00000000-0000-0000-0000-000000000003',
    parent_id: '00000000-0000-0000-0000-000000000002',
    code: 'PERSONNEL-ADMIN',
    name_th: 'ฝ่ายบริหารงานทั่วไป',
    name_en: 'General Administration Division',
    unit_level: 'ฝ่าย',
  },
  {
    org_unit_id: '00000000-0000-0000-0000-000000000004',
    parent_id: '00000000-0000-0000-0000-000000000003',
    code: 'PERSONNEL-ADMIN-REG',
    name_th: 'งานทะเบียนประวัติ',
    name_en: 'Personnel Records Unit',
    unit_level: 'งาน',
  },
];

const POSITIONS = [
  {
    position_id: '00000000-0000-0000-0000-000000000101',
    position_no: 'POS-0001',
    title_th: 'ผู้อำนวยการกองการเจ้าหน้าที่',
    line_of_work: 'บริหารงานบุคคล',
    position_type: 'อำนวยการท้องถิ่น',
    org_unit_id: '00000000-0000-0000-0000-000000000002',
  },
  {
    position_id: '00000000-0000-0000-0000-000000000102',
    position_no: 'POS-0002',
    title_th: 'นักทรัพยากรบุคคลชำนาญการ',
    line_of_work: 'บริหารงานบุคคล',
    position_type: 'วิชาการ',
    org_unit_id: '00000000-0000-0000-0000-000000000003',
  },
  {
    position_id: '00000000-0000-0000-0000-000000000103',
    position_no: 'POS-0003',
    title_th: 'เจ้าพนักงานธุรการ',
    line_of_work: 'ธุรการ',
    position_type: 'ทั่วไป',
    org_unit_id: '00000000-0000-0000-0000-000000000004',
  },
];

exports.up = async (pgm) => {
  // เรียงจาก parent ก่อนลูกเพื่อไม่ให้ FK parent_id ล้มเหลว
  for (const u of ORG_UNITS) {
    await pgm.db.query(
      `INSERT INTO mdm.org_unit (org_unit_id, parent_id, code, name_th, name_en, unit_level)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [u.org_unit_id, u.parent_id, u.code, u.name_th, u.name_en, u.unit_level]
    );
  }

  for (const p of POSITIONS) {
    await pgm.db.query(
      `INSERT INTO mdm.position (position_id, position_no, title_th, line_of_work, position_type, org_unit_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [p.position_id, p.position_no, p.title_th, p.line_of_work, p.position_type, p.org_unit_id]
    );
  }
};

exports.down = async (pgm) => {
  await pgm.db.query(
    `DELETE FROM mdm.position WHERE position_id = ANY($1::uuid[])`,
    [POSITIONS.map((p) => p.position_id)]
  );
  // ลบลูกก่อนพ่อ (เรียงย้อนกลับ)
  await pgm.db.query(
    `DELETE FROM mdm.org_unit WHERE org_unit_id = ANY($1::uuid[])`,
    [[...ORG_UNITS].reverse().map((u) => u.org_unit_id)]
  );
};
