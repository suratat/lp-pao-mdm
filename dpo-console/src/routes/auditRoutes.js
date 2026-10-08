const express = require('express');
const { escapeHtml, redactPid, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');

const { formatThaiDateTime, toThaiInputValue, thaiInputToIso } = require('../thaiTime');

// แสดงเป็นเวลาไทย พ.ศ. (helper กลางที่ ../thaiTime) - ชื่อ fmt คงไว้ให้ route อื่นใช้ร่วมกัน
const fmt = formatThaiDateTime;

// <input type="datetime-local"> ส่งค่ามาแบบ "YYYY-MM-DDTHH:mm" (ไม่มีวินาที/timezone) ซึ่งไม่ตรงกับ
// รูปแบบ date-time (RFC 3339) ที่ OpenAPI validator ของ MDM API บังคับ ("from"/"to"/"since" ต้องแปลงเป็น ISO UTC ก่อนส่งเสมอ)
// ค่าที่ผู้ใช้กรอกคือ "เวลาไทย" (ไม่ขึ้นกับ TZ ของเครื่อง) - ดู ../thaiTime.thaiInputToIso
const toIsoDateTime = thaiInputToIso;

// ค่า old/new ที่ MDM API ปกปิด (valuesHidden) แสดงเป็น "(ปกปิด)" แยกจากกรณีไม่มีค่าจริง (ฟิลด์ใหม่/ถูกล้าง)
function renderChangeValue(entry, value) {
  if (entry.valuesHidden) return '<em>(ปกปิด)</em>';
  if (value === null || value === undefined) return '<em>(ไม่มีค่า)</em>';
  return escapeHtml(redactPid(JSON.stringify(value)));
}

// แถวที่เขียนก่อน PR-A ไม่มี actor_sub (แก้ย้อนหลังไม่ได้เพราะ append-only)
function renderActor(entry) {
  if (!entry.actorSub) return '<em>ไม่ทราบ (ก่อนบันทึก actor)</em>';
  return `${escapeHtml(entry.actorSub)}${entry.actorClient ? ` <span class="hint">(${escapeHtml(entry.actorClient)})</span>` : ''}`;
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
      <label>จากวันที่-เวลา <span class="hint">(เวลาไทย)</span></label>
      <input type="datetime-local" name="from" value="${escapeHtml(toThaiInputValue(query.from))}" />
    </div>
    <div>
      <label>ถึงวันที่-เวลา <span class="hint">(เวลาไทย)</span></label>
      <input type="datetime-local" name="to" value="${escapeHtml(toThaiInputValue(query.to))}" />
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
        <td>${escapeHtml(e.accessId)}</td>
        <td>${escapeHtml(fmt(e.accessedAt))}</td>
        <td><a href="/dpo/persons/${encodeURIComponent(e.subjectPersonId)}/change-log">${escapeHtml(e.subjectPersonId)}</a></td>
        <td><span class="badge badge-${escapeHtml(e.actorType.toLowerCase())}">${escapeHtml(e.actorType)}</span> ${escapeHtml(e.actorSub || '-')}</td>
        <td>${escapeHtml(e.clientId || '-')}</td>
        <td>${escapeHtml(e.endpoint)}</td>
        <td>${escapeHtml(e.purposeCode || '-')}</td>
        <td>${escapeHtml(redactPid(e.justification) || '-')}</td>
        <td>${e.reviewStatus ? `<span class="badge badge-${escapeHtml(e.reviewStatus.toLowerCase())}">${escapeHtml(e.reviewStatus)}</span>` : '-'}</td>
        <td>${escapeHtml(e.responseStatus)}</td>
        <td>${(e.fieldsReturned || []).map(escapeHtml).join(', ') || '-'}</td>
        <td>${escapeHtml(e.requestId || '-')}</td>
      </tr>`
    )
    .join('\n');

  return `<table>
    <tr><th>Access ID</th><th>เวลาเข้าถึง</th><th>บุคคลที่ถูกเข้าถึง (personId)</th><th>ผู้เรียก</th><th>Client</th><th>Endpoint</th><th>Purpose</th><th>เหตุผล (justification)</th><th>สถานะรีวิว</th><th>Status</th><th>ฟิลด์ที่ส่งคืน</th><th>Request ID</th></tr>
    ${rows || '<tr><td colspan="12">ไม่มีรายการ</td></tr>'}
  </table>`;
}

const CHANGED_BY_VALUES = ['THAID_SYNC', 'SELF', 'HR', 'HR_IMPORT', 'ADMIN'];
const ACTION_VALUES = ['CREATE', 'UPDATE'];

function renderOptions(values, selected) {
  return [
    `<option value="" ${!selected ? 'selected' : ''}>ทั้งหมด</option>`,
    ...values.map((v) => `<option value="${escapeHtml(v)}" ${selected === v ? 'selected' : ''}>${escapeHtml(v)}</option>`),
  ].join('');
}

function renderChangeLogFilters(q) {
  return `<form method="get" action="/dpo/change-logs" class="filters">
    <div>
      <label>แหล่งข้อมูล (source)</label>
      <select name="source">
        <option value="PERSON" ${q.source === 'PERSON' ? 'selected' : ''}>PERSON - ข้อมูลบุคคล</option>
        <option value="REFERENCE" ${q.source === 'REFERENCE' ? 'selected' : ''}>REFERENCE - หน่วยงาน/ตำแหน่ง</option>
      </select>
    </div>
    <div><label>จากวันที่-เวลา <span class="hint">(เวลาไทย)</span></label><input type="datetime-local" name="from" value="${escapeHtml(toThaiInputValue(q.from))}" /></div>
    <div><label>ถึงวันที่-เวลา <span class="hint">(เวลาไทย)</span></label><input type="datetime-local" name="to" value="${escapeHtml(toThaiInputValue(q.to))}" /></div>
    <div><label>ผู้กระทำ (actor sub)</label><input name="actorSub" value="${escapeHtml(q.actorSub || '')}" /></div>
    <div><label>ตาราง (table)</label><input name="tableName" value="${escapeHtml(q.tableName || '')}" /></div>
    <div><label>Person ID <span class="hint">(เฉพาะ PERSON)</span></label><input name="personId" value="${escapeHtml(q.personId || '')}" pattern="[0-9a-fA-F-]{36}" /></div>
    <div><label>เปลี่ยนโดย <span class="hint">(เฉพาะ PERSON)</span></label><select name="changedBy">${renderOptions(CHANGED_BY_VALUES, q.changedBy)}</select></div>
    <div><label>action <span class="hint">(เฉพาะ REFERENCE)</span></label><select name="action">${renderOptions(ACTION_VALUES, q.action)}</select></div>
    <div><button type="submit">กรอง</button></div>
  </form>`;
}

function renderChangeLogTable(source, entries) {
  const isPerson = source === 'PERSON';
  const rows = entries
    .map(
      (e) => `<tr>
        <td>${escapeHtml(fmt(e.changedAt))}</td>
        <td>${escapeHtml(e.tableName)}</td>
        <td>${
          isPerson
            ? `<a href="/dpo/persons/${encodeURIComponent(e.personId)}/change-log">${escapeHtml(e.personId)}</a>`
            : escapeHtml(e.recordId)
        }</td>
        <td>${escapeHtml(e.fieldKey)}</td>
        <td>${renderChangeValue(e, e.oldValue)}</td>
        <td>${renderChangeValue(e, e.newValue)}</td>
        <td>${escapeHtml(isPerson ? e.changedBy : e.action)}</td>
        <td>${renderActor(e)}</td>
        <td>${escapeHtml(redactPid(e.reason) || '-')}</td>
      </tr>`
    )
    .join('\n');

  return `<table>
    <tr><th>เวลาที่เปลี่ยน</th><th>ตาราง</th><th>${isPerson ? 'บุคคล (personId)' : 'record'}</th><th>ฟิลด์</th><th>ค่าเดิม</th><th>ค่าใหม่</th><th>${isPerson ? 'เปลี่ยนโดย' : 'action'}</th><th>ผู้กระทำ</th><th>เหตุผล</th></tr>
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

  router.get('/dpo/change-logs', async (req, res, next) => {
    const source = req.query.source === 'REFERENCE' ? 'REFERENCE' : 'PERSON';
    const { from, to, actorSub, tableName, personId, changedBy, action } = req.query;
    const form = { source, from, to, actorSub, tableName, personId, changedBy, action };
    try {
      // ตัวกรองที่ใช้ได้เฉพาะอีก source หนึ่งถูกตัดทิ้ง (ผู้ใช้สลับ source แล้วค่าเดิมยังค้างในฟอร์ม)
      const result = await mdmClient.listChangeLogs(req.dpoAuth.accessToken, {
        source,
        from: toIsoDateTime(from),
        to: toIsoDateTime(to),
        actorSub: actorSub || undefined,
        tableName: tableName || undefined,
        personId: source === 'PERSON' ? personId || undefined : undefined,
        changedBy: source === 'PERSON' ? changedBy || undefined : undefined,
        action: source === 'REFERENCE' ? action || undefined : undefined,
        cursor: req.query.cursor,
        limit: 50,
      });

      const nextQuery = new URLSearchParams(Object.fromEntries(Object.entries(form).filter(([, v]) => v)));
      const nextLink = result.page?.nextCursor
        ? `<p><a href="/dpo/change-logs?${escapeHtml(nextQuery.toString())}&amp;cursor=${encodeURIComponent(result.page.nextCursor)}">หน้าถัดไป</a></p>`
        : '';

      res.send(
        layout(
          'ประวัติการเปลี่ยนแปลงทั้งระบบ',
          `<h1>ประวัติการเปลี่ยนแปลง</h1>
           <p class="hint">เห็นเฉพาะ "ฟิลด์ใดเปลี่ยน ใครเปลี่ยน เมื่อไหร่" ค่าของข้อมูลชั้น CONFIDENTIAL ขึ้นไปถูกปกปิด แถวที่เขียนก่อนระบบบันทึกผู้กระทำจะแสดงผู้กระทำว่า "ไม่ทราบ"</p>
           ${renderChangeLogFilters(form)}
           ${renderChangeLogTable(source, result.data)}
           ${nextLink}`,
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
            <td>${renderChangeValue(c, c.oldValue)}</td>
            <td>${renderChangeValue(c, c.newValue)}</td>
            <td>${escapeHtml(c.changedBy)}</td>
            <td>${renderActor(c)}</td>
            <td>${escapeHtml(redactPid(c.reason) || '-')}</td>
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
           <p class="hint">ค่าของฟิลด์ที่จัดชั้น CONFIDENTIAL/SENSITIVE/RESTRICTED จะแสดงเป็น "(ปกปิด)" เสมอ เห็นเฉพาะชื่อฟิลด์ที่เปลี่ยน (ปกปิดโดย MDM API เอง)</p>
           <form method="get" action="/dpo/persons/${encodeURIComponent(personId)}/change-log">
             <label>ตั้งแต่วันที่-เวลา <span class="hint">(เวลาไทย)</span></label>
             <input type="datetime-local" name="since" value="${escapeHtml(toThaiInputValue(req.query.since))}" />
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

module.exports = { createAuditRoutes, fmt, toThaiInputValue, toIsoDateTime, renderApiError };
