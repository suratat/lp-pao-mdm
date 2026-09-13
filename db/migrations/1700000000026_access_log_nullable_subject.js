/* eslint-disable camelcase */

exports.shorthands = undefined;

// พบระหว่างพัฒนา T5: POST /persons/lookup ต้องบันทึก access_log "ทุกครั้ง" รวมถึงกรณีไม่พบบุคคลที่ตรงกับ
// pid (ป้องกันการใช้ endpoint ตรวจสอบว่าใครเป็นบุคลากร - เอกสารระบุชัดว่าต้องบันทึกทั้งสองกรณี) แต่
// subject_person_id เดิม (T1) เป็น NOT NULL ทำให้เขียนแถวไม่ได้เมื่อไม่พบบุคคล - endpoint อื่นทั้งหมดที่
// เขียน access_log ยังมี person จริงเสมอ จึงไม่กระทบพฤติกรรมเดิม
exports.up = (pgm) => {
  pgm.alterColumn({ schema: 'audit', name: 'access_log' }, 'subject_person_id', { notNull: false });
};

exports.down = (pgm) => {
  pgm.alterColumn({ schema: 'audit', name: 'access_log' }, 'subject_person_id', { notNull: true });
};
