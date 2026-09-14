const express = require('express');
const { createSessionCookieValue, setSessionCookie, clearSessionCookie } = require('../session/cookieSession');
const { layout } = require('../views/html');

// ข้อความ error ภาษาไทยตาม reason ที่ checkAuthClient.verifyToken คืนมา - ไม่บอกรายละเอียดฝั่ง
// internal (เช่น invalid_client แปลว่า credential ของ Portal เองผิด) ให้ผู้ใช้เห็น
const VERIFY_ERROR_MESSAGES = {
  invalid_or_expired_token: 'ลิงก์เข้าสู่ระบบหมดอายุหรือถูกใช้ไปแล้ว กรุณาเข้าสู่ระบบใหม่อีกครั้ง',
  invalid_client: 'เกิดข้อผิดพลาดในการเชื่อมต่อระบบยืนยันตัวตน กรุณาลองใหม่ภายหลัง',
};
const DEFAULT_VERIFY_ERROR_MESSAGE = 'ไม่สามารถเชื่อมต่อระบบยืนยันตัวตนได้ขณะนี้ กรุณาลองใหม่ภายหลัง';

function errorPage(message) {
  return layout('เข้าสู่ระบบไม่สำเร็จ', `<p class="error">${message}</p>`);
}

// checkAuthClient (optional): ผลจาก security/checkAuthClient.js createCheckAuthClient(...) - ถ้าไม่ได้ตั้งค่า
// (ยังไม่มี CHECK_BASE_URL/CHECK_CLIENT_ID/CHECK_CLIENT_SECRET/PORTAL_AUTH_CALLBACK_URL ใน env) จะ fallback
// ไปใช้ dev-login stub เดิมเหมือนเดิมทุกประการ - dev-login stub เองปิดอัตโนมัติเมื่อ NODE_ENV=production
// เสมอ ไม่ว่าจะตั้ง checkAuthClient หรือไม่ก็ตาม
function createAuthRoutes({ sessionSecret, isProduction, checkAuthClient }) {
  const router = express.Router();

  router.get('/auth/login', (req, res) => {
    if (checkAuthClient) {
      return res.redirect(302, checkAuthClient.buildLoginUrl());
    }
    if (isProduction) {
      return res
        .status(501)
        .send(
          layout(
            'เข้าสู่ระบบ',
            '<p class="error">ยังไม่รองรับการเข้าสู่ระบบผ่าน check.lp-pao.go.th ในเวอร์ชันนี้ (T9 รอบแรก ครอบคลุมเฉพาะ self-service backend + UI เมื่อทราบตัวตนผู้ใช้แล้ว)</p>'
          )
        );
    }
    return res.send(
      layout(
        'เข้าสู่ระบบ (dev)',
        `<p class="error">โหมดพัฒนา/ทดสอบเท่านั้น ไม่ใช่การล็อกอินจริง - production ใช้ path นี้ไม่ได้</p>
         <form method="post" action="/auth/dev-login">
           <label>Person ID (UUID)</label>
           <input name="personId" required pattern="[0-9a-fA-F-]{36}" />
           <button type="submit">เข้าสู่ระบบ (dev)</button>
         </form>`
      )
    );
  });

  // callback จาก check.lp-pao.go.th หลังผู้ใช้ล็อกอินผ่าน ThaID สำเร็จ (seq-01 บรรทัด 724-726):
  // check ส่ง app_token แบบ single-use (60 วิ) มาทาง query string แล้ว Portal ต้องแลกเป็น claims
  // ด้วย POST /api/verify (Basic auth) เอง - ไม่มี state param ส่งกลับมา (ดูหมายเหตุใน checkAuthClient.js)
  router.get('/auth/callback', async (req, res, next) => {
    if (!checkAuthClient) return res.status(404).end();
    try {
      const token = req.query.token;
      if (typeof token !== 'string' || !token) {
        return res.status(400).send(errorPage('ไม่พบ token จากระบบยืนยันตัวตน กรุณาเข้าสู่ระบบใหม่อีกครั้ง'));
      }

      const result = await checkAuthClient.verifyToken(token);
      if (!result.ok) {
        // log แค่ status/reason พอ - ห้าม log token หรือ response body ที่อาจมีข้อมูลส่วนบุคคลปน (rule 1, 7)
        // eslint-disable-next-line no-console
        console.error(`check /api/verify ไม่สำเร็จ (status ${result.status}, reason ${result.reason})`);
        const message = VERIFY_ERROR_MESSAGES[result.reason] || DEFAULT_VERIFY_ERROR_MESSAGE;
        return res.status(result.status === 401 || result.status === 400 ? result.status : 502).send(errorPage(message));
      }

      const personId = result.claims.person_id;
      if (!personId) {
        return res
          .status(403)
          .send(errorPage('ไม่พบข้อมูลบุคลากรสำหรับบัญชีนี้ในระบบ กรุณาติดต่อฝ่ายบุคคล'));
      }

      const cookieToken = await createSessionCookieValue(personId, sessionSecret);
      setSessionCookie(res, cookieToken, { secure: req.protocol === 'https' });
      return res.redirect(302, '/portal/me');
    } catch (err) {
      return next(err);
    }
  });

  router.post('/auth/dev-login', express.urlencoded({ extended: false }), async (req, res, next) => {
    if (isProduction) return res.status(404).end();
    try {
      const { personId } = req.body;
      if (!personId) {
        return res.status(400).send(layout('เข้าสู่ระบบ (dev)', '<p class="error">ต้องระบุ Person ID</p>'));
      }
      const token = await createSessionCookieValue(personId, sessionSecret);
      setSessionCookie(res, token, { secure: req.protocol === 'https' });
      res.redirect(302, '/portal/me');
    } catch (err) {
      next(err);
    }
  });

  router.get('/auth/logout', (req, res) => {
    clearSessionCookie(res, { secure: req.protocol === 'https' });
    res.redirect(302, '/auth/login');
  });

  return router;
}

module.exports = { createAuthRoutes };
