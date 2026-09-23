const express = require('express');
const { escapeHtml, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');

function fmt(value) {
  return value ? String(value).replace('T', ' ').slice(0, 19) : '-';
}

// <input type="datetime-local"> ส่งค่ามาแบบ "YYYY-MM-DDTHH:mm" (ไม่มีวินาที/timezone) ซึ่งไม่ตรงกับ
// รูปแบบ date-time (RFC 3339) ที่ OpenAPI validator ของ MDM API บังคับ ("from"/"to"/"since" ต้อง parse
// ผ่าน Date แล้วแปลงเป็น ISO string ก่อนส่งเสมอ มิฉะนั้น MDM API ตอบ 400 ทุกครั้งที่มีค่า)
function toIsoDateTime(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function renderApiError(err) {
  if (err instanceof MdmApiError) {
    return `<p class="error">MDM API ปฏิเสธคำขอ (${escapeHtml(err.status)}): ${escapeHtml(err.problem?.detail || err.problem?.title || '')}</p>`;
  }
  return `<p class="error">เกิดข้อผิดพลาดที่ไม่คาดคิด</p>`;
}

// actorType ไม่มี query param ฝั่ง MDM API (จงใจไม่แก้ API contract - ดู dpo-console/README.md) จึงกรอง
// ฝั่งนี้จาก entry ที่ดึงมาแล้วเท่านั้น: จำนวนแถวที่แสดงต่อหน้าจึงอาจน้อยกว่า limit ที่ขอจริง และ cursor
// หน้าถัดไปอ้างอิงจากชุดข้อมูลก่อนกรอง (อาจต้องกด "หน้าถัดไป" มากกว่าหนึ่งครั้งถ้าตัวกรองนี้ตัดออกเยอะ)
function filterByActorType(data, actorType) {
  if (!actorType) return data;
  return data.filter((entry) => entry.actorType === actorType);
}

function renderFiltersForm(query) {
  return `<form method="get" action="/dpo/access-logs" class="filters">
    <div>
      <label>จากวันที่-เวลา</label>
      <input type="datetime-local" name="from" value="${escapeHtml(query.from || '')}" />
    </div>
    <div>
      <label>ถึงวันที่-เวลา</label>
      <input type="datetime-local" name="to" value="${escapeHtml(query.to || '')}" />
    </div>
    <div>
      <label>Person ID (UUID)</label>
      <input name="personId" value="${escapeHtml(query.personId || '')}" pattern="[0-9a-fA-F-]{36}" />
    </div>
    <div>
      <label>Client ID</label>
      <input name="clientId" value="${escapeHtml(query.clientId || '')}" />
    </div>
    <div>
      <label>ประเภทผู้เรียก (action type)</label>
      <select name="actorType">
        <option value="" ${!query.actorType ? 'selected' : ''}>ทั้งหมด</option>
        <option value="USER" ${query.actorType === 'USER' ? 'selected' : ''}>USER</option>
        <option value="SERVICE" ${query.actorType === 'SERVICE' ? 'selected' : ''}>SERVICE</option>
      </select>
    </div>
    <div>
      <label><input type="checkbox" name="pidAccessOnly" value="true" ${query.pidAccessOnly ? 'checked' : ''} style="width:auto;display:inline-block" /> เฉพาะการเข้าถึง pid/lookup</label>
    </div>
    <div>
      <button type="submit">กรอง</button>
    </div>
  </form>`;
}

function renderAccessLogTable(entries) {
  const rows = entries
    .map(
      (e) => `<tr>
        <td>${escapeHtml(fmt(e.accessedAt))}</td>
        <td><a href="/dpo/persons/${encodeURIComponent(e.subjectPersonId)}/change-log">${escapeHtml(e.subjectPersonId)}</a></td>
        <td><span class="badge badge-${escapeHtml(e.actorType.toLowerCase())}">${escapeHtml(e.actorType)}</span> ${escapeHtml(e.actorSub || '-')}</td>
        <td>${escapeHtml(e.clientId || '-')}</td>
        <td>${escapeHtml(e.endpoint)}</td>
        <td>${escapeHtml(e.purposeCode || '-')}</td>
        <td>${escapeHtml(e.responseStatus)}</td>
        <td>${(e.fieldsReturned || []).map(escapeHtml).join(', ') || '-'}</td>
        <td>${escapeHtml(e.requestId || '-')}</td>
      </tr>`
    )
    .join('\n');

  return `<table>
    <tr><th>เวลาเข้าถึง</th><th>บุคคลที่ถูกเข้าถึง (personId)</th><th>ผู้เรียก</th><th>Client</th><th>Endpoint</th><th>Purpose</th><th>Status</th><th>ฟิลด์ที่ส่งคืน</th><th>Request ID</th></tr>
    ${rows || '<tr><td colspan="9">ไม่มีรายการ</td></tr>'}
  </table>`;
}

function createAuditRoutes({ mdmClient }) {
  const router = express.Router();

  router.get('/dpo/access-logs', async (req, res, next) => {
    try {
      const { from, to, personId, clientId, actorType } = req.query;
      const pidAccessOnly = req.query.pidAccessOnly === 'true';

      const result = await mdmClient.listAccessLogs(req.dpoAuth.accessToken, {
        from: toIsoDateTime(from),
        to: toIsoDateTime(to),
        personId: personId || undefined,
        clientId: clientId || undefined,
        pidAccessOnly,
        cursor: req.query.cursor,
        limit: 50,
      });

      const filtered = filterByActorType(result.data, actorType);
      const nextQuery = new URLSearchParams({
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(personId ? { personId } : {}),
        ...(clientId ? { clientId } : {}),
        ...(actorType ? { actorType } : {}),
        ...(pidAccessOnly ? { pidAccessOnly: 'true' } : {}),
      });
      const nextLink = result.page?.nextCursor
        ? `<p><a href="/dpo/access-logs?${nextQuery.toString()}&cursor=${encodeURIComponent(result.page.nextCursor)}">หน้าถัดไป</a></p>`
        : '';

      res.send(
        layout(
          'Access Log',
          `<h1>Access Log</h1>
           <p class="hint">"ประเภทผู้เรียก" กรองจากรายการที่ดึงมาแล้วในหน้านี้เท่านั้น (ไม่ใช่ query param ของ MDM API) จำนวนแถวที่แสดงจึงอาจน้อยกว่าที่คาดถ้าตัวกรองนี้ตัดออกเยอะ - ดู dpo-console/README.md</p>
           ${renderFiltersForm({ from, to, personId, clientId, actorType, pidAccessOnly })}
           ${renderAccessLogTable(filtered)}
           ${nextLink}`,
          { displayName: req.dpoAuth.displayName }
        )
      );
    } catch (err) {
      if (err instanceof MdmApiError) {
        return res.status(err.status).send(layout('Access Log', renderApiError(err), { displayName: req.dpoAuth.displayName }));
      }
      next(err);
    }
  });

  router.get('/dpo/persons/:personId/change-log', async (req, res, next) => {
    const { personId } = req.params;
    try {
      const result = await mdmClient.getPersonChangeLog(req.dpoAuth.accessToken, personId, {
        since: toIsoDateTime(req.query.since),
        cursor: req.query.cursor,
        limit: 50,
      });

      const rows = result.data
        .map(
          (c) => `<tr>
            <td>${escapeHtml(fmt(c.changedAt))}</td>
            <td>${escapeHtml(c.fieldKey)}</td>
            <td>${c.oldValue === null ? '<em>(ปกปิด/ไม่มีค่า)</em>' : escapeHtml(JSON.stringify(c.oldValue))}</td>
            <td>${c.newValue === null ? '<em>(ปกปิด/ไม่มีค่า)</em>' : escapeHtml(JSON.stringify(c.newValue))}</td>
            <td>${escapeHtml(c.changedBy)}</td>
            <td>${escapeHtml(c.actorSub || '-')}</td>
            <td>${escapeHtml(c.reason || '-')}</td>
          </tr>`
        )
        .join('\n');

      const nextLink = result.page?.nextCursor
        ? `<p><a href="/dpo/persons/${encodeURIComponent(personId)}/change-log?cursor=${encodeURIComponent(result.page.nextCursor)}">หน้าถัดไป</a></p>`
        : '';

      res.send(
        layout(
          'ประวัติการเปลี่ยนแปลงรายฟิลด์',
          `<h1>ประวัติการเปลี่ยนแปลง - ${escapeHtml(personId)}</h1>
           <p class="hint">ค่าฟิลด์ที่จัดชั้น RESTRICTED (เช่น pid_hash/pid_enc) จะแสดงเป็น "(ปกปิด/ไม่มีค่า)" เสมอ (ปกปิดโดย MDM API เอง)</p>
           <form method="get" action="/dpo/persons/${encodeURIComponent(personId)}/change-log">
             <label>ตั้งแต่วันที่-เวลา</label>
             <input type="datetime-local" name="since" value="${escapeHtml(req.query.since || '')}" />
             <button type="submit" style="margin-top:0.5rem">กรอง</button>
           </form>
           <table>
             <tr><th>เวลาที่เปลี่ยน</th><th>ฟิลด์</th><th>ค่าเดิม</th><th>ค่าใหม่</th><th>เปลี่ยนโดย</th><th>Actor</th><th>เหตุผล</th></tr>
             ${rows || '<tr><td colspan="7">ไม่มีรายการ</td></tr>'}
           </table>
           ${nextLink}
           <p><a href="/dpo/access-logs">ย้อนกลับไป Access Log</a></p>`,
          { displayName: req.dpoAuth.displayName }
        )
      );
    } catch (err) {
      if (err instanceof MdmApiError) {
        return res.status(err.status).send(layout('ประวัติการเปลี่ยนแปลง', renderApiError(err), { displayName: req.dpoAuth.displayName }));
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createAuditRoutes };
