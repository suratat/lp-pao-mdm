const http = require('node:http');

// จำลอง check.lp-pao.go.th เฉพาะส่วนที่ Portal คุยด้วยจริง (POST /api/verify) ตาม contract จริงที่ยืนยัน
// กับทีม check-app แล้ว (T7): Basic auth ด้วย client_id/client_secret, body {token}, ตอบ flat object
// ที่ field ที่ไม่ได้สิทธิ์ "หายไปเฉย ๆ" ไม่ใช่ null - ไม่ต้องพึ่ง check-app ตัวจริงในการรันเทส
function createMockCheckServer({ clientId, clientSecret, personIdForValidToken }) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/verify') {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      let authOk = false;
      if (auth.startsWith('Basic ')) {
        const [id, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
        authOk = id === clientId && secret === clientSecret;
      }
      if (!authOk) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }

      let token;
      try {
        token = JSON.parse(body || '{}').token;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }

      if (token === 'valid-with-person') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            person_id: personIdForValidToken,
            title: 'นาย',
            given_name: 'ทดสอบ',
            family_name: 'พอร์ทัล',
            roles: [],
            verified_at: new Date().toISOString(),
            app: 'mdm-portal',
          })
        );
        return;
      }
      if (token === 'valid-no-person') {
        // สถานการณ์: scope ของ app ไม่มี person_id ใน allowed_claims - field หายไปเฉย ๆ
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ title: 'นาย', given_name: 'ทดสอบ', verified_at: new Date().toISOString(), app: 'mdm-portal' }));
        return;
      }
      if (token === 'expired') {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_or_expired_token' }));
        return;
      }
      if (token === 'malformed-response') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{not-json');
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_request', message: 'unknown test token' }));
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

module.exports = { createMockCheckServer };
