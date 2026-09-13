const crypto = require('node:crypto');

// X-MDM-Signature: sha256=HEX(HMAC-SHA256(secret, "<timestamp>.<raw body>")) ตาม §2.3
function signPayload(secret, timestamp, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

// เหมือน verifyWebhook() ในภาคผนวก ข ของเอกสารออกแบบ (ฝั่งผู้รับ) - ใช้ยืนยันในเทสของฝั่งเราเองว่า
// สิ่งที่ signPayload() ผลิตออกมาตรวจผ่านได้จริงตามอัลกอริทึมที่ผู้รับทุกระบบต้อง implement
function verifySignature(secret, timestamp, rawBody, signatureHeader, { now = new Date(), maxSkewMs = 5 * 60 * 1000 } = {}) {
  const expected = signPayload(secret, timestamp, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader || '');
  const signatureOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  const freshOk = Math.abs(now.getTime() - Date.parse(timestamp)) < maxSkewMs;
  return signatureOk && freshOk;
}

module.exports = { signPayload, verifySignature };
