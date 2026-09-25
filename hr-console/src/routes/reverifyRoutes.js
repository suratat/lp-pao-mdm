const express = require('express');
const { escapeHtml, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');

function fmt(value) {
  return value ? String(value).replace('T', ' ').slice(0, 19) : '-';
}

function renderStaleTable(persons) {
  const rows = persons
    .map((p) => {
      const basic = p.basic || {};
      const verification = p.verification || {};
      const name = `${basic.titleTh || ''}${basic.firstNameTh || ''} ${basic.lastNameTh || ''}`.trim() || '(ไม่มีชื่อในสิทธิ์ที่เห็น)';
      return `<tr>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(basic.positionTitle || '-')}</td>
        <td>${escapeHtml(basic.orgUnit?.nameTh || '-')}</td>
        <td><span class="badge badge-${escapeHtml((verification.verificationStatus || '').toLowerCase())}">${escapeHtml(verification.verificationStatus || '-')}</span></td>
        <td>${escapeHtml(fmt(verification.thaidVerifiedAt))}</td>
        <td class="actions">
          <form class="inline" method="post" action="/hr/reverify/${encodeURIComponent(p.personId)}/request">
            <button type="submit">ขอ Reverify ทันที</button>
          </form>
        </td>
      </tr>`;
    })
    .join('\n');

  return `<table>
    <tr><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th>สังกัด</th><th>สถานะยืนยัน</th><th>ยืนยัน ThaID ล่าสุด</th><th>ดำเนินการ</th></tr>
    ${rows || '<tr><td colspan="6">ไม่มีรายการ</td></tr>'}
  </table>`;
}

function createReverifyRoutes({ mdmClient }) {
  const router = express.Router();

  router.get('/hr/reverify', async (req, res, next) => {
    try {
      const verificationStatusParam = req.query.verificationStatus;
      const verificationStatus = Array.isArray(verificationStatusParam)
        ? verificationStatusParam
        : typeof verificationStatusParam === 'string' && verificationStatusParam
          ? verificationStatusParam.split(',')
          : ['STALE', 'EXPIRED'];

      const result = await mdmClient.listStalePersons(req.hrAuth.accessToken, {
        verificationStatus,
        orgUnitId: req.query.orgUnitId || undefined,
        cursor: req.query.cursor,
        limit: 50,
      });

      const message = req.query.requested === '1' ? '<p class="ok">ส่งคำขอ reverify แล้ว</p>' : '';
      const nextLink = result.page?.nextCursor
        ? `<p><a href="/hr/reverify?verificationStatus=${encodeURIComponent(verificationStatus.join(','))}&cursor=${encodeURIComponent(result.page.nextCursor)}">หน้าถัดไป</a></p>`
        : '';

      res.send(
        layout(
          'รายชื่อต้อง Reverify',
          `<h1>รายชื่อที่ข้อมูล ThaID ค้างยืนยัน (STALE/EXPIRED)</h1>
           <p>เกิน REVERIFY_MAX_AGE_DAYS นับจากยืนยันครั้งล่าสุด หรือบัตรประชาชนใกล้/พ้นวันหมดอายุตาม REVERIFY_ON_CARD_EXPIRY_DAYS (คำนวณสถานะโดยระบบอัตโนมัติ)</p>
           <form method="get" action="/hr/reverify">
             <label><input type="checkbox" name="verificationStatus" value="STALE" ${verificationStatus.includes('STALE') ? 'checked' : ''} onchange="this.form.requestSubmit()" /> STALE</label>
             <label><input type="checkbox" name="verificationStatus" value="EXPIRED" ${verificationStatus.includes('EXPIRED') ? 'checked' : ''} onchange="this.form.requestSubmit()" /> EXPIRED</label>
           </form>
           ${message}
           ${renderStaleTable(result.data)}
           ${nextLink}`,
          { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin }
        )
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/hr/reverify/:personId/request', async (req, res, next) => {
    try {
      await mdmClient.requestReverify(req.hrAuth.accessToken, req.params.personId);
      res.redirect(302, '/hr/reverify?requested=1');
    } catch (err) {
      if (err instanceof MdmApiError) {
        return res.status(err.status).send(
          layout(
            'รายชื่อต้อง Reverify',
            `<p class="error">ขอ reverify ไม่สำเร็จ (${escapeHtml(err.status)}): ${escapeHtml(err.problem?.detail || err.problem?.title || '')}</p><p><a href="/hr/reverify">ย้อนกลับ</a></p>`,
            { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin }
          )
        );
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createReverifyRoutes };
