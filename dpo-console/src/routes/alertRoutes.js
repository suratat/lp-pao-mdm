const express = require('express');
const { escapeHtml, redactPid, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');
const { csrfTokenMatches } = require('../session/csrf');
const { fmt, toThaiInputValue, toIsoDateTime, renderApiError } = require('./auditRoutes');

// PR-C: แจ้งเตือนพฤติกรรมการเข้าถึงข้อมูลผิดปกติ (worker access-anomaly-scan -> audit.access_alert) ให้ DPO รับทราบ/ปิดเรื่องพร้อมหมายเหตุ
// รายการมาจาก GET /audit/alerts; รับทราบ/ปิดเรื่องผ่าน POST /audit/alerts/{id}/ack|close (scope audit:review + role dpo - ตรวจที่ MDM API ทุกครั้ง)
// หน้านี้ไม่แสดงตัวตนบุคคลที่ถูกเข้าถึงเลย (alert เก็บแค่จำนวน/ช่วงเวลา/ผู้เข้าถึง) - ไล่ดูรายละเอียดได้จาก access log ตามลิงก์

const STATUSES = ['OPEN', 'ACK', 'CLOSED'];
const RULES = ['BULK_VIEW', 'OFF_HOURS', 'PID_REVEAL_FREQUENT'];
const STATUS_LABEL = { OPEN: 'รอดำเนินการ', ACK: 'รับทราบแล้ว', CLOSED: 'ปิดเรื่องแล้ว' };
const RULE_LABEL = {
  BULK_VIEW: 'เปิดดูข้อมูลบุคคลจำนวนมากในเวลาสั้น',
  OFF_HOURS: 'เข้าถึงข้อมูลนอกเวลาราชการ',
  PID_REVEAL_FREQUENT: 'เปิดเลขบัตรประชาชนบ่อยผิดปกติ',
};
const SEVERITY_LABEL = { HIGH: 'สูง', MEDIUM: 'กลาง', LOW: 'ต่ำ' };
const NOTE_MAX = 1000;
const ALERT_ID_RE = /^\d{1,18}$/;

const normalizeStatus = (v) => (STATUSES.includes(v) ? v : 'OPEN');

// note ถูกเก็บถาวรใน audit และผู้อื่นอ่านได้ - ห้ามมีเลขบัตรปน (ตัดตัวคั่นออกก่อนนับ) ตรงกับที่ MDM API ปฏิเสธ (422)
function validateNote(raw, action) {
  const note = typeof raw === 'string' ? raw.trim() : '';
  const errors = [];
  if (note.length > NOTE_MAX) errors.push(`หมายเหตุยาวเกิน ${NOTE_MAX} ตัวอักษร`);
  if (/\d{13}/.test(note.replace(/[\s-]/g, ''))) errors.push('ห้ามใส่เลขบัตรประชาชนในหมายเหตุ');
  if (action === 'close' && note.length === 0) errors.push('การปิดเรื่องต้องระบุหมายเหตุ (ผลการตรวจสอบ)');
  return { note, errors };
}

function renderFilters(q) {
  const options = (values, selected, label, blank) =>
    [
      blank ? `<option value="" ${!selected ? 'selected' : ''}>ทั้งหมด</option>` : '',
      ...values.map((v) => `<option value="${v}" ${selected === v ? 'selected' : ''}>${escapeHtml(label[v])} (${v})</option>`),
    ].join('');
  return `<form method="get" action="/dpo/alerts" class="filters">
    <div><label>สถานะ</label><select name="status">${options(STATUSES, q.status, STATUS_LABEL, false)}</select></div>
    <div><label>กฎ</label><select name="ruleCode">${options(RULES, q.ruleCode, RULE_LABEL, true)}</select></div>
    <div><label>ตรวจพบตั้งแต่ <span class="hint">(เวลาไทย)</span></label><input type="datetime-local" name="from" value="${escapeHtml(toThaiInputValue(q.from))}" /></div>
    <div><label>ตรวจพบถึง <span class="hint">(เวลาไทย)</span></label><input type="datetime-local" name="to" value="${escapeHtml(toThaiInputValue(q.to))}" /></div>
    <div><label>บัญชีผู้เข้าถึง (actor sub)</label><input name="actorSub" value="${escapeHtml(q.actorSub || '')}" /></div>
    <div><button type="submit">กรอง</button></div>
  </form>`;
}

function renderActionForm(alert, { csrfToken, returnStatus }) {
  if (alert.status === 'CLOSED') return '<span class="hint">ปิดเรื่องแล้ว</span>';
  const id = escapeHtml(alert.alertId);
  return `<form class="review" method="post" action="/dpo/alerts/${encodeURIComponent(alert.alertId)}/close" autocomplete="off">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
    <input type="hidden" name="returnStatus" value="${escapeHtml(returnStatus)}" />
    <label for="note-${id}">หมายเหตุ <span class="hint">(จำเป็นเมื่อปิดเรื่อง, ห้ามใส่เลขบัตร)</span></label>
    <input id="note-${id}" name="note" maxlength="${NOTE_MAX}" />
    ${
      alert.status === 'OPEN'
        ? `<button type="submit" formaction="/dpo/alerts/${encodeURIComponent(alert.alertId)}/ack">รับทราบ</button>`
        : ''
    }
    <button type="submit">ปิดเรื่อง</button>
  </form>`;
}

function renderTable(alerts, { canReview, csrfToken, returnStatus }) {
  const rows = alerts
    .map((a) => {
      const logLink = `/dpo/access-logs?${new URLSearchParams({ clientId: a.actorClient || '', from: toThaiInputValue(a.windowStart), to: toThaiInputValue(a.windowEnd) }).toString()}`;
      return `<tr>
        <td>${escapeHtml(a.alertId)}</td>
        <td>${escapeHtml(fmt(a.detectedAt))}</td>
        <td>${escapeHtml(RULE_LABEL[a.ruleCode] || a.ruleCode)}<br /><span class="hint">${escapeHtml(a.ruleCode)}</span></td>
        <td><span class="badge badge-${escapeHtml(String(a.severity).toLowerCase())}">${escapeHtml(SEVERITY_LABEL[a.severity] || a.severity)}</span></td>
        <td>${escapeHtml(a.actorSub || '-')}<br /><span class="hint">${escapeHtml(a.actorClient || '-')}</span></td>
        <td>${escapeHtml(fmt(a.windowStart))}<br />ถึง ${escapeHtml(fmt(a.windowEnd))}<br /><span class="hint"><a href="${escapeHtml(logLink)}">ดู access log</a></span></td>
        <td>${escapeHtml(a.metricCount)} / ${escapeHtml(a.threshold)}</td>
        <td><span class="badge badge-${escapeHtml(a.status.toLowerCase())}">${escapeHtml(STATUS_LABEL[a.status] || a.status)}</span>${
          a.lastActionAt
            ? `<br /><span class="hint">โดย ${escapeHtml(a.lastActionBy || '-')} เมื่อ ${escapeHtml(fmt(a.lastActionAt))}</span><br />${escapeHtml(redactPid(a.lastActionNote) || '')}`
            : ''
        }</td>
        ${canReview ? `<td>${renderActionForm(a, { csrfToken, returnStatus })}</td>` : ''}
      </tr>`;
    })
    .join('\n');

  return `<table>
    <tr><th>ID</th><th>ตรวจพบเมื่อ</th><th>กฎ</th><th>ความรุนแรง</th><th>บัญชี / ระบบ</th><th>ช่วงเวลาที่ตรวจ</th><th>จำนวน / เกณฑ์</th><th>สถานะ</th>${canReview ? '<th>ดำเนินการ</th>' : ''}</tr>
    ${rows || `<tr><td colspan="${canReview ? 9 : 8}">ไม่มีรายการ</td></tr>`}
  </table>`;
}

function createAlertRoutes({ mdmClient }) {
  const router = express.Router();

  // ทุกหน้าในกลุ่มนี้มี CSRF token - ห้าม cache ที่เบราว์เซอร์หรือ proxy
  router.use('/dpo/alerts', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    next();
  });

  const send = (req, res, status, title, body) => res.status(status).send(layout(title, body, { displayName: req.dpoAuth.displayName }));

  router.get('/dpo/alerts', async (req, res, next) => {
    const { from, to, actorSub } = req.query;
    const status = normalizeStatus(req.query.status);
    const ruleCode = RULES.includes(req.query.ruleCode) ? req.query.ruleCode : undefined;
    try {
      const result = await mdmClient.listAlerts(req.dpoAuth.accessToken, {
        status,
        ruleCode,
        from: toIsoDateTime(from),
        to: toIsoDateTime(to),
        actorSub: actorSub || undefined,
        cursor: req.query.cursor,
        limit: 50,
      });
      const nextQuery = new URLSearchParams(Object.fromEntries(Object.entries({ status, ruleCode, from, to, actorSub }).filter(([, v]) => v)));
      const nextLink = result.page?.nextCursor
        ? `<p><a href="/dpo/alerts?${escapeHtml(nextQuery.toString())}&amp;cursor=${encodeURIComponent(result.page.nextCursor)}">หน้าถัดไป</a></p>`
        : '';
      const canReview = req.dpoAuth.canReview === true;
      send(
        req,
        res,
        200,
        'แจ้งเตือนพฤติกรรมผิดปกติ',
        `<h1>แจ้งเตือนพฤติกรรมการเข้าถึงข้อมูลผิดปกติ</h1>
         <p class="hint">ตรวจโดยระบบทุก 5 นาที (เปิดดูบุคคลจำนวนมากในเวลาสั้น, นอกเวลาราชการ จ.-ศ. 08:30-16:30 เวลาไทย รวมเสาร์-อาทิตย์, เปิดเลขบัตรบ่อย) เรียงใหม่ → เก่า
         ผู้ที่เป็นเจ้าของ alert รับทราบ/ปิดเรื่องของตนเองไม่ได้ ${canReview ? '' : '<strong>(บัญชีนี้อ่านอย่างเดียว: รับทราบ/ปิดเรื่องได้เฉพาะ role dpo)</strong>'}</p>
         ${renderFilters({ status, ruleCode, from, to, actorSub })}
         ${renderTable(result.data, { canReview, csrfToken: req.dpoAuth.csrfToken, returnStatus: status })}
         ${nextLink}`
      );
    } catch (err) {
      if (err instanceof MdmApiError) return send(req, res, err.status, 'แจ้งเตือนพฤติกรรมผิดปกติ', renderApiError(err));
      next(err);
    }
  });

  // 64kb: หมายเหตุภาษาไทยยาวสุด 1000 ตัวอักษรหลัง percent-encode ยาวได้ราว 27 KB
  router.post('/dpo/alerts/:alertId/:action(ack|close)', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res, next) => {
    const { alertId, action } = req.params;
    const returnStatus = normalizeStatus(req.body?.returnStatus);
    const back = `<p><a href="/dpo/alerts?status=${encodeURIComponent(returnStatus)}">← กลับไปรายการ</a></p>`;
    if (!ALERT_ID_RE.test(alertId)) return send(req, res, 404, 'ไม่พบรายการ', `<p class="error">ไม่พบรายการนี้</p>${back}`);
    if (!csrfTokenMatches(req.dpoAuth.csrfToken, req.body?._csrf)) {
      return send(req, res, 403, 'คำขอไม่ถูกต้อง', `<p class="error">คำขอไม่ถูกต้องหรือหมดอายุ (CSRF) กรุณากลับไปเปิดหน้ารายการแล้วลองใหม่</p>${back}`);
    }
    if (!req.dpoAuth.canReview) {
      return send(req, res, 403, 'ไม่มีสิทธิ์', `<p class="error">บัญชีนี้ไม่มีสิทธิ์รับทราบ/ปิดเรื่อง (ต้องเป็น role dpo)</p>${back}`);
    }

    const { note, errors } = validateNote(req.body?.note, action);
    if (errors.length > 0) {
      return send(req, res, 422, 'หมายเหตุไม่ถูกต้อง', `${errors.map((e) => `<p class="error">${escapeHtml(e)}</p>`).join('')}${back}`);
    }

    try {
      if (action === 'ack') await mdmClient.ackAlert(req.dpoAuth.accessToken, alertId, { note });
      else await mdmClient.closeAlert(req.dpoAuth.accessToken, alertId, { note });
      // POST/redirect/GET กันกดรีโหลดแล้วส่งซ้ำ
      return res.redirect(303, `/dpo/alerts?status=${encodeURIComponent(returnStatus)}`);
    } catch (err) {
      if (err instanceof MdmApiError) return send(req, res, err.status, 'ดำเนินการไม่สำเร็จ', `${renderApiError(err)}${back}`);
      return next(err);
    }
  });

  return router;
}

module.exports = { createAlertRoutes };
