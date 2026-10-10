const express = require('express');
const { createAuthGate } = require('./session/authGate');
const { createSessionStore } = require('./session/sessionStore');
const { createAuthRoutes } = require('./routes/authRoutes');
const { createClaimRequestRoutes } = require('./routes/claimRequestRoutes');
const { createReverifyRoutes } = require('./routes/reverifyRoutes');
const { createMasterDataRoutes } = require('./routes/masterDataRoutes');
const { createPersonProfileRoutes } = require('./routes/personProfileRoutes');
const { createPersonRoutes } = require('./routes/personRoutes');
const { createPersonEditRoutes } = require('./routes/personEditRoutes');
const { layout } = require('./views/html');

// config: { keycloakAuthClient, verifyIdToken, mdmClient, sessionStore, isProduction }
// sessionStore: ดู session/sessionStore.js (ไม่ส่ง = สร้างใหม่ในหน่วยความจำ)
// emergencyContactsEnabled (env HR_EMERGENCY_CONTACTS_ENABLED=true; default ปิด): ปิด = ไม่ mount GET/POST /hr/persons/:id/emergency-contacts/edit
// (ตอบ 404 เหมือน path ที่ไม่มีอยู่) และหน้ารายละเอียดบุคคลไม่มีปุ่ม "แก้ผู้ติดต่อฉุกเฉิน" ซ่อนเฉพาะหน้าจอ: API และข้อมูลที่บันทึกไว้ไม่ถูกแตะ
// emailCheck (ฉีดในเทสต์เท่านั้น): { checkDomain, limiter } ของปุ่มตรวจสอบอีเมล - ไม่ระบุ = ค้น DNS จริง 10 ครั้ง/นาทีต่อ session
function createApp({ keycloakAuthClient, verifyIdToken, mdmClient, sessionStore = createSessionStore(), isProduction = false, emailCheck = {}, emergencyContactsEnabled = false }) {
  const app = express();
  app.disable('x-powered-by');

  app.use(createAuthRoutes({ keycloakAuthClient, verifyIdToken, sessionStore, isProduction }));

  // ใช้เงื่อนไข path เองแทนการพึ่ง Express path routing กับ prefix (แนวทางเดียวกับ portal/src/app.js)
  const authGate = createAuthGate({ keycloakAuthClient, verifyIdToken, sessionStore, isProduction, jsonPathRe: /^\/hr\/persons\/[^/]+\/contact\/check-email$/ });
  app.use((req, res, next) => (req.path === '/hr' || req.path.startsWith('/hr/') ? authGate(req, res, next) : next()));
  app.use(createClaimRequestRoutes({ mdmClient }));
  app.use(createReverifyRoutes({ mdmClient }));
  app.use(createMasterDataRoutes({ mdmClient }));
  app.use(createPersonEditRoutes({ mdmClient })); // ต้องมาก่อน createPersonRoutes: /hr/persons/new ต้องไม่ถูกตีเป็น :personId
  app.use(createPersonProfileRoutes({ mdmClient, emailCheck, emergencyContactsEnabled }));
  app.use(createPersonRoutes({ mdmClient, emergencyContactsEnabled }));

  app.get('/', (req, res) => res.redirect(302, '/hr/claim-requests'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).send(layout('เกิดข้อผิดพลาด', `<p class="error">เกิดข้อผิดพลาด (${status})</p>`));
  });

  return app;
}

module.exports = { createApp };
