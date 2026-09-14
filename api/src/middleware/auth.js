const { jwtVerify } = require('jose');
const { createTokenVerifier } = require('../security/jwt');
const { HttpProblem } = require('../security/httpProblem');

const ACTING_PERSON_HEADER = 'x-acting-person';
const ACTING_ASSERTION_ALGORITHM = 'HS256';

// ทางเลือก B (§0.3, T9): mdm-portal เป็น service-account client (ไม่มี person_id ในตัว Bearer token เอง)
// Portal จึงแนบ X-Acting-Person เป็น JWT อายุสั้นที่เซ็นด้วย secret ที่ทั้งสองฝั่งถืออยู่ (env เท่านั้น) แทน
// การอ้าง person_id ผู้ใช้ปัจจุบัน ต้องใช้ร่วมกับ scope personnel:self และ azp ที่อยู่ใน allowlist เท่านั้น
// เพื่อไม่ให้ client อื่นที่ถือ Bearer token (แม้จะมี scope นั้น) ปลอมตัวเป็นบุคคลอื่นได้
// ถ้าไม่ตั้ง secret ไว้ (deployment ที่ยังไม่มี portal) กลไกนี้ปิดเงียบ ไม่กระทบ token แบบ A (person_id ในตัว token เอง)
function createActingPersonVerifier({ secret, allowedAzp = [], issuer = 'mdm-portal', audience = 'mdm-api' } = {}) {
  if (!secret) return null;
  const key = new TextEncoder().encode(secret);
  const azpSet = new Set(allowedAzp);

  return async function verifyActingPerson(assertion, azp, scopes) {
    if (!azpSet.has(azp) || !scopes.includes('personnel:self')) return null;
    const { payload } = await jwtVerify(assertion, key, {
      algorithms: [ACTING_ASSERTION_ALGORITHM],
      issuer,
      audience,
      maxTokenAge: '60s',
    });
    if (!payload.sub) return null;
    return payload.sub;
  };
}

// claim ที่ MDM ใช้ตามเอกสาร §2.2 ภาคผนวก ก: sub, azp, scope, person_id (user context), roles
function createAuthMiddleware({ jwks, issuer, audience, actingAssertion }) {
  const verifyAccessToken = createTokenVerifier({ jwks, issuer, audience });
  const verifyActingPerson = createActingPersonVerifier(actingAssertion);

  return async function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return next(new HttpProblem(401, 'unauthorized', 'ไม่มี token', 'ต้องส่ง Authorization: Bearer <token>'));
    }

    try {
      const { payload } = await verifyAccessToken(token);
      const scope = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
      let personId = payload.person_id ?? null;

      const actingAssertionToken = req.headers[ACTING_PERSON_HEADER];
      if (!personId && verifyActingPerson && actingAssertionToken) {
        try {
          personId = await verifyActingPerson(actingAssertionToken, payload.azp, scope);
        } catch {
          return next(
            new HttpProblem(401, 'invalid-acting-assertion', 'X-Acting-Person ไม่ถูกต้อง', 'assertion หมดอายุ, ลายเซ็นไม่ถูกต้อง, หรือ iss/aud ไม่ตรงตามที่กำหนด')
          );
        }
      }

      req.auth = {
        sub: payload.sub,
        azp: payload.azp,
        scope,
        personId,
        roles: Array.isArray(payload.roles) ? payload.roles : [],
      };
      next();
    } catch {
      next(new HttpProblem(401, 'unauthorized', 'token ไม่ถูกต้อง', 'token หมดอายุ, ลายเซ็นไม่ถูกต้อง, หรือ alg/iss/aud ไม่ตรงตามที่กำหนด'));
    }
  };
}

// ตรวจ scope ตาม security requirement ของแต่ละ operation ใน OpenAPI (§2.2 ข้อ 2)
function requireScope(requiredScope) {
  return function (req, res, next) {
    const scopes = req.auth?.scope || [];
    if (!scopes.includes(requiredScope)) {
      return next(
        new HttpProblem(403, 'insufficient-scope', 'สิทธิ์ไม่เพียงพอ', `ต้องมี scope "${requiredScope}"`)
      );
    }
    next();
  };
}

module.exports = { createAuthMiddleware, requireScope };
