/* eslint-disable camelcase */

exports.shorthands = undefined;

// พบระหว่างพัฒนา: บุคลากรบางกลุ่ม (พนักงานจ้างตามภารกิจ/ทั่วไป/ผู้เชี่ยวชาญพิเศษ และจ้างเหมาบริการรายบุคคล
// ที่ทำงานประจำในหน่วยงาน) ไม่มีเลขที่ตำแหน่ง (position) ตามโครงสร้างอัตรากำลังแบบข้าราชการ/ลูกจ้างประจำ
// - เดิม mdm.employment.position_id เป็น NOT NULL บังคับทุกคนต้องมีตำแหน่ง ทำให้บันทึกกลุ่มนี้ไม่ได้
//
// EXCLUDE constraint employment_position_no_overlap_excl (ตำแหน่งหนึ่งมีผู้ครองได้หนึ่งคน) ไม่ต้องแก้:
// operator "=" ของ GIST คืนค่า NULL (ไม่ใช่ TRUE) เมื่อเทียบกับ NULL ฝั่งใดฝั่งหนึ่ง เงื่อนไข exclusion จึง
// ไม่ match แถวที่ position_id เป็น NULL เลย (พฤติกรรมเดียวกับ UNIQUE ที่ปล่อยผ่านหลาย NULL ได้) - คนที่ไม่มี
// ตำแหน่งจึงมีช่วงเวลาซ้อนทับกันได้ตามปกติ ไม่มีตำแหน่งให้ "ครองซ้ำ" อยู่แล้ว ยืนยันด้วย test จริงใน
// db/test/constraints.test.js ไม่ใช่การสันนิษฐาน
//
// เพิ่มโค้ด personnel_type ใหม่ OUTSOURCE_INDIVIDUAL (จ้างเหมาบริการรายบุคคล ประจำในหน่วยงาน - ต่างจากสัญญา
// จ้างเหมาบริการแบบบริษัท/procurement ทั่วไปซึ่งไม่ใช่ personnel record ใน MDM) ตาม decision ของผู้ใช้
exports.up = (pgm) => {
  pgm.sql(
    `INSERT INTO mdm.personnel_type (code, name_th) VALUES ('OUTSOURCE_INDIVIDUAL', 'จ้างเหมาบริการ (รายบุคคล)');`
  );

  pgm.alterColumn({ schema: 'mdm', name: 'employment' }, 'position_id', { notNull: false });
};

exports.down = (pgm) => {
  pgm.alterColumn({ schema: 'mdm', name: 'employment' }, 'position_id', { notNull: true });

  pgm.sql(`DELETE FROM mdm.personnel_type WHERE code = 'OUTSOURCE_INDIVIDUAL';`);
};
