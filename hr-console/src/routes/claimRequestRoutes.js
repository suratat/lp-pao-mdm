const express = require('express');
const { escapeHtml, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');
const { positionRuleFor } = require('../personnelTypes');
const { personnelTypeOptions, positionRules, orgUnitOptions, positionOptions, POSITION_LOCK_SCRIPT } = require('../employmentForm');
const { MAX_LENGTH: JOB_TITLE_MAX_LENGTH, checkJobTitleText } = require('../jobTitleText');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  router.get('/hr/claim-requests/:claimRequestId/approve', async (req, res, next) => {
    const { claimRequestId } = req.params;
    try {
      const token = req.hrAuth.accessToken;
      const [orgUnits, positions, positionTypes] = await Promise.all([
        mdmClient.listOrgUnits(token, { activeOnly: true }),
        mdmClient.listPositions(token, { activeOnly: true }),
        mdmClient.listPositionTypes(token, { activeOnly: false }), // ตำแหน่ง active อาจอยู่ในหมวดที่ปิดแล้ว - ยังต้องแสดงชื่อไทย
      ]);
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
           <label>หน่วยงาน</label>
           <select name="orgUnitId" id="orgUnitId" required>
             <option value="">— เลือกหน่วยงาน —</option>
             ${orgUnitOptions(orgUnits)}
           </select>
           <label>ตำแหน่ง <span class="hint" id="positionHint"></span></label>
           <select name="positionId" id="positionId">
             <option value="">— เลือกตำแหน่ง —</option>
             ${positionOptions(positions, positionTypes)}
           </select>
           <div id="jobTitleRow">
             <label>ชื่อตำแหน่ง/ลักษณะงาน <span class="hint" id="jobTitleHint"></span></label>
             <input name="jobTitleText" id="jobTitleText" maxlength="${JOB_TITLE_MAX_LENGTH}" autocomplete="off" placeholder="เช่น พนักงานขับรถยนต์ หรือ ผู้ช่วยช่างไฟฟ้า" />
           </div>
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
    } catch (err) {
      if (err instanceof MdmApiError) {
        return res
          .status(err.status)
          .send(layout('อนุมัติคำขอเชื่อมตัวตน', renderApiError(err), { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin }));
      }
      next(err);
    }
  });

  router.post('/hr/claim-requests/:claimRequestId/approve', express.urlencoded({ extended: false }), async (req, res, next) => {
    const { claimRequestId } = req.params;
    try {
      const { employeeNo, personnelType, effectiveFrom, appointedDate, levelCode, emailWork, referenceDocument, note } = req.body;
      const orgUnitId = String(req.body.orgUnitId || '').trim();
      const positionId = String(req.body.positionId || '').trim();
      const token = req.hrAuth.accessToken;

      // ตรวจซ้ำที่ server ของ console (ช่องที่ disable/กรองฝั่ง client แก้ผ่าน devtools/curl ได้ - MDM API ตรวจอีกชั้นเสมอ)
      const errors = [];
      const rule = positionRuleFor(personnelType);
      if (rule === 'FORBIDDEN' && positionId) errors.push('ประเภทบุคลากรนี้ไม่มีเลขที่ตำแหน่ง ห้ามระบุเลขที่ตำแหน่ง');
      if (rule === 'REQUIRED' && !positionId) errors.push('ประเภทบุคลากรนี้ต้องระบุเลขที่ตำแหน่ง');

      // หน่วยงานต้องมีอยู่จริงและ active
      if (!orgUnitId) {
        errors.push('กรุณาเลือกหน่วยงาน');
      } else if (!UUID_RE.test(orgUnitId)) {
        errors.push('หน่วยงานที่เลือกไม่ถูกต้อง');
      } else {
        const orgUnits = await mdmClient.listOrgUnits(token, { activeOnly: true });
        if (!orgUnits.some((o) => o.orgUnitId === orgUnitId && o.isActive)) errors.push('ไม่พบหน่วยงานที่เลือก หรือหน่วยงานถูกปิดใช้งานแล้ว');
      }

      // ตำแหน่ง (ถ้าส่งมา) ต้องมีอยู่จริง active และอยู่ในหน่วยงานที่เลือก - ตรวจเฉพาะเมื่อกฎประเภทบุคลากรไม่ได้ปฏิเสธไปแล้ว
      if (positionId && rule !== 'FORBIDDEN') {
        if (!UUID_RE.test(positionId)) {
          errors.push('ตำแหน่งที่เลือกไม่ถูกต้อง');
        } else {
          const positions = await mdmClient.listPositions(token, { activeOnly: true });
          const found = positions.find((p) => p.positionId === positionId && p.isActive);
          if (!found) errors.push('ไม่พบตำแหน่งที่เลือก หรือตำแหน่งถูกปิดใช้งานแล้ว');
          else if (found.orgUnitId !== orgUnitId) errors.push('ตำแหน่งที่เลือกไม่อยู่ในหน่วยงานที่เลือก');
        }
      }

      // ชื่อตำแหน่ง/ลักษณะงาน (ข้อความอิสระ): normalize + ยาว/เลขบัตร + กฎตามประเภท (ประเภทที่ต้องมีตำแหน่งห้ามส่ง, OTHER เลือกอย่างใดอย่างหนึ่ง)
      const jobTitle = checkJobTitleText(req.body.jobTitleText);
      if (jobTitle.error) errors.push(jobTitle.error);
      const jobTitleText = jobTitle.text;
      if (jobTitleText) {
        if (rule === 'REQUIRED') errors.push('ประเภทบุคลากรนี้ต้องใช้เลขที่ตำแหน่ง ห้ามระบุชื่อตำแหน่ง/ลักษณะงานแบบข้อความ');
        else if (rule === 'OPTIONAL' && positionId) errors.push('ประเภทนี้เลือกได้อย่างใดอย่างหนึ่งระหว่างตำแหน่งกับชื่อตำแหน่ง/ลักษณะงาน ห้ามระบุทั้งสองอย่าง');
      }
      if (errors.length > 0) return sendFormErrors(res, req, claimRequestId, errors);

      await mdmClient.resolveClaimRequest(req.hrAuth.accessToken, claimRequestId, {
        action: 'PROVISION',
        employment: {
          employeeNo,
          personnelType,
          orgUnitId,
          positionId: positionId || undefined,
          jobTitleText: jobTitleText || undefined,
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

// orgUnitOptions/positionOptions export ไว้ให้ unit test (ตัวกรอง isActive ซ้ำกับ activeOnly ของ API โดยตั้งใจ - กันไว้อีกชั้น)
module.exports = { createClaimRequestRoutes, orgUnitOptions, positionOptions };
