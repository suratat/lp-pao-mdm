const http = require('node:http');
const { createKeycloakServiceTokenProvider } = require('../src/security/keycloakClient');

// ยืนยันว่า Portal ขอ token ด้วย client credentials ของ "client ของตัวเอง" ตามที่ config ไว้จริง (ไม่ใช่
// client อื่นที่หลุดเข้ามาแบบที่เคยเกิดขึ้นจริงตอน .env.staging ตั้งค่า KEYCLOAK_CLIENT_ID/SECRET สลับกับ
// ของ worker) - จำลอง Keycloak token endpoint จริงด้วย http server (แบบเดียวกับ mockCheckServer.js) แทน
// การ mock global.fetch ตรงๆ เพื่อตรวจ body ที่ส่งจริงตาม wire format (application/x-www-form-urlencoded)

function createMockTokenServer({ expectedClientId, expectedClientSecret, expiresIn = 60 }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      requests.push(Object.fromEntries(params));

      const clientId = params.get('client_id');
      const clientSecret = params.get('client_secret');
      if (clientId !== expectedClientId || clientSecret !== expectedClientSecret) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }

      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ access_token: `token-for-${clientId}`, expires_in: expiresIn }));
    });
  });

  return {
    requests,
    async listen() {
      await new Promise((resolve) => server.listen(0, resolve));
      const { port } = server.address();
      return `http://127.0.0.1:${port}/realms/lp-pao/protocol/openid-connect/token`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('createKeycloakServiceTokenProvider (unit)', () => {
  test('ส่ง client_id/client_secret/scope ตาม config ที่ตั้งไว้จริง (client ของ Portal เอง ไม่ใช่ client อื่น)', async () => {
    const mockServer = createMockTokenServer({ expectedClientId: 'mdm-portal', expectedClientSecret: 'mdm-portal-secret' });
    const tokenUrl = await mockServer.listen();

    const getServiceToken = createKeycloakServiceTokenProvider({
      tokenUrl,
      clientId: 'mdm-portal',
      clientSecret: 'mdm-portal-secret',
      scope: 'personnel:self',
    });

    const token = await getServiceToken();
    expect(token).toBe('token-for-mdm-portal');
    expect(mockServer.requests).toHaveLength(1);
    expect(mockServer.requests[0]).toMatchObject({
      grant_type: 'client_credentials',
      client_id: 'mdm-portal',
      client_secret: 'mdm-portal-secret',
      scope: 'personnel:self',
    });

    await mockServer.close();
  });

  test('ใช้ client อื่น (เช่น mdm-worker หลุดเข้ามาใน config) ทำให้ Keycloak ปฏิเสธ ไม่ใช่ silent fallback', async () => {
    const mockServer = createMockTokenServer({ expectedClientId: 'mdm-portal', expectedClientSecret: 'mdm-portal-secret' });
    const tokenUrl = await mockServer.listen();

    const getServiceToken = createKeycloakServiceTokenProvider({
      tokenUrl,
      clientId: 'mdm-worker',
      clientSecret: 'mdm-worker-secret',
      scope: 'personnel:self',
    });

    await expect(getServiceToken()).rejects.toThrow(/ขอ token จาก Keycloak ไม่สำเร็จ \(status 401\)/);

    await mockServer.close();
  });

  test('cache token ไว้จนใกล้หมดอายุ - ไม่ขอซ้ำถ้ายังไม่ใกล้หมดอายุ', async () => {
    const mockServer = createMockTokenServer({ expectedClientId: 'mdm-portal', expectedClientSecret: 'mdm-portal-secret', expiresIn: 3600 });
    const tokenUrl = await mockServer.listen();

    const getServiceToken = createKeycloakServiceTokenProvider({
      tokenUrl,
      clientId: 'mdm-portal',
      clientSecret: 'mdm-portal-secret',
    });

    const first = await getServiceToken();
    const second = await getServiceToken();
    expect(second).toBe(first);
    expect(mockServer.requests).toHaveLength(1);

    await mockServer.close();
  });
});
