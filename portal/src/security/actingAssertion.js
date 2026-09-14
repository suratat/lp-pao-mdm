const { SignJWT } = require('jose');

// ทางเลือก B (§0.3, T9): Portal เซ็น JWT อายุสั้นแทน person_id ของผู้ใช้ที่กำลังทำ self-service อยู่
// แนบเป็น header X-Acting-Person ไปกับ Bearer token (client credentials ของ mdm-portal เอง) เมื่อเรียก
// MDM API ดู api/src/middleware/auth.js ฝั่งตรวจ - ต้องใช้ secret เดียวกัน (env เท่านั้น ห้าม hardcode)
async function signActingPersonAssertion({ personId, secret, issuer = 'mdm-portal', audience = 'mdm-api', expiresIn = '30s' }) {
  if (!secret) {
    throw new Error('ไม่ได้ตั้งค่า PORTAL_ACTING_ASSERTION_SECRET');
  }
  const key = new TextEncoder().encode(secret);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(personId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

module.exports = { signActingPersonAssertion };
