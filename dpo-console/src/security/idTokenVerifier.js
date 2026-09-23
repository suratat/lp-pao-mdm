const { createRemoteJWKSet, jwtVerify } = require('jose');

const ALLOWED_ALGORITHMS = ['RS256'];
// ต่างจาก hr-console (เช็ค role เดียว hr_officer) - DPO Console อนุญาตทั้ง dpo และ auditor (ทั้งคู่มี
// scope audit:read ตามที่ตกลงไว้ในเอกสารออกแบบ §2.2: "audit:read: realm role dpo, auditor")
const ALLOWED_ROLES = ['dpo', 'auditor'];

function resolveJwks(jwks) {
  // production: jwks เป็น URL string ของ JWKS endpoint ของ Keycloak (createRemoteJWKSet cache ให้เอง)
  // test: ผู้เรียกส่ง jose GetKeyFunction ที่สร้างจาก createLocalJWKSet มาแทน เหมือนแนวทางของ api/src/security/jwt.js
  if (typeof jwks === 'function') return jwks;
  return createRemoteJWKSet(new URL(jwks));
}

// ตรวจ ID token ของผู้ใช้ที่เพิ่งล็อกอินผ่าน Keycloak (aud = client id ของ dpo-console เอง ไม่ใช่ mdm-api -
// นั่นเป็นคนละ token กับ access token ที่ส่งต่อให้ MDM API ตรวจ audience ของตัวเองอีกที) แล้วอ่าน
// realm_access.roles (ค่า default ที่ Keycloak client scope "roles" ใส่มาให้)
function createIdTokenVerifier({ jwks, issuer, audience }) {
  const getKey = resolveJwks(jwks);

  return async function verifyIdToken(idToken) {
    const { payload } = await jwtVerify(idToken, getKey, { algorithms: ALLOWED_ALGORITHMS, issuer, audience });
    const roles = Array.isArray(payload.realm_access?.roles) ? payload.realm_access.roles : [];
    return {
      sub: payload.sub,
      roles,
      isAllowed: roles.some((role) => ALLOWED_ROLES.includes(role)),
      displayName: payload.name || payload.preferred_username || payload.sub,
    };
  };
}

module.exports = { createIdTokenVerifier, ALLOWED_ROLES };
