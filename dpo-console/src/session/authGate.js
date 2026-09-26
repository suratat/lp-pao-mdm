const { COOKIE_NAME, parseCookies, clearSessionCookie } = require('./sessionCookie');

const REFRESH_BUFFER_MS = 15_000;

// (โครงสร้างเหมือน hr-console/src/session/authGate.js ทุกประการ ต่างกันแค่ role ที่ตรวจซ้ำตอน refresh)
// ตรวจ session ของ DPO Console (cookie เก็บแค่ session id -> ดู token จาก sessionStore ฝั่งเซิร์ฟเวอร์) แล้วเติม
// req.dpoAuth = { accessToken, displayName } ให้ route ถัดไปใช้
// ถ้า access token ใกล้หมดอายุ (ภายใน REFRESH_BUFFER_MS) จะ refresh ด้วย refresh_token ให้อัตโนมัติ (silent refresh)
// แล้วอัปเดตใน store (ไม่ต้อง Set-Cookie ใหม่) - ถ้า refresh ไม่สำเร็จ หรือไม่มี session ให้ redirect ไปหน้า login
//
// single-flight: realm ตั้ง revokeRefreshToken=true (refresh token ใช้ได้ครั้งเดียว) ถ้าสอง request ของ session เดียวกัน
// เห็น token ใกล้หมดอายุพร้อมกันแล้วต่างคนต่าง refresh ด้วย refresh token ตัวเดิม ตัวที่สองจะได้ invalid_grant และ
// ถูกเด้งไป login ทั้งที่ session ยังดี - จึงรวมให้เหลือ refresh ครั้งเดียวต่อ session และให้ request ที่เหลือรอผลเดียวกัน
function createAuthGate({ keycloakAuthClient, verifyIdToken, sessionStore, isProduction }) {
  const refreshInFlight = new Map(); // sid -> Promise<boolean>

  // คืน true ถ้า refresh สำเร็จ (อัปเดต store แล้ว), false ถ้าต้อง login ใหม่ (session ใช้ต่อไม่ได้)
  // throw เมื่อเรียก Keycloak ไม่ได้ (เครือข่าย/ระบบล่ม) - ไม่ลบ session เพราะไม่ใช่ความผิดของ session
  async function doRefresh(sid) {
    const session = sessionStore.get(sid);
    if (!session || !session.refreshToken) return false;

    const result = await keycloakAuthClient.refreshTokens(session.refreshToken);
    if (!result.ok) return false;

    const patch = {};
    // ถ้า Keycloak ออก id_token ใหม่มาด้วย (บาง deployment ไม่ reissue ตอน refresh) ตรวจ role ซ้ำ
    // กันกรณีถูกถอด role dpo/auditor ระหว่างที่ session ยังไม่หมดอายุ (id_token ใช้ตรวจแล้วทิ้ง ไม่เก็บ)
    if (result.tokens.id_token) {
      try {
        const identity = await verifyIdToken(result.tokens.id_token);
        if (!identity.isAllowed) return false;
        patch.displayName = identity.displayName;
      } catch {
        return false;
      }
    }

    patch.accessToken = result.tokens.access_token;
    patch.refreshToken = result.tokens.refresh_token || session.refreshToken;
    patch.accessTokenExpiresAt = Date.now() + result.tokens.expires_in * 1000;
    return sessionStore.update(sid, patch);
  }

  function refreshOnce(sid) {
    let pending = refreshInFlight.get(sid);
    if (!pending) {
      pending = doRefresh(sid).finally(() => refreshInFlight.delete(sid));
      refreshInFlight.set(sid, pending);
    }
    return pending;
  }

  return async function authGate(req, res, next) {
    try {
      const secure = req.protocol === 'https' || isProduction;
      const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
      let session = sessionStore.get(sid);
      if (!session) return res.redirect(302, '/auth/login');

      if (Date.now() > session.accessTokenExpiresAt - REFRESH_BUFFER_MS) {
        const refreshed = await refreshOnce(sid);
        if (!refreshed) {
          sessionStore.delete(sid);
          clearSessionCookie(res, { secure });
          return res.redirect(302, '/auth/login');
        }
        session = sessionStore.get(sid);
        if (!session) return res.redirect(302, '/auth/login'); // logout/หมดอายุระหว่างรอ refresh
      }

      req.dpoAuth = { accessToken: session.accessToken, displayName: session.displayName };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { createAuthGate };
