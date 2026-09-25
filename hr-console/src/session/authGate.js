const {
  COOKIE_NAME,
  parseCookies,
  readSessionFromCookieValue,
  createSessionCookieValue,
  setSessionCookie,
  clearSessionCookie,
} = require('./sessionCookie');

const REFRESH_BUFFER_MS = 15_000;

// ตรวจ session cookie ของ HR Console แล้วเติม req.hrAuth = { accessToken, displayName, isMasterDataAdmin } ให้ route ถัดไปใช้
// ถ้า access token ใกล้หมดอายุ (ภายใน REFRESH_BUFFER_MS) จะ refresh ด้วย refresh_token ให้อัตโนมัติ
// (silent refresh) - ถ้า refresh ไม่สำเร็จ หรือไม่มี session เลย ให้ redirect ไปหน้า login
function createAuthGate({ keycloakAuthClient, verifyIdToken, sessionSecret, isProduction }) {
  return async function authGate(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const session = await readSessionFromCookieValue(cookies[COOKIE_NAME], sessionSecret);
    if (!session) {
      return res.redirect(302, '/auth/login');
    }

    let { accessToken, refreshToken, idToken, accessTokenExpiresAt, displayName, isMasterDataAdmin } = session;

    if (Date.now() > accessTokenExpiresAt - REFRESH_BUFFER_MS) {
      if (!refreshToken) {
        clearSessionCookie(res, { secure: req.protocol === 'https' });
        return res.redirect(302, '/auth/login');
      }

      const result = await keycloakAuthClient.refreshTokens(refreshToken);
      if (!result.ok) {
        clearSessionCookie(res, { secure: req.protocol === 'https' });
        return res.redirect(302, '/auth/login');
      }

      // ถ้า Keycloak ออก id_token ใหม่มาด้วย (บาง deployment ไม่ reissue ตอน refresh) ตรวจ role ซ้ำ
      // กันกรณีถูกถอด role hr_officer ระหว่างที่ session ยังไม่หมดอายุ
      if (result.tokens.id_token) {
        try {
          const identity = await verifyIdToken(result.tokens.id_token);
          if (!identity.isHrOfficer) {
            clearSessionCookie(res, { secure: req.protocol === 'https' });
            return res.redirect(302, '/auth/login');
          }
          idToken = result.tokens.id_token;
          displayName = identity.displayName;
          // ถูกถอด/เพิ่ม hr_master_data_admin ระหว่าง session ก็มีผลตอน refresh (MDM API ตรวจ role จาก access token ซ้ำอยู่แล้ว)
          isMasterDataAdmin = identity.isMasterDataAdmin;
        } catch {
          clearSessionCookie(res, { secure: req.protocol === 'https' });
          return res.redirect(302, '/auth/login');
        }
      }

      accessToken = result.tokens.access_token;
      refreshToken = result.tokens.refresh_token || refreshToken;
      accessTokenExpiresAt = Date.now() + result.tokens.expires_in * 1000;

      const cookieToken = await createSessionCookieValue(
        { accessToken, refreshToken, idToken, accessTokenExpiresAt, displayName, isMasterDataAdmin },
        sessionSecret
      );
      setSessionCookie(res, cookieToken, { secure: req.protocol === 'https' || isProduction });
    }

    req.hrAuth = { accessToken, displayName, isMasterDataAdmin: isMasterDataAdmin === true };
    next();
  };
}

module.exports = { createAuthGate };
