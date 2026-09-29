/* eslint-disable camelcase */

exports.shorthands = undefined;

// เอา "สายงาน" (line_of_work) ออกจาก mdm.position - ระบบนี้ไม่ใช่ระบบ HR ไม่ต้องเก็บสายงาน (เจ้าของระบบยืนยัน)
// ตรวจแล้วก่อนเขียน migration นี้: ไม่มี view/function/trigger ใดอ้างถึงคอลัมน์นี้ (ดู db/migrations/1700000000014,
// 1700000000039 - ไม่มีที่ใดอ้าง column ระดับนี้ตรงๆ) และ DB จริงมี 0 แถวที่ line_of_work ไม่ใช่ NULL ก่อน DROP
//
// ห้ามแก้แถวเก่าใน audit.reference_change_log ที่ field_name = 'line_of_work' (append-only - เก็บไว้เป็นประวัติว่าเคยมีฟิลด์นี้
// และเคยถูกแก้ค่า แม้ column ต้นทางจะไม่มีแล้ว) migration นี้จึงไม่แตะตาราง audit เลย
exports.up = (pgm) => {
  pgm.dropColumn({ schema: 'mdm', name: 'position' }, 'line_of_work');
};

exports.down = (pgm) => {
  pgm.addColumn({ schema: 'mdm', name: 'position' }, { line_of_work: { type: 'varchar(100)' } });
};
