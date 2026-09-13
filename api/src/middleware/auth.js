const { createTokenVerifier } = require('../security/jwt');
const { HttpProblem } = require('../security/httpProblem');

// claim ที่ MDM ใช้ตามเอกสาร §2.2 ภาคผนวก ก: sub, azp, scope, person_id (user context), roles
function createAuthMiddleware({ jwks, issuer, audience }) {
  const verifyAccessToken = createTokenVerifier({ jwks, issuer, audience });

  return async function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return next(new HttpProblem(401, 'unauthorized', 'ไม่มี token', 'ต้องส่ง Authorization: Bearer <token>'));
    }

    try {
      const { payload } = await verifyAccessToken(token);
      req.auth = {
        sub: payload.sub,
        azp: payload.azp,
        scope: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
        personId: payload.person_id ?? null,
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
