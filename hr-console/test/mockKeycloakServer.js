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
function createMockKeycloakServer({ auth, hrConsoleClientId, hrConsoleClientSecret, scenarios }) {
  async function signIdToken(scenarioDef) {
    let jwt = new SignJWT({
      realm_access: { roles: scenarioDef.roles },
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

  async function mintTokens(scenarioName) {
    const def = scenarios[scenarioName];
    if (!def) return null;
    const accessToken = await auth.signToken({
      scope: def.scope,
      sub: def.username || 'hr-user',
      azp: hrConsoleClientId,
      expiresIn: `${def.expiresIn ?? 300}s`,
    });
    return {
      access_token: accessToken,
      refresh_token: def.refreshable === false ? undefined : `refresh-for-${scenarioName}`,
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
          const refreshToken = params.get('refresh_token') || '';
          scenarioName = refreshToken.startsWith('refresh-for-') ? refreshToken.slice('refresh-for-'.length) : null;
        }

        const tokens = scenarioName ? await mintTokens(scenarioName) : null;
        if (!tokens) {
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
