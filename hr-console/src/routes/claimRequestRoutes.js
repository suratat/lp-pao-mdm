const express = require('express');
const { escapeHtml, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');
const { PERSONNEL_TYPES, positionRuleFor } = require('../personnelTypes');
const { POSITION_NO_PATTERN, POSITION_NO_MESSAGE } = require('../masterData');

function fmt(value) {
  return value ? String(value).replace('T', ' ').slice(0, 19) : '-';
}

function renderApiError(err) {
  if (err instanceof MdmApiError) {
    return `<p class="error">MDM API ปฏิเสธคำขอ (${escapeHtml(err.status)}): ${escapeHtml(err.problem?.detail || err.problem?.title || '')}</p>`;
  }
  return `<p class="error">เกิดข้อผิดพลาดที่ไม่คาดคิด</p>`;
}

function renderClaimRequestsTable(claimRequests) {
  const rows = claimRequests
    .map(
      (c) => `<tr>
        <td>${escapeHtml(c.displayName || '(ไม่ทราบชื่อ)')}</td>
        <td><span class="badge badge-${escapeHtml(c.status.toLowerCase())}">${escapeHtml(c.status)}</span></td>
        <td>${c.attemptCount}</td>
        <td>${escapeHtml(fmt(c.firstSeenAt))}</td>
        <td>${escapeHtml(fmt(c.lastSeenAt))}</td>
        <td class="actions">
          <a href="/hr/claim-requests/${encodeURIComponent(c.claimRequestId)}/approve">อนุมัติ</a>
          <form class="inline" method="post" action="/hr/claim-requests/${encodeURIComponent(c.claimRequestId)}/reject" onsubmit="return confirm('ยืนยันปฏิเสธคำขอนี้?')">
            <button type="submit">ปฏิเสธ</button>
          </form>
        </td>
      </tr>`
    )
    .join('\n');

  return `<table>
    <tr><th>ชื่อจาก ThaID</th><th>สถานะ</th><th>จำนวนครั้งที่ล็อกอิน</th><th>พบครั้งแรก</th><th>พบล่าสุด</th><th>ดำเนินการ</th></tr>
    ${rows || '<tr><td colspan="6">ไม่มีรายการ</td></tr>'}
  </table>`;
}

function personnelTypeOptions() {
  return PERSONNEL_TYPES.map((t) => `<option value="${escapeHtml(t.value)}">${escapeHtml(t.label)}</option>`).join('\n');
}

function positionRules() {
  return Object.fromEntries(PERSONNEL_TYPES.map((t) => [t.value, t.positionRule]));
}

// lock ช่องเลขที่ตำแหน่งตามประเภทบุคลากร (ฝั่ง client เพื่อ UX เท่านั้น - server ของ console และ MDM API ตรวจซ้ำเสมอ):
//   FORBIDDEN -> ล้างค่า + disable + ไม่ required | REQUIRED -> enable + required | OPTIONAL -> enable ไม่ required
// apply() รันตอนโหลดหน้า (select มีค่าเริ่มต้นอยู่แล้ว) + ทุกครั้งที่เปลี่ยนประเภท + ตอน pageshow (เบราว์เซอร์คืนค่าฟอร์มเดิมเมื่อกด
// Back/bfcache โดยไม่ยิง change event - ถ้าไม่ apply ซ้ำ ช่องอาจค้างสถานะไม่ตรงกับประเภทที่เลือก)
const POSITION_LOCK_SCRIPT = `<script>
(function () {
  var select = document.getElementById('personnelType');
  var input = document.getElementById('positionNo');
  var hint = document.getElementById('positionNoHint');
  var rules = JSON.parse(select.getAttribute('data-position-rules'));
  var re = new RegExp(input.getAttribute('data-pattern'));
  var patternMessage = input.getAttribute('data-pattern-message');
  var HINTS = { REQUIRED: '(จำเป็นต้องระบุ)', FORBIDDEN: '(ประเภทนี้ไม่มีเลขที่ตำแหน่ง - ช่องถูกปิด)', OPTIONAL: '(ไม่บังคับ)' };

  function checkPattern() {
    var v = input.value.trim();
    input.setCustomValidity(v === '' || re.test(v) ? '' : patternMessage);
  }
  function apply() {
    var rule = rules[select.value] || 'OPTIONAL';
    if (rule === 'FORBIDDEN') {
      input.value = '';
      input.disabled = true;
      input.required = false;
      input.setCustomValidity('');
    } else {
      input.disabled = false;
      input.required = rule === 'REQUIRED';
      checkPattern();
    }
    hint.textContent = HINTS[rule];
  }

  select.addEventListener('change', apply);
  input.addEventListener('input', checkPattern);
  input.addEventListener('blur', function () { input.value = input.value.trim(); checkPattern(); });
  window.addEventListener('pageshow', apply);
  apply();
})();
</script>`;

function renderFormErrors(errors) {
  return `<ul class="error">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
}

function createClaimRequestRoutes({ mdmClient }) {
  const router = express.Router();

  function sendFormErrors(res, req, claimRequestId, errors) {
    return res
      .status(422)
      .send(
        layout(
          'อนุมัติคำขอเชื่อมตัวตน',
          `${renderFormErrors(errors)}<p><a href="/hr/claim-requests/${encodeURIComponent(claimRequestId)}/approve">กรอกใหม่</a></p>`,
          { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin }
        )
      );
  }

  router.get('/hr/claim-requests', async (req, res, next) => {
    try {
      const status = req.query.status || 'PENDING_HR';
      const result = await mdmClient.listClaimRequests(req.hrAuth.accessToken, { status, cursor: req.query.cursor, limit: 50 });
      const message = req.query.resolved === 'approved' ? '<p class="ok">อนุมัติคำขอเรียบร้อยแล้ว</p>' : req.query.resolved === 'rejected' ? '<p class="ok">ปฏิเสธคำขอเรียบร้อยแล้ว</p>' : '';
      const nextLink = result.page?.nextCursor
        ? `<p><a href="/hr/claim-requests?status=${encodeURIComponent(status)}&cursor=${encodeURIComponent(result.page.nextCursor)}">หน้าถัดไป</a></p>`
        : '';
      res.send(
        layout(
          'คำขอเชื่อมตัวตน',
          `<h1>คำขอเชื่อมตัวตน (Claim Requests)</h1>
           ${message}
           <p>
             <a href="/hr/claim-requests?status=PENDING_HR">รอดำเนินการ</a> ·
             <a href="/hr/claim-requests?status=LINKED">เชื่อมแล้ว</a> ·
             <a href="/hr/claim-requests?status=REJECTED">ปฏิเสธแล้ว</a>
           </p>
           ${renderClaimRequestsTable(result.data)}
           ${nextLink}`,
          { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin }
        )
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/hr/claim-requests/:claimRequestId/approve', (req, res) => {
    const { claimRequestId } = req.params;
    res.send(
      layout(
        'อนุมัติคำขอเชื่อมตัวตน',
        `<h1>อนุมัติ - สร้างบุคลากรใหม่</h1>
         <p>ระบบจะสร้าง record บุคคลใหม่และเชื่อมกับการล็อกอิน ThaID ครั้งนี้ (ใช้ pid ที่บันทึกไว้ตอน login โดยอัตโนมัติ)</p>
         <form method="post" action="/hr/claim-requests/${encodeURIComponent(claimRequestId)}/approve">
           <label>เลขบัตรประชาชน (employeeNo) <span class="hint">ต้องตรงกับที่บุคคลนี้ใช้ล็อกอิน ThaID - ห้ามเผยแพร่/บันทึกไว้นอกระบบนี้</span></label>
           <input name="employeeNo" required pattern="[0-9]{13}" maxlength="13" autocomplete="off" />
           <label>ประเภทบุคลากร</label>
           <select name="personnelType" id="personnelType" required data-position-rules="${escapeHtml(JSON.stringify(positionRules()))}">${personnelTypeOptions()}</select>
           <label>รหัสหน่วยงาน (orgUnitId, UUID) <span class="hint">ดูได้จากระบบ HR เดิมหรือฐานข้อมูล mdm.org_unit</span></label>
           <input name="orgUnitId" required pattern="[0-9a-fA-F-]{36}" />
           <label>เลขที่ตำแหน่ง <span class="hint" id="positionNoHint"></span></label>
           <input name="positionNo" id="positionNo" maxlength="50" autocomplete="off" placeholder="เช่น 52-1-07-3106-003 หรือเลขลำดับของลูกจ้างประจำ"
                  pattern="${escapeHtml(POSITION_NO_PATTERN)}" data-pattern="${escapeHtml(POSITION_NO_PATTERN)}"
                  data-pattern-message="${escapeHtml(POSITION_NO_MESSAGE)}" title="${escapeHtml(POSITION_NO_MESSAGE)}" />
           <label>วันเริ่มมีผล (effectiveFrom)</label>
           <input name="effectiveFrom" type="date" required />
           <label>วันบรรจุ (appointedDate)</label>
           <input name="appointedDate" type="date" />
           <label>ระดับ/ชั้น (levelCode)</label>
           <input name="levelCode" />
           <label>อีเมลที่ทำงาน</label>
           <input name="emailWork" type="email" />
           <label>เลขที่คำสั่ง (referenceDocument)</label>
           <input name="referenceDocument" />
           <label>หมายเหตุ</label>
           <textarea name="note" maxlength="500"></textarea>
           <button type="submit" style="margin-top:1rem">อนุมัติและสร้างบุคลากร</button>
         </form>
         ${POSITION_LOCK_SCRIPT}
         <p><a href="/hr/claim-requests">ย้อนกลับ</a></p>`,
        { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin }
      )
    );
  });

  router.post('/hr/claim-requests/:claimRequestId/approve', express.urlencoded({ extended: false }), async (req, res, next) => {
    const { claimRequestId } = req.params;
    try {
      const { employeeNo, personnelType, orgUnitId, effectiveFrom, appointedDate, levelCode, emailWork, referenceDocument, note } = req.body;
      const positionNo = String(req.body.positionNo || '').trim();

      // ตรวจกฎเลขที่ตำแหน่งซ้ำที่ server ของ console (ช่องที่ disable ฝั่ง client แก้ผ่าน devtools ได้ - MDM API ตรวจอีกชั้นเสมอ)
      const rule = positionRuleFor(personnelType);
      const errors = [];
      if (rule === 'FORBIDDEN' && positionNo) errors.push('ประเภทบุคลากรนี้ไม่มีเลขที่ตำแหน่ง ห้ามระบุเลขที่ตำแหน่ง');
      if (rule === 'REQUIRED' && !positionNo) errors.push('ประเภทบุคลากรนี้ต้องระบุเลขที่ตำแหน่ง');
      if (errors.length > 0) return sendFormErrors(res, req, claimRequestId, errors);

      // แปลงเลขที่ตำแหน่งที่กรอก (ข้อความ) เป็น positionId (UUID) ที่ MDM API ต้องการ - ต้องเป็นตำแหน่งที่ยังใช้งานอยู่
      let positionId;
      if (positionNo) {
        const positions = await mdmClient.listPositions(req.hrAuth.accessToken, { activeOnly: true });
        const found = positions.find((p) => p.positionNo === positionNo);
        if (!found) return sendFormErrors(res, req, claimRequestId, [`ไม่พบเลขที่ตำแหน่ง "${positionNo}" ที่ยังใช้งานอยู่`]);
        positionId = found.positionId;
      }

      await mdmClient.resolveClaimRequest(req.hrAuth.accessToken, claimRequestId, {
        action: 'PROVISION',
        employment: {
          employeeNo,
          personnelType,
          orgUnitId,
          positionId,
          effectiveFrom,
          appointedDate: appointedDate || undefined,
          levelCode: levelCode || undefined,
          emailWork: emailWork || undefined,
          referenceDocument: referenceDocument || undefined,
        },
        note: note || undefined,
      });
      res.redirect(302, '/hr/claim-requests?resolved=approved');
    } catch (err) {
      if (err instanceof MdmApiError) {
        return res
          .status(err.status)
          .send(
            layout(
              'อนุมัติคำขอเชื่อมตัวตน',
              `${renderApiError(err)}<p><a href="/hr/claim-requests/${encodeURIComponent(claimRequestId)}/approve">กรอกใหม่</a></p>`,
              { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin }
            )
          );
      }
      next(err);
    }
  });

  router.post('/hr/claim-requests/:claimRequestId/reject', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      await mdmClient.resolveClaimRequest(req.hrAuth.accessToken, req.params.claimRequestId, { action: 'REJECT' });
      res.redirect(302, '/hr/claim-requests?resolved=rejected');
    } catch (err) {
      if (err instanceof MdmApiError) {
        return res.status(err.status).send(layout('ปฏิเสธคำขอ', renderApiError(err), { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin }));
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createClaimRequestRoutes };
