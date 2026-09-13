/* eslint-disable camelcase */

exports.shorthands = undefined;

// พบระหว่างสแตนด์อัพ T6 staging stack จริง: pg-boss (worker/src/boss.js) รัน
// `CREATE SCHEMA IF NOT EXISTS pgboss` ทุกครั้งที่ boss.start() แม้ schema จะมีอยู่แล้วจาก
// 1700000000021_pgboss_schema.js ก็ตาม - PostgreSQL ตรวจสิทธิ์ CREATE ระดับ "database" ของ
// statement CREATE SCHEMA ก่อนเสมอ (แม้จะมี IF NOT EXISTS และ schema มีอยู่แล้วจริง) ซึ่ง
// 1700000000021 ให้แค่สิทธิ์ระดับ schema (GRANT ALL ON SCHEMA pgboss) ไม่ใช่ระดับ database จึงทำให้
// worker ล้มเหลวด้วย "permission denied for database <db>" ตั้งแต่ก้าวแรกของ boss.start()
// ใช้ current_database() แทนชื่อ database ตรงๆ เพราะชื่อ database มาจาก POSTGRES_DB ของแต่ละ
// deployment ไม่ใช่ค่าคงที่ที่ migration ควรรู้ล่วงหน้า
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      EXECUTE format('GRANT CREATE ON DATABASE %I TO mdm_worker', current_database());
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      EXECUTE format('REVOKE CREATE ON DATABASE %I FROM mdm_worker', current_database());
    END
    $$;
  `);
};
