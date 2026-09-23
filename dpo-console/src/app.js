const express = require('express');
const { createAuthGate } = require('./session/authGate');
const { createAuthRoutes } = require('./routes/authRoutes');
const { createAuditRoutes } = require('./routes/auditRoutes');
const { layout } = require('./views/html');

// config: { keycloakAuthClient, verifyIdToken, mdmClient, sessionSecret, isProduction }
// (โครงสร้างเหมือน hr-console/src/app.js ทุกประการ ต่างกันแค่ prefix /dpo/ แทน /hr/)
function createApp({ keycloakAuthClient, verifyIdToken, mdmClient, sessionSecret, isProduction = false }) {
  const app = express();
  app.disable('x-powered-by');

  app.use(createAuthRoutes({ keycloakAuthClient, verifyIdToken, sessionSecret, isProduction }));

  const authGate = createAuthGate({ keycloakAuthClient, verifyIdToken, sessionSecret, isProduction });
  app.use((req, res, next) => (req.path === '/dpo' || req.path.startsWith('/dpo/') ? authGate(req, res, next) : next()));
  app.use(createAuditRoutes({ mdmClient }));

  app.get('/', (req, res) => res.redirect(302, '/dpo/access-logs'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).send(layout('เกิดข้อผิดพลาด', `<p class="error">เกิดข้อผิดพลาด (${status})</p>`));
  });

  return app;
}

module.exports = { createApp };
