const express = require('express');
const { createAuthGate } = require('./session/authGate');
const { createAuthRoutes } = require('./routes/authRoutes');
const { createClaimRequestRoutes } = require('./routes/claimRequestRoutes');
const { createReverifyRoutes } = require('./routes/reverifyRoutes');
const { layout } = require('./views/html');

// config: { keycloakAuthClient, verifyIdToken, mdmClient, sessionSecret, isProduction }
function createApp({ keycloakAuthClient, verifyIdToken, mdmClient, sessionSecret, isProduction = false }) {
  const app = express();
  app.disable('x-powered-by');

  app.use(createAuthRoutes({ keycloakAuthClient, verifyIdToken, sessionSecret, isProduction }));

  // ใช้เงื่อนไข path เองแทนการพึ่ง Express path routing กับ prefix (แนวทางเดียวกับ portal/src/app.js)
  const authGate = createAuthGate({ keycloakAuthClient, verifyIdToken, sessionSecret, isProduction });
  app.use((req, res, next) => (req.path === '/hr' || req.path.startsWith('/hr/') ? authGate(req, res, next) : next()));
  app.use(createClaimRequestRoutes({ mdmClient }));
  app.use(createReverifyRoutes({ mdmClient }));

  app.get('/', (req, res) => res.redirect(302, '/hr/claim-requests'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).send(layout('เกิดข้อผิดพลาด', `<p class="error">เกิดข้อผิดพลาด (${status})</p>`));
  });

  return app;
}

module.exports = { createApp };
