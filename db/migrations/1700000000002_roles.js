/* eslint-disable camelcase */

exports.shorthands = undefined;

// สร้าง role ระดับ cluster (ไม่ผูกกับ schema เดียว) ตาม §1.6:
// mdm_app (API), mdm_worker, mdm_readonly (รายงาน), mdm_audit (อ่าน audit เท่านั้น)
// สิทธิ์ระดับตาราง/คอลัมน์กำหนดใน migration 0015_grants.js (ต้องรอให้ตารางถูกสร้างก่อน)
const ROLES = ['mdm_app', 'mdm_worker', 'mdm_readonly', 'mdm_audit'];

exports.up = (pgm) => {
  for (const role of ROLES) {
    pgm.sql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} NOLOGIN;
        END IF;
      END
      $$;
    `);
  }

  pgm.sql(`GRANT USAGE ON SCHEMA mdm TO mdm_app, mdm_worker, mdm_readonly;`);
  pgm.sql(`GRANT USAGE ON SCHEMA audit TO mdm_app, mdm_worker, mdm_audit;`);
  pgm.sql(`GRANT USAGE ON SCHEMA integration TO mdm_app, mdm_worker;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE USAGE ON SCHEMA mdm FROM mdm_app, mdm_worker, mdm_readonly;`);
  pgm.sql(`REVOKE USAGE ON SCHEMA audit FROM mdm_app, mdm_worker, mdm_audit;`);
  pgm.sql(`REVOKE USAGE ON SCHEMA integration FROM mdm_app, mdm_worker;`);

  for (const role of ROLES) {
    pgm.sql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          DROP ROLE ${role};
        END IF;
      END
      $$;
    `);
  }
};
