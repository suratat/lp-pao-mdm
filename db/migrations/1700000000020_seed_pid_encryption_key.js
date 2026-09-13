/* eslint-disable camelcase */

exports.shorthands = undefined;

// T3 (POST /sync/thaid): เมื่อ claim สำเร็จ MDM ตั้ง person.key_id = 'vault:transit:mdm-pid:v1'
// (ภาคผนวก ข) คอลัมน์นี้มี FK ไป mdm.encryption_key(key_id) จึงต้องมีแถวนี้อยู่ก่อน มิฉะนั้น claim
// จะ insert/update ไม่ได้เลย - คีย์จริงอยู่ใน Vault เสมอ แถวนี้เป็นแค่ทะเบียนเวอร์ชัน (mdm.encryption_key
// ไม่เก็บคีย์จริงตามที่ออกแบบไว้ใน §1.4)
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO mdm.encryption_key (key_id, purpose, provider, key_version, status)
    VALUES ('vault:transit:mdm-pid:v1', 'PID_ENC', 'VAULT_TRANSIT', 1, 'ACTIVE');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM mdm.encryption_key WHERE key_id = 'vault:transit:mdm-pid:v1';`);
};
