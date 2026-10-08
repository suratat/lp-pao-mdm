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
             ${basic.jobTitleText ? `<tr><th>ชื่อตำแหน่ง/ลักษณะงาน</th><td>${escapeHtml(basic.jobTitleText)}</td></tr>` : ''}
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

  // ผู้ติดต่อฉุกเฉิน (สูงสุด 3 ช่อง) - ความยาวสูงสุดตรงกับคอลัมน์ใน mdm.emergency_contact (เกินแล้ว DB ปฏิเสธเป็น 500)
  const EMERGENCY_SLOTS = [0, 1, 2];
  const EMERGENCY_LIMITS = { fullName: 200, relationship: 50, phone: 20 };
  const EMERGENCY_LABELS = { fullName: 'ชื่อ-สกุล', relationship: 'ความสัมพันธ์', phone: 'เบอร์โทร' };

  function renderEmergencyForm(slots, { errors = [], saved = null } = {}) {
    const fieldsets = EMERGENCY_SLOTS.map((i) => {
      const c = slots[i] || {};
      return `<fieldset>
          <legend>ผู้ติดต่อฉุกเฉิน ${i + 1}</legend>
          <label>ชื่อ-สกุล</label><input name="fullName_${i}" maxlength="${EMERGENCY_LIMITS.fullName}" value="${escapeHtml(c.fullName)}" />
          <label>ความสัมพันธ์</label><input name="relationship_${i}" maxlength="${EMERGENCY_LIMITS.relationship}" value="${escapeHtml(c.relationship)}" />
          <label>เบอร์โทร</label><input name="phone_${i}" maxlength="${EMERGENCY_LIMITS.phone}" value="${escapeHtml(c.phone)}" />
        </fieldset>`;
    });
    return layout(
      'ผู้ติดต่อฉุกเฉิน',
      `<h1>ผู้ติดต่อฉุกเฉิน (สูงสุด 3 คน)</h1>
       ${saved !== null ? `<p class="ok">บันทึกแล้ว ${saved} คน</p>` : ''}
       ${errors.map((e) => `<p class="error">${escapeHtml(e)}</p>`).join('')}
       <p class="hint">แต่ละคนต้องกรอกให้ครบทั้ง 3 ช่อง (ชื่อ-สกุล ความสัมพันธ์ เบอร์โทร) หรือเว้นว่างทั้งหมดเพื่อไม่ระบุ/ลบคนนั้น</p>
       <form method="post" action="/portal/me/emergency-contacts">
         ${fieldsets.join('\n')}
         <button type="submit">บันทึกทั้งหมด</button>
       </form>`
    );
  }

  router.get('/portal/me/emergency-contacts', async (req, res, next) => {
    try {
      const me = await mdmClient.getMe(req.personId);
      // ใส่ตามช่อง (priority) ไม่ใช่ตามลำดับในรายการ: ช่อง 2 ว่างแต่ช่อง 3 มี ต้องแสดงช่อง 3 ที่ช่อง 3
      const slots = EMERGENCY_SLOTS.map((i) => (me.emergencyContacts || []).find((c) => c.priority === i + 1) || {});
      // saved มาจาก query ที่เรากำหนดเองตอน redirect เท่านั้น - รับเฉพาะเลข 0-3 (ไม่สะท้อนข้อความอื่นลงหน้า)
      const saved = /^[0-3]$/.test(String(req.query.saved)) ? Number(req.query.saved) : null;
      res.send(renderEmergencyForm(slots, { saved }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/portal/me/emergency-contacts', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const slots = EMERGENCY_SLOTS.map((i) => ({
        fullName: String(req.body[`fullName_${i}`] ?? '').trim(),
        relationship: String(req.body[`relationship_${i}`] ?? '').trim(),
        phone: String(req.body[`phone_${i}`] ?? '').trim(),
      }));

      // เดิมกรองทิ้งเงียบๆ แถวที่ไม่ครบ 3 ช่อง -> กรอกชื่อ+เบอร์แต่ลืมความสัมพันธ์ = ส่ง [] ให้ API (200 "[]") แล้ว redirect เหมือนสำเร็จ ข้อมูลหาย
      // (และถ้ามีผู้ติดต่อเดิม จะถูกแทนที่ด้วยรายการว่าง) ตอนนี้: แถวที่กรอกบางส่วน = ปฏิเสธทั้งฟอร์มพร้อมคงค่าที่พิมพ์ไว้
      const errors = [];
      slots.forEach((slot, i) => {
        const missing = Object.keys(EMERGENCY_LABELS).filter((k) => !slot[k]);
        const filled = missing.length < 3;
        if (filled && missing.length > 0) {
          errors.push(`ผู้ติดต่อ ${i + 1}: กรอกไม่ครบ ขาด ${missing.map((k) => EMERGENCY_LABELS[k]).join(', ')} (ต้องกรอกครบทั้ง 3 ช่อง หรือเว้นว่างทั้งหมด)`);
        }
        for (const [key, max] of Object.entries(EMERGENCY_LIMITS)) {
          if (slot[key].length > max) errors.push(`ผู้ติดต่อ ${i + 1}: ${EMERGENCY_LABELS[key]} ยาวเกิน ${max} ตัวอักษร`);
        }
      });
      if (errors.length > 0) return res.status(422).send(renderEmergencyForm(slots, { errors }));

      const contacts = slots
        .map((slot, i) => ({ ...slot, priority: i + 1 }))
        .filter((c) => c.fullName && c.relationship && c.phone);
      const saved = await mdmClient.replaceEmergencyContacts(req.personId, contacts);

      // ยืนยันจากคำตอบของ API ว่าบันทึกครบตามที่ส่ง ไม่เชื่อแค่ว่าไม่มี error (คำตอบ 200 ที่ไม่ตรงกับที่ส่ง = ไม่แจ้งว่าสำเร็จ)
      if (!Array.isArray(saved) || saved.length !== contacts.length) {
        return res.status(502).send(renderEmergencyForm(slots, { errors: ['ระบบไม่ได้บันทึกผู้ติดต่อตามที่ส่ง กรุณาลองใหม่อีกครั้ง'] }));
      }
      return res.redirect(303, `/portal/me/emergency-contacts?saved=${saved.length}`);
    } catch (err) {
      if (err instanceof MdmApiError) {
        return res.status(err.status).send(layout('ผู้ติดต่อฉุกเฉิน', renderError(err)));
      }
      return next(err);
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
