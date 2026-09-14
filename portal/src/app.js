const express = require('express');
const { createAuthGate } = require('./session/authGate');
const { createAuthRoutes } = require('./routes/authRoutes');
const { createMeRoutes } = require('./routes/meRoutes');
const { layout } = require('./views/html');

// config: { mdmClient, sessionSecret, isProduction }
// mdmClient สร้างด้วย ./mdmClient.js createMdmClient(...) - server.js ประกอบ getServiceToken/secret จริง
// จาก env, ส่วน test ใช้ instance ของ MDM API จริง (api/src/app.js) ที่รันในเทสเพื่อไม่ต้อง mock HTTP
function createApp({ mdmClient, sessionSecret, isProduction = false }) {
  const app = express();
  app.disable('x-powered-by');

  app.use(createAuthRoutes({ sessionSecret, isProduction }));

  // ใช้เงื่อนไข path เองแทนการพึ่ง Express path routing กับ prefix (กันปัญหาความเข้ากันได้ของ
  // path-to-regexp ข้าม version) - ผ่านเฉพาะ path ที่ขึ้นต้นด้วย /portal เท่านั้น
  const authGate = createAuthGate({ sessionSecret });
  app.use((req, res, next) => (req.path === '/portal' || req.path.startsWith('/portal/') ? authGate(req, res, next) : next()));
  app.use(createMeRoutes({ mdmClient }));

  app.get('/', (req, res) => res.redirect(302, '/portal/me'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).send(layout('เกิดข้อผิดพลาด', `<p class="error">เกิดข้อผิดพลาด (${status})</p>`));
  });

  return app;
}

module.exports = { createApp };
