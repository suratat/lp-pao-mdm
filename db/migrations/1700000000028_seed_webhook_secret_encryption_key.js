/* eslint-disable camelcase */

exports.shorthands = undefined;

// พบระหว่างพัฒนา T5: POST /webhooks/subscriptions (webhookService.createWebhookSubscription) เข้ารหัส
// secret ผ่าน vault.encrypt('mdm-webhook-secret', ...) แล้วเก็บ key_id ที่ได้ (รูปแบบเดียวกับ
// person.key_id ตอน claim ใน T3) ลง integration.webhook_subscription.key_id ซึ่งมี FK ไป
// mdm.encryption_key(key_id) - เหมือน 1700000000020_seed_pid_encryption_key.js สำหรับ mdm-pid แต่ไม่มีใคร
// seed แถวของ mdm-webhook-secret ไว้เลย ทำให้ INSERT ล้มเหลวทุกครั้ง (foreign key violation)
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO mdm.encryption_key (key_id, purpose, provider, key_version, status)
    VALUES ('vault:transit:mdm-webhook-secret:v1', 'WEBHOOK_SECRET', 'VAULT_TRANSIT', 1, 'ACTIVE');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM mdm.encryption_key WHERE key_id = 'vault:transit:mdm-webhook-secret:v1';`);
};
