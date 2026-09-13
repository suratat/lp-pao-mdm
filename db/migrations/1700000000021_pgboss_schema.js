/* eslint-disable camelcase */

exports.shorthands = undefined;

// pg-boss (คิว/scheduler ของ mdm-worker) จัดการตารางของตัวเองในสคีมา pgboss โดยรันตอน boss.start()
// mdm_worker (T1) ไม่มีสิทธิ์ CREATE ระดับ database จึงต้องเตรียม schema + สิทธิ์ไว้ล่วงหน้าให้
// pg-boss สร้างตารางภายในได้เอง
exports.up = (pgm) => {
  pgm.createSchema('pgboss', { ifNotExists: true });
  pgm.sql(`GRANT ALL ON SCHEMA pgboss TO mdm_worker;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE ALL ON SCHEMA pgboss FROM mdm_worker;`);
  pgm.dropSchema('pgboss', { ifExists: true, cascade: true });
};
