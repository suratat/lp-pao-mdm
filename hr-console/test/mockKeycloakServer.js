const http = require('node:http');
const { SignJWT } = require('jose');

// จำลอง Keycloak เฉพาะส่วนที่ HR Console คุยด้วยจริงคือ token endpoint (authorization_code +
// refresh_token grant) - ไม่ต้อง mock authorize endpoint เพราะ HR Console แค่ redirect เบราว์เซอร์ไป
// เฉย ๆ ไม่เรียกเอง
//
// เซ็น id_token/access_token ด้วย private key เดียวกับที่ MDM API test instance เชื่อ (ctx.auth จาก
// api/test/testJwks.js) เพื่อให้ access_token ที่ HR Console ส่งต่อไป MDM API จริงในเทสตรวจผ่านได้จริง -
// ไม่ใส่ kid ใน header ของ id_token (jose จับคู่คีย์ด้วย alg ได้เองเมื่อ JWKS มีคีย์ที่ตรง alg เพียงตัวเดียว
// ทำให้ไม่ต้องผูกกับค่าคงที่ภายในของ testJwks.js)
//
// ตัวเลือกต่อ scenario (เพิ่มใน T10-fix เพื่อทดสอบ session/refresh):
//   padRoles: N     เพิ่ม realm role ปลอม N ตัวใน id_token/access_token (จำลอง token ใหญ่ผิดปกติ)
//   rotateRefresh   เลียนแบบ realm ที่ revokeRefreshToken=true: refresh token ใช้ได้ครั้งเดียว ใช้ซ้ำ -> invalid_grant
//   refreshDelayMs  หน่วงตอบ refresh_token grant (ขยายช่วงเวลาที่ request พร้อมกันจะชนกัน)
const MIN_ACCESS_JWT_LIFETIME_S = 60;

function createMockKeycloakServer({ auth, hrConsoleClientId, hrConsoleClientSecret, scenarios }) {
  const stats = { refreshGrants: 0, invalidGrants: 0 };
  const validRefreshTokens = new Set(); // ใช้กับ rotateRefresh
  let refreshGate = null; // holdRefresh(): ค้างคำขอ refresh_token grant ไว้จนกว่าเทสต์จะสั่งปล่อย (ไม่พึ่งเวลา)
  let refreshSeq = 0;

  const rolesOf = (def) => [...def.roles, ...Array.from({ length: def.padRoles ?? 0 }, (_, i) => `padding-role-${String(i).padStart(4, '0')}`)];
  async function signIdToken(scenarioDef) {
    let jwt = new SignJWT({
      realm_access: { roles: rolesOf(scenarioDef) },
      name: scenarioDef.displayName,
      preferred_username: scenarioDef.username,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setSubject(scenarioDef.username || 'hr-user')
      .setIssuer(auth.issuer)
      .setAudience(hrConsoleClientId)
      .setExpirationTime('5m');
    return jwt.sign(auth.privateKey);
  }

  function issueRefreshToken(scenarioName, def) {
    if (!def.rotateRefresh) return `refresh-for-${scenarioName}`;
    refreshSeq += 1;
    const token = `refresh-for-${scenarioName}~${refreshSeq}`;
    validRefreshTokens.add(token);
    return token;
  }

  async function mintTokens(scenarioName) {
    const def = scenarios[scenarioName];
    if (!def) return null;
    const accessToken = await auth.signToken({
      scope: def.scope,
      sub: def.username || 'hr-user',
      azp: hrConsoleClientId,
      // Keycloak client scope "roles" ใส่ realm_access.roles ใน access token ด้วย (ยืนยันกับ Keycloak 26 จริงแล้ว) -
      // MDM API ใช้ตรวจ hr_master_data_admin (T10)
      realmRoles: rolesOf(def),
      // อายุของ JWT แยกจาก expires_in ที่ตอบกลับ (ซึ่งเป็นตัวที่ authGate ใช้ตัดสินว่าต้อง refresh): JWT exp มีความละเอียด 1 วินาที
      // และ iat ถูกตัดเศษวินาที (ออก token ตอน x.97s อายุ 1s = หมดอายุอีก 30ms) scenario ที่ตั้ง expiresIn=1 เพื่อบังคับ refresh จึงทำให้
      // MDM API ปฏิเสธ token ใหม่ด้วย 401 เป็นครั้งคราวตามจังหวะวินาที (ไม่เกี่ยวกับ logic ของ console) - ให้ JWT อายุไม่ต่ำกว่านี้เสมอ
      expiresIn: `${Math.max(def.expiresIn ?? 300, MIN_ACCESS_JWT_LIFETIME_S)}s`,
    });
    return {
      access_token: accessToken,
      refresh_token: def.refreshable === false ? undefined : issueRefreshToken(scenarioName, def),
      id_token: def.omitIdToken ? undefined : await signIdToken(def),
      expires_in: def.expiresIn ?? 300,
      token_type: 'Bearer',
    };
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/protocol/openid-connect/token') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      const params = new URLSearchParams(body);
      if (params.get('client_id') !== hrConsoleClientId || params.get('client_secret') !== hrConsoleClientSecret) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }

      try {
        const grantType = params.get('grant_type');
        let scenarioName = null;
        if (grantType === 'authorization_code') {
          scenarioName = params.get('code');
        } else if (grantType === 'refresh_token') {
          stats.refreshGrants += 1;
          const refreshToken = params.get('refresh_token') || '';
          scenarioName = refreshToken.startsWith('refresh-for-') ? refreshToken.slice('refresh-for-'.length).split('~')[0] : null;
          const def = scenarioName ? scenarios[scenarioName] : null;
          if (def?.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, def.refreshDelayMs));
          if (refreshGate) {
            refreshGate.markRequested();
            await refreshGate.released;
          }
          if (def?.rotateRefresh) {
            // revokeRefreshToken=true: ใช้ได้ครั้งเดียว ตัวที่ถูกใช้แล้ว/ไม่รู้จัก -> invalid_grant
            if (!validRefreshTokens.delete(refreshToken)) scenarioName = null;
          }
        }

        const tokens = scenarioName ? await mintTokens(scenarioName) : null;
        if (!tokens) {
          stats.invalidGrants += 1;
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(tokens));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'server_error' }));
      }
    });
  });

  return {
    stats,
    // ค้าง refresh_token grant ทุกคำขอไว้ที่ mock: คืน { requested (Promise: มีคำขอ refresh มาถึง mock แล้ว), release() }
    // ใช้ทดสอบ single-flight แบบกำหนดผลได้แน่นอน - รอให้ request พร้อมกันทุกตัวเข้ามาค้างที่ authGate ก่อนแล้วค่อยปล่อย
    holdRefresh() {
      let markRequested;
      let release;
      const requested = new Promise((resolve) => {
        markRequested = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      refreshGate = { markRequested, released };
      return {
        requested,
        release() {
          refreshGate = null;
          release();
        },
      };
    },
    async listen() {
      await new Promise((resolve) => server.listen(0, resolve));
      const { port } = server.address();
      return `http://127.0.0.1:${port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createMockKeycloakServer };
