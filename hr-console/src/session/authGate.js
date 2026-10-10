const { decodeScopes } = require('./tokenScopes');
const { newCsrfToken } = require('./csrf');
const { COOKIE_NAME, parseCookies, clearSessionCookie } = require('./sessionCookie');

const REFRESH_BUFFER_MS = 15_000;

// ตรวจ session ของ HR Console (cookie เก็บแค่ session id -> ดู token จาก sessionStore ฝั่งเซิร์ฟเวอร์) แล้วเติม
// req.hrAuth = { accessToken, displayName, isMasterDataAdmin } ให้ route ถัดไปใช้
// ถ้า access token ใกล้หมดอายุ (ภายใน REFRESH_BUFFER_MS) จะ refresh ด้วย refresh_token ให้อัตโนมัติ (silent refresh)
// แล้วอัปเดตใน store (ไม่ต้อง Set-Cookie ใหม่) - ถ้า refresh ไม่สำเร็จ หรือไม่มี session ให้ redirect ไปหน้า login
//
// single-flight: realm ตั้ง revokeRefreshToken=true (refresh token ใช้ได้ครั้งเดียว) ถ้าสอง request ของ session เดียวกัน
// เห็น token ใกล้หมดอายุพร้อมกันแล้วต่างคนต่าง refresh ด้วย refresh token ตัวเดิม ตัวที่สองจะได้ invalid_grant และ
// ถูกเด้งไป login ทั้งที่ session ยังดี - จึงรวมให้เหลือ refresh ครั้งเดียวต่อ session และให้ request ที่เหลือรอผลเดียวกัน
// jsonPathRe: path ที่เรียกด้วย fetch (ตอบ JSON) เช่นปุ่มตรวจสอบอีเมล - ไม่มี session/หมดอายุให้ 401 JSON แทนการ redirect ไปหน้า login
function createAuthGate({ keycloakAuthClient, verifyIdToken, sessionStore, isProduction, jsonPathRe = null }) {
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
    // กันกรณีถูกถอด role hr_officer ระหว่างที่ session ยังไม่หมดอายุ (id_token ใช้ตรวจแล้วทิ้ง ไม่เก็บ)
    if (result.tokens.id_token) {
      try {
        const identity = await verifyIdToken(result.tokens.id_token);
        if (!identity.isHrOfficer) return false;
        patch.displayName = identity.displayName;
        // ถูกถอด/เพิ่ม hr_master_data_admin ระหว่าง session ก็มีผลตอน refresh (MDM API ตรวจ role จาก access token ซ้ำอยู่แล้ว)
        patch.isMasterDataAdmin = identity.isMasterDataAdmin;
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
      const toLogin = () =>
        jsonPathRe && jsonPathRe.test(req.path)
          ? res.status(401).set('Cache-Control', 'no-store').json({ status: 'unauthorized', message: 'กรุณาเข้าสู่ระบบใหม่' })
          : res.redirect(302, '/auth/login');
      let session = sessionStore.get(sid);
      if (!session) return toLogin();

      if (Date.now() > session.accessTokenExpiresAt - REFRESH_BUFFER_MS) {
        const refreshed = await refreshOnce(sid);
        if (!refreshed) {
          sessionStore.delete(sid);
          clearSessionCookie(res, { secure });
          return toLogin();
        }
        session = sessionStore.get(sid);
        if (!session) return toLogin(); // logout/หมดอายุระหว่างรอ refresh
      }

      // session ที่สร้างก่อนมี CSRF token (ค้างอยู่ตอน deploy) -> ออก token ให้ตอนนี้
      if (!session.csrfToken) {
        sessionStore.update(sid, { csrfToken: newCsrfToken() });
        session = sessionStore.get(sid);
      }

      req.hrAuth = {
        accessToken: session.accessToken,
        displayName: session.displayName,
        isMasterDataAdmin: session.isMasterDataAdmin === true,
        csrfToken: session.csrfToken,
        scopes: decodeScopes(session.accessToken), // สำหรับ UI เท่านั้น ดู tokenScopes.js
      };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { createAuthGate };
