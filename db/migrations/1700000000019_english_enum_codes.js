/* eslint-disable camelcase */

exports.shorthands = undefined;

// แก้ inconsistency ที่พบระหว่างพัฒนา T2: mdm.employment.personnel_type, mdm.position.position_type,
// mdm.org_unit.unit_level ใน T1 (migration 1700000000006, 1700000000007) เก็บเป็นข้อความไทยบรรยาย
// (คัดลอกมาจาก comment ใน ER diagram ตรงๆ) ในขณะที่ personnel-mdm-openapi.yaml (สัญญาจริง) ใช้ enum
// ภาษาอังกฤษ - ไม่สอดคล้องกับ mdm.employment_status/verification_status/person.status ที่เก็บเป็น
// English code ตรงกับ API อยู่แล้ว (เลือกทางแก้ ก: ให้ DB เก็บ code เดียวกับ API ไม่ต้องมี mapping layer
// ในทุก service ที่อ่าน/เขียนฟิลด์เหล่านี้)
//
// unit_level (3 ค่า) และ position_type (4 ค่า) ตรงกันแบบ 1:1 กับ OpenAPI อยู่แล้ว แค่เปลี่ยนภาษา
// personnel_type ต่างออกไป: DB เดิมมีแค่ 4 ค่า แต่ OpenAPI PersonnelType มี 7 หมวด (รวม TEACHER,
// EXPERT_EMPLOYEE, TRANSFERRED_HEALTH) - ตาม decision ของผู้ใช้ (2026-09-13): ใส่ครบ 7 หมวดตอนนี้เลย
// แม้ภาคผนวก ง ข้อ 2 ของเอกสารออกแบบจะยังไม่ยืนยันกับฝ่ายบุคคลว่าครู/บุคลากรถ่ายโอน รพ.สต. อยู่ในขอบเขต
// หรือไม่ - ใช้ mdm.personnel_type เป็นตารางอ้างอิง (มี is_active) แทน CHECK constraint ตรงๆ เพื่อให้ปิดใช้
// งานหมวดใดหมวดหนึ่งภายหลังได้โดยไม่ต้อง migrate ใหม่ หากฝ่ายบุคคลยืนยันว่าไม่อยู่ในขอบเขต
//
// หมายเหตุการเขียน migration นี้: ต้องใช้ pgm.sql() ล้วนๆ (ไม่ผสมกับ pgm.db.query()) เพราะ
// pgm.createTable/addConstraint/dropConstraint ถูก "เข้าคิว" แล้วรันเป็นชุดตอนจบ ในขณะที่
// pgm.db.query() รันทันที - ถ้าผสมกันจะทำให้ INSERT/UPDATE แข่งกับ DDL ที่ยังไม่ถูก flush จริง

const UNIT_LEVEL_MAP = { 'สำนัก/กอง': 'DIVISION', ฝ่าย: 'SECTION', งาน: 'UNIT' };
const POSITION_TYPE_MAP = {
  บริหารท้องถิ่น: 'EXECUTIVE',
  อำนวยการท้องถิ่น: 'DIRECTOR',
  วิชาการ: 'ACADEMIC',
  ทั่วไป: 'GENERAL',
};

const PERSONNEL_TYPES = [
  ['CIVIL_SERVANT', 'ข้าราชการองค์การบริหารส่วนจังหวัด'],
  ['TEACHER', 'ข้าราชการครูและบุคลากรทางการศึกษา'],
  ['PERMANENT_EMPLOYEE', 'ลูกจ้างประจำ'],
  ['CONTRACT_EMPLOYEE', 'พนักงานจ้างตามภารกิจ'],
  ['GENERAL_EMPLOYEE', 'พนักงานจ้างทั่วไป'],
  ['EXPERT_EMPLOYEE', 'พนักงานจ้างผู้เชี่ยวชาญพิเศษ'],
  ['TRANSFERRED_HEALTH', 'บุคลากรถ่ายโอน (รพ.สต.)'],
];

// personnel_type เดิมของ T1 (4 หมวดกว้างๆ) map เข้าหมวดที่ใกล้เคียงที่สุดใน 7 หมวดใหม่ ใช้กับ UPDATE
// แถว seed ที่มีอยู่ก่อน (T1 เองไม่ได้ seed ข้อมูล employment ไว้ จึงไม่กระทบข้อมูลจริงใดๆ ในขั้นนี้)
const PERSONNEL_TYPE_MAP = {
  'ข้าราชการ อบจ.': 'CIVIL_SERVANT',
  ลูกจ้างประจำ: 'PERMANENT_EMPLOYEE',
  พนักงานจ้าง: 'GENERAL_EMPLOYEE',
  ถ่ายโอน: 'TRANSFERRED_HEALTH',
};

