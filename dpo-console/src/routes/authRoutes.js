const express = require('express');
const { randomState } = require('../security/keycloakAuthClient');
const {
  COOKIE_NAME,
  STATE_COOKIE_NAME,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  clearLegacySessionCookie,
  setOauthStateCookie,
  clearOauthStateCookie,
} = require('../session/sessionCookie');
const { layout, escapeHtml } = require('../views/html');

function errorPage(message) {
  return layout('เข้าสู่ระบบไม่สำเร็จ', `<p class="error">${message}</p><p><a href="/auth/login">เข้าสู่ระบบใหม่อีกครั้ง</a></p>`);
}

// login เป็น Keycloak authorization code flow เท่านั้น (ไม่มี dev-login stub แบบ Portal - DPO Console
// เป็นเครื่องมือของเจ้าหน้าที่ที่ต้องมี realm role dpo หรือ auditor เท่านั้น ไม่ควรมีทางลัดข้ามการตรวจ role
// โครงสร้างไฟล์นี้เหมือน hr-console/src/routes/authRoutes.js ทุกประการ)
function createAuthRoutes({ keycloakAuthClient, verifyIdToken, sessionStore, isProduction }) {
  const router = express.Router();

  router.get('/auth/login', (req, res) => {
    const state = randomState();
    setOauthStateCookie(res, state, { secure: req.protocol === 'https' || isProduction });
    res.redirect(302, keycloakAuthClient.buildLoginUrl(state));
  });

  router.get('/auth/callback', async (req, res, next) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      clearOauthStateCookie(res, { secure: req.protocol === 'https' || isProduction });

      const { code, state, error: oauthError } = req.query;
      if (oauthError) {
        return res.status(400).send(errorPage(`Keycloak ปฏิเสธการล็อกอิน (${escapeHtml(String(oauthError).slice(0, 100))})`));
      }
      if (typeof code !== 'string' || !code) {
        return res.status(400).send(errorPage('ไม่พบ authorization code จาก Keycloak'));
      }
      if (typeof state !== 'string' || !state || state !== cookies[STATE_COOKIE_NAME]) {
        return res.status(400).send(errorPage('state ไม่ตรงกัน (อาจเป็นการโจมตี CSRF หรือ session หมดอายุ) กรุณาเข้าสู่ระบบใหม่'));
      }

      const result = await keycloakAuthClient.exchangeCode(code);
      if (!result.ok) {
        // ห้าม log รายละเอียด token endpoint (อาจมี client secret หลุดในบาง error path) - เก็บแค่ status
        // eslint-disable-next-line no-console
        console.error(`Keycloak token endpoint ปฏิเสธ (status ${result.status})`);
        return res.status(502).send(errorPage('เชื่อมต่อระบบยืนยันตัวตนไม่สำเร็จ กรุณาลองใหม่ภายหลัง'));
      }

      const { access_token: accessToken, refresh_token: refreshToken, id_token: idToken, expires_in: expiresIn } = result.tokens;
      if (!idToken) {
        return res.status(502).send(errorPage('Keycloak ไม่ได้ส่ง id_token กลับมา (ตรวจ scope openid ของ client dpo-console)'));
      }

      let identity;
      try {
        identity = await verifyIdToken(idToken);
      } catch {
        return res.status(401).send(errorPage('id_token ไม่ถูกต้อง (ลายเซ็นไม่ถูกต้อง หรือ iss/aud ไม่ตรงตามที่กำหนด)'));
      }

      if (!identity.isAllowed) {
        return res.status(403).send(errorPage('บัญชีนี้ไม่มีสิทธิ์เจ้าหน้าที่คุ้มครองข้อมูลส่วนบุคคล (role dpo หรือ auditor) กรุณาติดต่อผู้ดูแลระบบ'));
      }

      // เก็บ token ไว้ใน sessionStore ฝั่งเซิร์ฟเวอร์ ส่ง cookie แค่ session id (id_token ตรวจแล้วทิ้ง ไม่เก็บ)
      const secure = req.protocol === 'https' || isProduction;
      const sid = sessionStore.create({
        accessToken,
        refreshToken,
        accessTokenExpiresAt: Date.now() + expiresIn * 1000,
        displayName: identity.displayName,
      });
      clearLegacySessionCookie(res, { secure }); // ล้าง cookie JWE รุ่นเก่าที่อาจค้างในเบราว์เซอร์
      setSessionCookie(res, sid, { secure });
      return res.redirect(302, '/dpo/access-logs');
    } catch (err) {
      return next(err);
    }
  });

  router.get('/auth/logout', (req, res) => {
    const secure = req.protocol === 'https' || isProduction;
    // ลบ session ฝั่งเซิร์ฟเวอร์ด้วย (ไม่ใช่แค่ล้าง cookie) - cookie ที่รั่วออกไปแล้วจะใช้ต่อไม่ได้
    sessionStore.delete(parseCookies(req.headers.cookie)[COOKIE_NAME]);
    clearSessionCookie(res, { secure });
    clearLegacySessionCookie(res, { secure });
    const logoutUrl = keycloakAuthClient.buildLogoutUrl();
    res.redirect(302, logoutUrl || '/auth/login');
  });

  return router;
}

module.exports = { createAuthRoutes };
