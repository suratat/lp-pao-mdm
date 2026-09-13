/* eslint-disable camelcase */

exports.shorthands = undefined;

// พบระหว่างพัฒนา T4: seq-02 (reverify-scan/escalate) กำหนดให้ worker เอง INSERT outbox_event
// (VERIFICATION_STALE, VERIFICATION_EXPIRED) โดยตรง แต่ 1700000000015_grants.js (T1) ให้ mdm_worker
// แค่ SELECT + UPDATE(published_at) บน integration.outbox_event (ตาม §1.1 ซึ่งพูดถึงแค่การ mark
// published_at) - §1.1 กับ seq-02 ขัดกันในรายละเอียดนี้ เลือกตาม seq-02 เพราะเป็น spec พฤติกรรมที่
// ระบุชัดเจนกว่า สรุปให้ผู้ใช้ทราบใน PR/summary ของ T4
exports.up = (pgm) => {
  pgm.sql(`GRANT INSERT ON integration.outbox_event TO mdm_worker;`);
  // INSERT ต้องมี USAGE บน sequence ของคอลัมน์ sequence (bigserial) ด้วย ไม่งั้น INSERT ล้มเหลว
  pgm.sql(`GRANT USAGE ON integration.outbox_event_sequence_seq TO mdm_worker;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE USAGE ON integration.outbox_event_sequence_seq FROM mdm_worker;`);
  pgm.sql(`REVOKE INSERT ON integration.outbox_event FROM mdm_worker;`);
};
