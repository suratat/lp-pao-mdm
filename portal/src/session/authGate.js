const { COOKIE_NAME, parseCookies, readPersonIdFromCookieValue } = require('./cookieSession');

// ตรวจ session cookie ของ Portal แล้วเติม req.personId - ถ้าไม่มี/หมดอายุ ให้ redirect ไปหน้า login
// ช่องทางที่ req.personId ถูกตั้งค่าจริงในโปรดักชัน (การล็อกอินผ่าน check.lp-pao.go.th) ยังไม่ implement
// ในรอบนี้ - ดู session/devLogin.js และหมายเหตุท้าย README
function createAuthGate({ sessionSecret }) {
  return async function authGate(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const personId = await readPersonIdFromCookieValue(cookies[COOKIE_NAME], sessionSecret);
    if (!personId) {
      return res.redirect(302, '/auth/login');
    }
    req.personId = personId;
    next();
  };
}

module.exports = { createAuthGate };
