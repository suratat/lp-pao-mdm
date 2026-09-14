const express = require('express');
const { createSessionCookieValue, setSessionCookie, clearSessionCookie } = require('../session/cookieSession');
const { layout } = require('../views/html');

// การล็อกอินจริงของ Portal (รับ personId ของผู้ใช้จาก check.lp-pao.go.th) ยังไม่ implement ในรอบนี้
// เอกสารออกแบบไม่ได้ระบุ wire format ของ session/handoff ที่ check ออกให้ app ทั่วไป (ต่างจาก ThaID→check
// ที่มีรายละเอียดครบ) และเป็นงานฝั่งรีโป check (ใกล้เคียง T7) - ดู README ของ portal/ หัวข้อ "ยังไม่ครอบคลุม"
// ที่นี่ทำได้แค่ placeholder สำหรับ dev/test เพื่อให้ทดสอบ self-service flow ทั้งหมดได้จริง โดยปิดใช้งาน
// อัตโนมัติเมื่อ NODE_ENV=production กันไม่ให้กลายเป็นช่องโหว่จริงในโปรดักชัน
function createAuthRoutes({ sessionSecret, isProduction }) {
  const router = express.Router();

  router.get('/auth/login', (req, res) => {
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
