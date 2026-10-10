const express = require('express');
const { createAuthGate } = require('./session/authGate');
const { createAuthRoutes } = require('./routes/authRoutes');
const { createMeRoutes } = require('./routes/meRoutes');
const {
  layout,
  NAV_CONSENTS_PLACEHOLDER,
  NAV_CONSENTS_LINK,
  NAV_EMERGENCY_PLACEHOLDER,
  NAV_EMERGENCY_LINK,
} = require('./views/html');

// config: { mdmClient, sessionSecret, isProduction, checkAuthClient, consentsEnabled, emergencyContactsEnabled }
// consentsEnabled (env PORTAL_CONSENTS_ENABLED=true; default ปิด): ปิด = ไม่ mount route /portal/me/consents เลย
// (ตอบ 404 เหมือน path ที่ไม่มีอยู่) และเมนูไม่มีลิงก์ เพราะ consent ยังไม่ถูกบังคับใช้จริงในระบบ
// emergencyContactsEnabled (env PORTAL_EMERGENCY_CONTACTS_ENABLED=true; default ปิด): กลไกเดียวกัน - ปิด = ไม่ mount
// GET/POST /portal/me/emergency-contacts (404) และเมนูไม่มีลิงก์ ข้อมูลที่บันทึกไว้แล้วไม่ถูกแตะ (HR Console ยังแก้ได้)
// mdmClient สร้างด้วย ./mdmClient.js createMdmClient(...) - server.js ประกอบ getServiceToken/secret จริง
// จาก env, ส่วน test ใช้ instance ของ MDM API จริง (api/src/app.js) ที่รันในเทสเพื่อไม่ต้อง mock HTTP
// checkAuthClient (optional) สร้างด้วย ./security/checkAuthClient.js - ไม่ตั้งค่า = fallback ไป dev-login
function createApp({
  mdmClient,
  sessionSecret,
  isProduction = false,
  checkAuthClient = null,
  consentsEnabled = false,
  emergencyContactsEnabled = false,
}) {
  const app = express();
  app.disable('x-powered-by');

  const navConsents = consentsEnabled ? NAV_CONSENTS_LINK : '';
  const navEmergency = emergencyContactsEnabled ? NAV_EMERGENCY_LINK : '';
  app.use((req, res, next) => {
    const send = res.send.bind(res);
    res.send = (body) =>
      send(
        typeof body === 'string'
          ? body.split(NAV_CONSENTS_PLACEHOLDER).join(navConsents).split(NAV_EMERGENCY_PLACEHOLDER).join(navEmergency)
          : body
      );
    next();
  });

  app.use(createAuthRoutes({ sessionSecret, isProduction, checkAuthClient }));

  // ใช้เงื่อนไข path เองแทนการพึ่ง Express path routing กับ prefix (กันปัญหาความเข้ากันได้ของ
  // path-to-regexp ข้าม version) - ผ่านเฉพาะ path ที่ขึ้นต้นด้วย /portal เท่านั้น
  const authGate = createAuthGate({ sessionSecret });
  app.use((req, res, next) => (req.path === '/portal' || req.path.startsWith('/portal/') ? authGate(req, res, next) : next()));
  app.use(createMeRoutes({ mdmClient, consentsEnabled, emergencyContactsEnabled }));

  app.get('/', (req, res) => res.redirect(302, '/portal/me'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    console.error('portal_error', { path: req.path, status, message: err.message, stack: err.stack });
    res.status(status).send(layout('เกิดข้อผิดพลาด', `<p class="error">เกิดข้อผิดพลาด (${status})</p>`));
  });

  return app;
}

module.exports = { createApp };
