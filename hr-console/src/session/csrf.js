const crypto = require('node:crypto');

// CSRF token ต่อ session (เก็บใน sessionStore ฝั่งเซิร์ฟเวอร์ ไม่ใส่ใน cookie/URL) - ฟอร์ม POST ที่ต้องกันต้องส่งกลับมาเป็นฟิลด์ _csrf
// ใช้กับฟอร์มที่อ่านข้อมูลอ่อนไหว (แสดงเลขบัตร) เป็นอย่างน้อย; cookie session เป็น SameSite=Lax เป็นชั้นแรกอยู่แล้ว
function newCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function csrfTokenMatches(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string' || !expected || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

module.exports = { newCsrfToken, csrfTokenMatches };
