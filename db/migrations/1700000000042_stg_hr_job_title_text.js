/* eslint-disable camelcase */

exports.shorthands = undefined;

// รองรับ job_title_text (ชื่อตำแหน่ง/ลักษณะงาน - ข้อความอิสระ, PR #40 เพิ่มไว้ใน mdm.employment แล้ว) ในเครื่องมือ migrate
// (T8) - เก็บค่าดิบจากไฟล์ HR CSV ก่อนตรวจคุณภาพ/ส่งต่อให้ POST /sync/hr/employment-batch
//
// นี่คือ schema stg_hr (staging ของ pipeline migrate เท่านั้น ดู db/migrations/1700000000030_stg_hr.js) ไม่ใช่
// schema mdm หลัก - ไม่มี endpoint ของ MDM API ตัวใดอ่าน/เขียนตารางนี้ มีแค่ migrate/ tool และ worker job
// stgHrPurge (ล้างเฉพาะ pid_plaintext) เท่านั้นที่แตะ ไม่กระทบข้อมูลบุคคลจริงใน mdm.* โดยตรง เป็นแค่พื้นที่พักข้อมูล
// ก่อนนำเข้าผ่าน API เส้นทางเดียว (กฎข้อ 2 ของ CLAUDE.md)
//
// type: 'text' (ไม่ใช่ varchar(255) ตาม mdm.employment.job_title_text) โดยตั้งใจ: ค่าดิบจากไฟล์ HR อาจยาวเกิน 255
// ตัวอักษรได้ (เช่น ผู้กรอกวางข้อความยาวผิดปกติมา) ต้อง stage เก็บไว้ได้ก่อน เพื่อให้กฎคุณภาพ JOB_TITLE_TOO_LONG
// (migrate/src/quality/rules.js) รายงานเป็น error รายแถวอย่างสุภาพ แทนที่จะทำให้ loadBatch ทั้งก้อน INSERT ล้มเหลวดิบๆ
// ที่ขั้นตอนโหลดไฟล์ (ก่อนถึงขั้นตรวจคุณภาพด้วยซ้ำ) - ยืนยันด้วย test จริงว่า varchar(255) ทำให้ loadBatch พังก่อนถึง
// quality check เสมอสำหรับอินพุตที่ยาวเกิน
exports.up = (pgm) => {
  pgm.addColumn({ schema: 'stg_hr', name: 'raw_row' }, { job_title_text: { type: 'text' } });
};

exports.down = (pgm) => {
  pgm.dropColumn({ schema: 'stg_hr', name: 'raw_row' }, 'job_title_text');
};
