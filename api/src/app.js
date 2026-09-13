const express = require('express');
const { middleware: OpenApiValidator } = require('express-openapi-validator');

const { SPEC_PATH, loadSpec } = require('./openapiSpec');
const { requestId, problemJsonErrorHandler, notFoundHandler } = require('./middleware/problemJson');
const { createAuthMiddleware } = require('./middleware/auth');
const { personalDataResponseMiddleware } = require('./middleware/accessLog');

const createSystemRouter = require('./routes/system');
const personsRouter = require('./routes/persons');
const meRouter = require('./routes/me');
const provisioningRouter = require('./routes/provisioning');
const employmentRouter = require('./routes/employment');
const syncRouter = require('./routes/sync');
const eventsRouter = require('./routes/events');
const webhooksRouter = require('./routes/webhooks');
const referenceRouter = require('./routes/reference');
const auditRouter = require('./routes/audit');

// authConfig: { jwks, issuer, audience } - jwks เป็น URL string (production, createRemoteJWKSet)
// หรือ jose GetKeyFunction (test, createLocalJWKSet) ดู security/jwt.js
async function createApp({ pool, authConfig }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(requestId);

  const spec = loadSpec();

  // servers: ใน OpenAPI ใช้ /api/v1 เป็น base path ส่วน paths: ในสเปกไม่มี prefix นี้
  const v1 = express.Router();

  // /health ไม่ต้องมี token (security: [] ใน OpenAPI) จึงมาก่อน auth middleware
  v1.use(createSystemRouter(pool));

  v1.use(
    OpenApiValidator({
      apiSpec: SPEC_PATH,
      validateRequests: true,
      validateResponses: true,
      validateSecurity: false, // ตรวจ scope เองผ่าน requireScope() เพราะต้องอ่านจาก JWT ที่ verify ด้วย jose ไม่ใช่ apiKey/oauth2 มาตรฐานของ validator
    })
  );

  v1.use(createAuthMiddleware(authConfig));

  // ต้อง mount ก่อน route handlers เสมอ: mask ต้องทำก่อนคำนวณ fields_returned ของ access_log
  // (ดูคอมเมนต์ใน middleware/accessLog.js เรื่องลำดับการห่อ res.json)
  v1.use(personalDataResponseMiddleware(spec, pool));

  v1.use(personsRouter);
  v1.use(meRouter);
  v1.use(provisioningRouter);
  v1.use(employmentRouter);
  v1.use(syncRouter);
  v1.use(eventsRouter);
  v1.use(webhooksRouter);
  v1.use(referenceRouter);
  v1.use(auditRouter);

  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(problemJsonErrorHandler);

  return app;
}

module.exports = { createApp };