exports.up = (pgm) => {
  // --- mdm.personnel_type (ตารางอ้างอิงใหม่ แทน CHECK ตรงๆ) ---
  pgm.createTable(
    { schema: 'mdm', name: 'personnel_type' },
    {
      code: { type: 'varchar(30)', primaryKey: true },
      name_th: { type: 'varchar(255)', notNull: true },
      is_active: { type: 'boolean', notNull: true, default: true },
    }
  );
  for (const [code, nameTh] of PERSONNEL_TYPES) {
    pgm.sql(`INSERT INTO mdm.personnel_type (code, name_th) VALUES ('${code}', '${nameTh}');`);
  }

  // --- org_unit.unit_level: Thai -> English (1:1 กับ OpenAPI OrgUnit.unitLevel) ---
  pgm.dropConstraint({ schema: 'mdm', name: 'org_unit' }, 'org_unit_unit_level_check');
  for (const [th, en] of Object.entries(UNIT_LEVEL_MAP)) {
    pgm.sql(`UPDATE mdm.org_unit SET unit_level = '${en}' WHERE unit_level = '${th}';`);
  }
  pgm.addConstraint(
    { schema: 'mdm', name: 'org_unit' },
    'org_unit_unit_level_check',
    "CHECK (unit_level IN ('DIVISION', 'SECTION', 'UNIT'))"
  );

  // --- position.position_type: Thai -> English (1:1 กับ OpenAPI Position.positionType) ---
  pgm.dropConstraint({ schema: 'mdm', name: 'position' }, 'position_position_type_check');
  for (const [th, en] of Object.entries(POSITION_TYPE_MAP)) {
    pgm.sql(`UPDATE mdm.position SET position_type = '${en}' WHERE position_type = '${th}';`);
  }
  pgm.addConstraint(
    { schema: 'mdm', name: 'position' },
    'position_position_type_check',
    "CHECK (position_type IN ('EXECUTIVE', 'DIRECTOR', 'ACADEMIC', 'GENERAL'))"
  );

  // --- employment.personnel_type: Thai CHECK -> FK ไปตารางอ้างอิง mdm.personnel_type ---
  pgm.dropConstraint({ schema: 'mdm', name: 'employment' }, 'employment_personnel_type_check');
  for (const [th, en] of Object.entries(PERSONNEL_TYPE_MAP)) {
    pgm.sql(`UPDATE mdm.employment SET personnel_type = '${en}' WHERE personnel_type = '${th}';`);
  }
  pgm.addConstraint(
    { schema: 'mdm', name: 'employment' },
    'employment_personnel_type_fkey',
    'FOREIGN KEY (personnel_type) REFERENCES mdm.personnel_type(code)'
  );

  // ตารางใหม่ไม่ได้อยู่ใน schema ตอนที่ 1700000000015_grants.js รัน (GRANT ... ON ALL TABLES IN SCHEMA
  // มีผลเฉพาะตารางที่มีอยู่ ณ ตอนรันเท่านั้น) ต้อง grant ซ้ำให้ตารางใหม่นี้โดยเฉพาะ
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON mdm.personnel_type TO mdm_app, mdm_worker;`);
  pgm.sql(`GRANT SELECT ON mdm.personnel_type TO mdm_readonly;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE ALL ON mdm.personnel_type FROM mdm_app, mdm_worker, mdm_readonly;`);

  pgm.dropConstraint({ schema: 'mdm', name: 'employment' }, 'employment_personnel_type_fkey');
  for (const [th, en] of Object.entries(PERSONNEL_TYPE_MAP)) {
    pgm.sql(`UPDATE mdm.employment SET personnel_type = '${th}' WHERE personnel_type = '${en}';`);
  }
  pgm.addConstraint(
    { schema: 'mdm', name: 'employment' },
    'employment_personnel_type_check',
    "CHECK (personnel_type IN ('ข้าราชการ อบจ.', 'ลูกจ้างประจำ', 'พนักงานจ้าง', 'ถ่ายโอน'))"
  );

  pgm.dropConstraint({ schema: 'mdm', name: 'position' }, 'position_position_type_check');
  for (const [th, en] of Object.entries(POSITION_TYPE_MAP)) {
    pgm.sql(`UPDATE mdm.position SET position_type = '${th}' WHERE position_type = '${en}';`);
  }
  pgm.addConstraint(
    { schema: 'mdm', name: 'position' },
    'position_position_type_check',
    "CHECK (position_type IN ('บริหารท้องถิ่น', 'อำนวยการท้องถิ่น', 'วิชาการ', 'ทั่วไป'))"
  );

  pgm.dropConstraint({ schema: 'mdm', name: 'org_unit' }, 'org_unit_unit_level_check');
  for (const [th, en] of Object.entries(UNIT_LEVEL_MAP)) {
    pgm.sql(`UPDATE mdm.org_unit SET unit_level = '${th}' WHERE unit_level = '${en}';`);
  }
  pgm.addConstraint(
    { schema: 'mdm', name: 'org_unit' },
    'org_unit_unit_level_check',
    "CHECK (unit_level IN ('สำนัก/กอง', 'ฝ่าย', 'งาน'))"
  );

  pgm.dropTable({ schema: 'mdm', name: 'personnel_type' });
};
