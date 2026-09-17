/* eslint-disable camelcase */

exports.shorthands = undefined;

// พบระหว่าง seed ตำแหน่งจริง (~1,016 ตำแหน่งของ อบจ.ลำปาง): ตำแหน่งบริหารสถานศึกษา (ผู้อำนวยการ/
// รองผู้อำนวยการสถานศึกษา ที่โรงเรียนวอแก้ววิทยา) ไม่เข้า 4 หมวดเดิมของ mdm.position.position_type
// (บริหารท้องถิ่น/อำนวยการท้องถิ่น/วิชาการ/ทั่วไป) และคาดว่าจะเจอหมวดใหม่แบบนี้อีก - ตาม decision ของ
// ผู้ใช้ (2026-09-17) เปลี่ยน position_type จาก CHECK ตรงๆ (varchar) เป็นตารางอ้างอิง mdm.position_type
// (code, name_th, is_active) แบบเดียวกับ mdm.personnel_type (migration 1700000000019) เพื่อเพิ่มหมวด
// ใหม่ได้โดย INSERT อย่างเดียว ไม่ต้องแก้ CHECK/migrate schema ทุกครั้ง
//
// รหัสภาษาอังกฤษ 2 ค่าใหม่ (ยืนยันกับผู้ใช้แล้ว เพราะ DIRECTOR ถูกใช้กับ "อำนวยการท้องถิ่น" ไปแล้ว ชนกัน
// ตรงๆ ไม่ได้ถ้าใช้ DIRECTOR เฉยๆ): SCHOOL_DIRECTOR (ผู้อำนวยการสถานศึกษา), SCHOOL_DEPUTY_DIRECTOR
// (รองผู้อำนวยการสถานศึกษา)
//
// หมายเหตุการเขียน migration นี้ (เหมือน 1700000000019): ต้องใช้ pgm.sql() ล้วนๆ ไม่ผสมกับ pgm.db.query()
// เพราะ pgm.createTable/addConstraint/dropConstraint ถูกเข้าคิวแล้วรันเป็นชุดตอนจบ ในขณะที่ pgm.db.query()
// รันทันที - ถ้าผสมกันจะทำให้ INSERT แข่งกับ DDL ที่ยังไม่ถูก flush จริง
const POSITION_TYPES = [
  ['EXECUTIVE', 'บริหารท้องถิ่น'],
  ['DIRECTOR', 'อำนวยการท้องถิ่น'],
  ['ACADEMIC', 'วิชาการ'],
  ['GENERAL', 'ทั่วไป'],
  ['SCHOOL_DIRECTOR', 'ผู้อำนวยการสถานศึกษา'],
  ['SCHOOL_DEPUTY_DIRECTOR', 'รองผู้อำนวยการสถานศึกษา'],
];

exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'mdm', name: 'position_type' },
    {
      code: { type: 'varchar(30)', primaryKey: true },
      name_th: { type: 'varchar(255)', notNull: true },
      is_active: { type: 'boolean', notNull: true, default: true },
    }
  );
  for (const [code, nameTh] of POSITION_TYPES) {
    pgm.sql(`INSERT INTO mdm.position_type (code, name_th) VALUES ('${code}', '${nameTh}');`);
  }

  pgm.dropConstraint({ schema: 'mdm', name: 'position' }, 'position_position_type_check');
  pgm.addConstraint(
    { schema: 'mdm', name: 'position' },
    'position_position_type_fkey',
    'FOREIGN KEY (position_type) REFERENCES mdm.position_type(code)'
  );

  // ตารางใหม่ไม่ได้อยู่ใน schema ตอนที่ 1700000000015_grants.js รัน (GRANT ... ON ALL TABLES IN SCHEMA
  // มีผลเฉพาะตารางที่มีอยู่ ณ ตอนรันเท่านั้น) ต้อง grant ซ้ำให้ตารางใหม่นี้โดยเฉพาะ
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON mdm.position_type TO mdm_app, mdm_worker;`);
  pgm.sql(`GRANT SELECT ON mdm.position_type TO mdm_readonly;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE ALL ON mdm.position_type FROM mdm_app, mdm_worker, mdm_readonly;`);

  pgm.dropConstraint({ schema: 'mdm', name: 'position' }, 'position_position_type_fkey');
  // หมายเหตุ: ค่าที่ CHECK นี้ต้องยอมรับคือโค้ดภาษาอังกฤษ (EXECUTIVE/DIRECTOR/ACADEMIC/GENERAL) ที่มีผล
  // อยู่ก่อนหน้า migration นี้ (ตั้งจาก 1700000000019_english_enum_codes.js#up) ไม่ใช่ค่าไทยดั้งเดิม -
  // ยืนยันด้วย migrate-roundtrip.test.js จริง (ถ้าใช้ค่าไทยตรงนี้ down จะ fail เพราะแถวที่มีอยู่เป็น
  // ภาษาอังกฤษไปแล้ว)
  pgm.addConstraint(
    { schema: 'mdm', name: 'position' },
    'position_position_type_check',
    "CHECK (position_type IN ('EXECUTIVE', 'DIRECTOR', 'ACADEMIC', 'GENERAL'))"
  );

  pgm.dropTable({ schema: 'mdm', name: 'position_type' });
};
