const express = require('express');
const { escapeHtml, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');
const { PERSONNEL_TYPES } = require('../personnelTypes');

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

function createClaimRequestRoutes({ mdmClient }) {
  const router = express.Router();

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
           <select name="personnelType" required>${personnelTypeOptions()}</select>
           <label>รหัสหน่วยงาน (orgUnitId, UUID) <span class="hint">ดูได้จากระบบ HR เดิมหรือฐานข้อมูล mdm.org_unit</span></label>
           <input name="orgUnitId" required pattern="[0-9a-fA-F-]{36}" />
           <label>เลขที่ตำแหน่ง (positionId, UUID) <span class="hint">เว้นว่างได้สำหรับพนักงานจ้าง/จ้างเหมาที่ไม่มีเลขที่ตำแหน่ง</span></label>
           <input name="positionId" pattern="[0-9a-fA-F-]{36}" />
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
         <p><a href="/hr/claim-requests">ย้อนกลับ</a></p>`,
        { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin }
      )
    );
  });

  router.post('/hr/claim-requests/:claimRequestId/approve', express.urlencoded({ extended: false }), async (req, res, next) => {
    const { claimRequestId } = req.params;
    try {
      const { employeeNo, personnelType, orgUnitId, positionId, effectiveFrom, appointedDate, levelCode, emailWork, referenceDocument, note } =
        req.body;
      await mdmClient.resolveClaimRequest(req.hrAuth.accessToken, claimRequestId, {
        action: 'PROVISION',
        employment: {
          employeeNo,
          personnelType,
          orgUnitId,
          positionId: positionId || undefined,
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
