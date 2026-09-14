const express = require('express');
const { escapeHtml, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');

function renderError(err) {
  if (err instanceof MdmApiError) {
    return `<p class="error">MDM API ปฏิเสธคำขอ (${escapeHtml(err.status)}): ${escapeHtml(err.problem?.detail || err.problem?.title || '')}</p>`;
  }
  return `<p class="error">เกิดข้อผิดพลาดที่ไม่คาดคิด</p>`;
}

function createMeRoutes({ mdmClient }) {
  const router = express.Router();

  router.get('/portal/', (req, res) => res.redirect(302, '/portal/me'));

  router.get('/portal/me', async (req, res, next) => {
    try {
      const me = await mdmClient.getMe(req.personId);
      const basic = me.basic || {};
      const verification = me.verification || {};
      const employment = me.employment || {};
      res.send(
        layout(
          'ข้อมูลของฉัน',
          `<h1>ข้อมูลของฉัน</h1>
           <table>
             <tr><th>ชื่อ-สกุล</th><td>${escapeHtml(basic.titleTh || '')}${escapeHtml(basic.firstNameTh || '')} ${escapeHtml(basic.lastNameTh || '')}</td></tr>
             <tr><th>เลขประจำตัว</th><td>${escapeHtml(basic.employeeNo || '-')}</td></tr>
             <tr><th>ตำแหน่ง</th><td>${escapeHtml(basic.positionTitle || '-')}</td></tr>
             <tr><th>สังกัด</th><td>${escapeHtml(basic.orgUnit?.nameTh || '-')}</td></tr>
             <tr><th>สถานะ</th><td>${escapeHtml(me.status)}</td></tr>
             <tr><th>สถานะการยืนยัน ThaID</th><td>${escapeHtml(verification.verificationStatus || '-')}</td></tr>
             <tr><th>วันบรรจุ</th><td>${escapeHtml(employment.appointedDate || '-')}</td></tr>
           </table>`
        )
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/portal/me/contact', async (req, res, next) => {
    try {
      const me = await mdmClient.getMe(req.personId);
      const c = me.contact || {};
      const addr = c.currentAddress || {};
      res.send(
        layout(
          'แก้ไขข้อมูลติดต่อ',
          `<h1>แก้ไขข้อมูลติดต่อ</h1>
           <form method="post" action="/portal/me/contact">
             <label>มือถือ</label><input name="mobilePhone" value="${escapeHtml(c.mobilePhone)}" />
             <label>โทรศัพท์สำรอง</label><input name="phoneAlt" value="${escapeHtml(c.phoneAlt)}" />
             <label>อีเมลส่วนตัว</label><input name="emailPersonal" type="email" value="${escapeHtml(c.emailPersonal)}" />
             <label>LINE ID</label><input name="lineId" value="${escapeHtml(c.lineId)}" />
             <label>บ้านเลขที่</label><input name="houseNo" value="${escapeHtml(addr.houseNo)}" />
             <label>ที่อยู่แบบเต็ม</label><textarea name="fullText">${escapeHtml(addr.fullText)}</textarea>
             <button type="submit">บันทึก</button>
           </form>`
        )
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/portal/me/contact', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const { mobilePhone, phoneAlt, emailPersonal, lineId, houseNo, fullText } = req.body;
      await mdmClient.updateContact(req.personId, {
        mobilePhone: mobilePhone || null,
        phoneAlt: phoneAlt || null,
        emailPersonal: emailPersonal || null,
        lineId: lineId || null,
        currentAddress: { houseNo: houseNo || undefined, fullText: fullText || undefined },
      });
      res.redirect(302, '/portal/me');
    } catch (err) {
      if (err instanceof MdmApiError) {
        return res.status(err.status).send(layout('แก้ไขข้อมูลติดต่อ', renderError(err)));
      }
      next(err);
    }
  });

  router.get('/portal/me/emergency-contacts', async (req, res, next) => {
    try {
      const me = await mdmClient.getMe(req.personId);
      const contacts = me.emergencyContacts || [];
      const rows = [0, 1, 2].map((i) => {
        const c = contacts[i] || {};
        return `<fieldset>
          <legend>ผู้ติดต่อฉุกเฉิน ${i + 1}</legend>
          <label>ชื่อ-สกุล</label><input name="fullName_${i}" value="${escapeHtml(c.fullName)}" />
          <label>ความสัมพันธ์</label><input name="relationship_${i}" value="${escapeHtml(c.relationship)}" />
          <label>เบอร์โทร</label><input name="phone_${i}" value="${escapeHtml(c.phone)}" />
        </fieldset>`;
      });
      res.send(
        layout(
          'ผู้ติดต่อฉุกเฉิน',
          `<h1>ผู้ติดต่อฉุกเฉิน (สูงสุด 3 คน)</h1>
           <form method="post" action="/portal/me/emergency-contacts">
             ${rows.join('\n')}
             <button type="submit">บันทึกทั้งหมด</button>
           </form>`
        )
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/portal/me/emergency-contacts', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const contacts = [0, 1, 2]
        .map((i) => ({
          fullName: req.body[`fullName_${i}`],
          relationship: req.body[`relationship_${i}`],
          phone: req.body[`phone_${i}`],
          priority: i + 1,
        }))
        .filter((c) => c.fullName && c.relationship && c.phone);
      await mdmClient.replaceEmergencyContacts(req.personId, contacts);
      res.redirect(302, '/portal/me');
    } catch (err) {
      if (err instanceof MdmApiError) {
        return res.status(err.status).send(layout('ผู้ติดต่อฉุกเฉิน', renderError(err)));
      }
      next(err);
    }
  });

  router.get('/portal/me/report-identity-issue', (req, res) => {
    res.send(
      layout(
        'แจ้งข้อมูลระบุตัวตนผิด',
        `<h1>แจ้งข้อมูลระบุตัวตนผิด</h1>
         <p>ระบบนี้แก้ข้อมูลระบุตัวตน (ชื่อ/ที่อยู่ตามทะเบียนบ้าน ฯลฯ) เองไม่ได้ กรุณาไปแก้ไขที่สำนักทะเบียน
         (อำเภอ/เทศบาล) แล้วเข้าสู่ระบบด้วย ThaID อีกครั้งเพื่อให้ข้อมูลอัปเดตอัตโนมัติ</p>
         <form method="post" action="/portal/me/report-identity-issue">
           <label>ฟิลด์ที่ผิด</label><input name="fieldKey" placeholder="เช่น identity.reg_address_text" required />
           <label>รายละเอียด</label><textarea name="description" maxlength="1000" required></textarea>
           <button type="submit">ส่งเรื่อง</button>
         </form>`
      )
    );
  });

  router.post('/portal/me/report-identity-issue', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      await mdmClient.reportIdentityIssue(req.personId, {
        fieldKey: req.body.fieldKey,
        description: req.body.description,
      });
      res.send(layout('แจ้งข้อมูลระบุตัวตนผิด', '<p class="ok">รับแจ้งแล้ว</p>'));
    } catch (err) {
      if (err instanceof MdmApiError) {
        return res.status(err.status).send(layout('แจ้งข้อมูลระบุตัวตนผิด', renderError(err)));
      }
      next(err);
    }
  });

  router.get('/portal/me/consents', async (req, res, next) => {
    try {
      const consents = await mdmClient.listConsents(req.personId);
      const rows = consents
        .map(
          (c) => `<tr>
            <td>${escapeHtml(c.purposeNameTh)}</td>
            <td>${escapeHtml(c.status || 'ยังไม่เคยตอบ')}</td>
            <td>
              <form method="post" action="/portal/me/consents/${encodeURIComponent(c.purposeCode)}" style="display:inline">
                <input type="hidden" name="policyVersion" value="v1" />
                <input type="hidden" name="status" value="GRANTED" />
                <button type="submit">ยินยอม</button>
              </form>
              <form method="post" action="/portal/me/consents/${encodeURIComponent(c.purposeCode)}" style="display:inline">
                <input type="hidden" name="policyVersion" value="v1" />
                <input type="hidden" name="status" value="WITHDRAWN" />
                <button type="submit">ถอนความยินยอม</button>
              </form>
            </td>
          </tr>`
        )
        .join('\n');
      res.send(
        layout(
          'ความยินยอม',
          `<h1>ความยินยอมการใช้ข้อมูล</h1>
           <table><tr><th>วัตถุประสงค์</th><th>สถานะ</th><th>การดำเนินการ</th></tr>${rows}</table>`
        )
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/portal/me/consents/:purposeCode', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      await mdmClient.setConsent(req.personId, req.params.purposeCode, {
        status: req.body.status,
        policyVersion: req.body.policyVersion,
      });
      res.redirect(302, '/portal/me/consents');
    } catch (err) {
      if (err instanceof MdmApiError) {
        return res.status(err.status).send(layout('ความยินยอม', renderError(err)));
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createMeRoutes };
