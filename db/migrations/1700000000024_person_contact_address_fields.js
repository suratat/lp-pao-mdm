/* eslint-disable camelcase */

exports.shorthands = undefined;

// พบระหว่างพัฒนา T5: mdm.person_contact (T1) เก็บที่อยู่ปัจจุบันเป็น cur_address_text + รหัสพื้นที่
// เท่านั้น ไม่มีคอลัมน์ house_no/moo/soi/road แยก ในขณะที่ OpenAPI Address schema (ใช้ทั้งตอนอ่านและ
// ตอน PUT /me/contact) มีฟิลด์เหล่านี้ - ถ้าไม่มีคอลัมน์รองรับ ข้อมูลที่ผู้ใช้กรอกมาจะหายไปเงียบๆ ตอนบันทึก
// เพิ่มคอลัมน์ให้ตรงกับรูปแบบเดียวกับ reg_house_no/reg_moo/reg_soi/reg_road ของ person_identity
exports.up = (pgm) => {
  pgm.addColumns(
    { schema: 'mdm', name: 'person_contact' },
    {
      cur_house_no: { type: 'varchar(50)' },
      cur_moo: { type: 'varchar(20)' },
      cur_soi: { type: 'varchar(100)' },
      cur_road: { type: 'varchar(100)' },
    }
  );
};

exports.down = (pgm) => {
  pgm.dropColumns({ schema: 'mdm', name: 'person_contact' }, ['cur_house_no', 'cur_moo', 'cur_soi', 'cur_road']);
};
