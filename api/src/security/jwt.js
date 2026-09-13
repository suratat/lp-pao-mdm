const { createRemoteJWKSet, jwtVerify } = require('jose');

// §2.2 ข้อ 1: alg = RS256 เท่านั้น (กัน alg confusion / "none" algorithm), ตรวจ iss, ตรวจว่า aud มี mdm-api
const ALLOWED_ALGORITHMS = ['RS256'];

function resolveJwks(jwks) {
  // ใน production: jwks เป็น URL string ของ JWKS endpoint ของ Keycloak (createRemoteJWKSet cache ให้เอง)
  // ใน test: ผู้เรียกส่ง jose GetKeyFunction ที่สร้างจาก createLocalJWKSet มาแทน เพื่อไม่ต้องพึ่ง network/Keycloak จริง
  if (typeof jwks === 'function') return jwks;
  return createRemoteJWKSet(new URL(jwks));
}

function createTokenVerifier({ jwks, issuer, audience }) {
  const getKey = resolveJwks(jwks);

  return async function verifyAccessToken(token) {
    const { payload, protectedHeader } = await jwtVerify(token, getKey, {
      algorithms: ALLOWED_ALGORITHMS,
      issuer,
      audience,
    });
    return { payload, header: protectedHeader };
  };
}

module.exports = { createTokenVerifier, ALLOWED_ALGORITHMS };
