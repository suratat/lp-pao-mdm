const { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } = require('jose');

const ISSUER = 'https://iam.test.local/realms/lp-pao';
const AUDIENCE = 'mdm-api';
const KEY_ID = 'test-key-1';

// สร้างคู่คีย์ RS256 + JWKS ในหน่วยความจำสำหรับทดสอบ ไม่ต้องพึ่ง Keycloak จริง (ยังไม่มีจนกว่าจะถึง T6)
async function createTestAuthContext() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = KEY_ID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const jwks = createLocalJWKSet({ keys: [publicJwk] });

  async function signToken({
    alg = 'RS256',
    issuer = ISSUER,
    audience = AUDIENCE,
    scope = '',
    sub = 'test-client',
    azp = 'test-client',
    personId,
    roles,
    realmRoles,
    signingKey = privateKey,
    expiresIn = '5m',
  } = {}) {
    let jwt = new SignJWT({ scope, azp, ...(personId ? { person_id: personId } : {}), ...(roles ? { roles } : {}), ...(realmRoles ? { realm_access: { roles: realmRoles } } : {}) })
      .setProtectedHeader({ alg, kid: KEY_ID })
      .setIssuedAt()
      .setSubject(sub)
      .setExpirationTime(expiresIn);
    if (issuer) jwt = jwt.setIssuer(issuer);
    if (audience) jwt = jwt.setAudience(audience);
    return jwt.sign(signingKey);
  }

  // alg confusion: เซ็นด้วย HS256 (symmetric) แทน RS256 - ต้องถูกปฏิเสธไม่ว่า key จะ "ตรวจผ่าน" หรือไม่ก็ตาม
  async function signHs256Token({ scope = '', sub = 'test-client' } = {}) {
    const secret = new TextEncoder().encode('attacker-controlled-secret');
    return new SignJWT({ scope, azp: sub })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(secret);
  }

  // jose ไม่ยอมให้เซ็นด้วย alg=none ตรงๆ จึงประกอบ compact JWT เองเพื่อจำลอง "none algorithm attack"
  function buildNoneAlgToken(payload = { scope: '', sub: 'test-client' }) {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ ...payload, iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 })
    ).toString('base64url');
    return `${header}.${body}.`;
  }

  return {
    jwks,
    issuer: ISSUER,
    audience: AUDIENCE,
    signToken,
    signHs256Token,
    buildNoneAlgToken,
    privateKey,
  };
}

module.exports = { createTestAuthContext, ISSUER, AUDIENCE };
