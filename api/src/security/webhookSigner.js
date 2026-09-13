const crypto = require('node:crypto');

// สำเนาจาก worker/src/services/webhookSigner.js โดยตั้งใจ (เหตุผลเดียวกับ vault.js - ดู
// worker/src/security/vault.js) ใช้เฉพาะตอน POST /webhooks/subscriptions/{id}/test เท่านั้น
function signPayload(secret, timestamp, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

module.exports = { signPayload };
