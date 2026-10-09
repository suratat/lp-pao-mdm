const express = require('express');
const { escapeHtml, redactPid, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');
const { csrfTokenMatches } = require('../session/csrf');
const { fmt, toThaiInputValue, toIsoDateTime, renderApiError } = require('./auditRoutes');

// PR-B: รีวิวการเปิดเลขบัตร (POST /persons/{id}/pid; แถวก่อน PR-B เป็น GET) - รายการมาจาก GET /audit/access-logs?reviewStatus=... (เฉพาะการเปิด pid)
// บันทึกผลรีวิวผ่าน POST /audit/access-logs/{accessId}/review (scope audit:review + role dpo - ตรวจที่ MDM API ทุกครั้ง)
// หน้านี้ไม่แสดงเลขบัตรเลย (แสดงแค่ใคร/เมื่อไหร่/เหตุผล) และไม่มีทางเรียกดูเลขบัตรจากที่นี่

const REVIEW_STATUSES = ['PENDING', 'REVIEWED', 'NEEDS_EXPLANATION'];
const REVIEW_ACTIONS = ['REVIEWED', 'NEEDS_EXPLANATION'];
const STATUS_LABEL = { PENDING: 'รอรีวิว', REVIEWED: 'รีวิวแล้ว', NEEDS_EXPLANATION: 'ขอคำชี้แจง' };
const NOTE_MAX = 1000;
const ACCESS_ID_RE = /^\d{1,18}$/;

function normalizeStatus(value) {
  return REVIEW_STATUSES.includes(value) ? value : 'PENDING';
}

// note ถูกเก็บถาวรใน audit และผู้อื่นอ่านได้ - ห้ามมีเลขบัตรปน (ตัดตัวคั่นออกก่อนนับ เช่น 1-2345-67890-12-3) ตรงกับที่ MDM API ปฏิเสธ (422)
function validateNote(raw, status) {
  const note = typeof raw === 'string' ? raw.trim() : '';
  const errors = [];
  if (note.length > NOTE_MAX) errors.push(`หมายเหตุยาวเกิน ${NOTE_MAX} ตัวอักษร`);
  if (/\d{13}/.test(note.replace(/[\s-]/g, ''))) errors.push('ห้ามใส่เลขบัตรประชาชนในหมายเหตุ');
  if (status === 'NEEDS_EXPLANATION' && note.length === 0) errors.push('การขอคำชี้แจงต้องระบุว่าต้องการให้ชี้แจงเรื่องใด');
  return { note, errors };
}

function renderFilters(q) {
  return `<form method="get" action="/dpo/pid-reveals" class="filters">
    <div>
      <label>สถานะรีวิว</label>
      <select name="reviewStatus">
        ${REVIEW_STATUSES.map((s) => `<option value="${s}" ${q.reviewStatus === s ? 'selected' : ''}>${escapeHtml(STATUS_LABEL[s])} (${s})</option>`).join('')}
      </select>
    </div>
    <div><label>จากวันที่-เวลา <span class="hint">(เวลาไทย)</span></label><input type="datetime-local" name="from" value="${escapeHtml(toThaiInputValue(q.from))}" /></div>
    <div><label>ถึงวันที่-เวลา <span class="hint">(เวลาไทย)</span></label><input type="datetime-local" name="to" value="${escapeHtml(toThaiInputValue(q.to))}" /></div>
    <div><label>Person ID (UUID)</label><input name="personId" value="${escapeHtml(q.personId || '')}" pattern="[0-9a-fA-F-]{36}" /></div>
    <div><label>Client ID</label><input name="clientId" value="${escapeHtml(q.clientId || '')}" /></div>
    <div><button type="submit">กรอง</button></div>
  </form>`;
}

function renderReviewForm(entry, { csrfToken, returnStatus }) {
  const id = `note-${escapeHtml(entry.accessId)}`;
  return `<form class="review" method="post" action="/dpo/pid-reveals/${encodeURIComponent(entry.accessId)}/review" autocomplete="off">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
    <input type="hidden" name="accessedAt" value="${escapeHtml(entry.accessedAt)}" />
    <input type="hidden" name="returnStatus" value="${escapeHtml(returnStatus)}" />
    <select name="status" aria-label="ผลรีวิว">
      ${REVIEW_ACTIONS.map((s) => `<option value="${s}">${escapeHtml(STATUS_LABEL[s])}</option>`).join('')}
    </select>
    <label for="${id}">หมายเหตุ <span class="hint">(จำเป็นเมื่อขอคำชี้แจง, ห้ามใส่เลขบัตร)</span></label>
    <input id="${id}" name="note" maxlength="${NOTE_MAX}" />
    <button type="submit">บันทึกผลรีวิว</button>
  </form>`;
}

function renderTable(entries, { canReview, csrfToken, returnStatus }) {
  const rows = entries
    .map((e) => {
      const reviewed = e.reviewStatus && e.reviewStatus !== 'PENDING';
      return `<tr>
        <td>${escapeHtml(e.accessId)}</td>
        <td>${escapeHtml(fmt(e.accessedAt))}</td>
        <td>${escapeHtml(e.actorSub || '-')}<br /><span class="hint">${escapeHtml(e.clientId || '-')}</span></td>
        <td><a href="/dpo/persons/${encodeURIComponent(e.subjectPersonId)}/change-log">${escapeHtml(e.subjectPersonId)}</a></td>
        <td>${escapeHtml(redactPid(e.justification) || '-')}</td>
        <td><span class="badge badge-${escapeHtml(String(e.reviewStatus).toLowerCase())}">${escapeHtml(STATUS_LABEL[e.reviewStatus] || e.reviewStatus)}</span>${
          reviewed
            ? `<br /><span class="hint">โดย ${escapeHtml(e.reviewerSub || '-')} เมื่อ ${escapeHtml(fmt(e.reviewedAt))}</span><br />${escapeHtml(redactPid(e.reviewNote) || '')}`
            : ''
        }</td>
        ${canReview ? `<td>${renderReviewForm(e, { csrfToken, returnStatus })}</td>` : ''}
      </tr>`;
    })
    .join('\n');

  return `<table>
    <tr><th>Access ID</th><th>เวลาที่เปิด</th><th>ผู้เปิด / Client</th><th>บุคคล (personId)</th><th>เหตุผล (justification)</th><th>สถานะรีวิว</th>${canReview ? '<th>รีวิว</th>' : ''}</tr>
    ${rows || `<tr><td colspan="${canReview ? 7 : 6}">ไม่มีรายการ</td></tr>`}
  </table>`;
}

function createPidRevealRoutes({ mdmClient }) {
  const router = express.Router();

  // ทุกหน้าในกลุ่มนี้มี CSRF token และข้อมูลการเข้าถึงข้อมูลบุคคล - ห้าม cache ที่เบราว์เซอร์หรือ proxy
  router.use('/dpo/pid-reveals', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    next();
  });

  const send = (req, res, status, title, body) =>
    res.status(status).send(layout(title, body, { displayName: req.dpoAuth.displayName }));

  router.get('/dpo/pid-reveals', async (req, res, next) => {
    const { from, to, personId, clientId } = req.query;
    const reviewStatus = normalizeStatus(req.query.reviewStatus);
    try {
      const result = await mdmClient.listAccessLogs(req.dpoAuth.accessToken, {
        reviewStatus,
        from: toIsoDateTime(from),
        to: toIsoDateTime(to),
        personId: personId || undefined,
        clientId: clientId || undefined,
        cursor: req.query.cursor,
        limit: 50,
      });

      const nextQuery = new URLSearchParams(
        Object.fromEntries(Object.entries({ reviewStatus, from, to, personId, clientId }).filter(([, v]) => v))
      );
      const nextLink = result.page?.nextCursor
        ? `<p><a href="/dpo/pid-reveals?${escapeHtml(nextQuery.toString())}&amp;cursor=${encodeURIComponent(result.page.nextCursor)}">หน้าถัดไป</a></p>`
        : '';
      const canReview = req.dpoAuth.canReview === true;

      send(
        req,
        res,
        200,
        'การเปิดเลขบัตร',
        `<h1>การเปิดเลขบัตรประชาชน</h1>
         <p class="hint">รายการที่มีการเปิดเลขบัตรเต็ม (POST /persons/{id}/pid; แถวก่อน PR-B เป็น GET) เรียงเก่า → ใหม่ หน้านี้ไม่แสดงเลขบัตร ผู้เปิดเลขบัตรรีวิวรายการของตนเองไม่ได้ ${
           canReview ? '' : '<strong>(บัญชีนี้อ่านอย่างเดียว: บันทึกผลรีวิวได้เฉพาะ role dpo)</strong>'
         }</p>
         ${renderFilters({ reviewStatus, from, to, personId, clientId })}
         ${renderTable(result.data, { canReview, csrfToken: req.dpoAuth.csrfToken, returnStatus: reviewStatus })}
         ${nextLink}`
      );
    } catch (err) {
      if (err instanceof MdmApiError) return send(req, res, err.status, 'การเปิดเลขบัตร', renderApiError(err));
      next(err);
    }
  });

  // 64kb: หมายเหตุภาษาไทยยาวสุด 1000 ตัวอักษรหลัง percent-encode ยาวได้ราว 27 KB (ตัวอักษรไทย 3 ไบต์ x 3 ตัวอักษรต่อไบต์) 8kb ที่ใช้กับฟอร์มเหตุผลสั้นไม่พอ
  router.post('/dpo/pid-reveals/:accessId/review', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res, next) => {
    const { accessId } = req.params;
    const back = `<p><a href="/dpo/pid-reveals?reviewStatus=${encodeURIComponent(normalizeStatus(req.body?.returnStatus))}">← กลับไปรายการ</a></p>`;
    if (!ACCESS_ID_RE.test(accessId)) return send(req, res, 404, 'ไม่พบรายการ', `<p class="error">ไม่พบรายการนี้</p>${back}`);
    if (!csrfTokenMatches(req.dpoAuth.csrfToken, req.body?._csrf)) {
      return send(req, res, 403, 'คำขอไม่ถูกต้อง', `<p class="error">คำขอไม่ถูกต้องหรือหมดอายุ (CSRF) กรุณากลับไปเปิดหน้ารายการแล้วลองใหม่</p>${back}`);
    }
    if (!req.dpoAuth.canReview) {
      return send(req, res, 403, 'ไม่มีสิทธิ์', `<p class="error">บัญชีนี้ไม่มีสิทธิ์บันทึกผลรีวิว (ต้องเป็น role dpo)</p>${back}`);
    }

    const status = req.body?.status;
    if (!REVIEW_ACTIONS.includes(status)) {
      return send(req, res, 422, 'ผลรีวิวไม่ถูกต้อง', `<p class="error">ผลรีวิวไม่ถูกต้อง</p>${back}`);
    }
    const accessedAt = toIsoDateTime(req.body?.accessedAt);
    if (!accessedAt) return send(req, res, 422, 'ข้อมูลไม่ครบ', `<p class="error">ข้อมูลรายการไม่ครบ กรุณาเปิดหน้ารายการใหม่</p>${back}`);

    const { note, errors } = validateNote(req.body?.note, status);
    if (errors.length > 0) {
      return send(req, res, 422, 'หมายเหตุไม่ถูกต้อง', `${errors.map((e) => `<p class="error">${escapeHtml(e)}</p>`).join('')}${back}`);
    }

    try {
      await mdmClient.reviewPidAccess(req.dpoAuth.accessToken, accessId, { accessedAt, status, note });
      // POST/redirect/GET กันกดรีโหลดแล้วส่งซ้ำ - กลับไปรายการสถานะเดิมที่เปิดอยู่
      return res.redirect(303, `/dpo/pid-reveals?reviewStatus=${encodeURIComponent(normalizeStatus(req.body?.returnStatus))}`);
    } catch (err) {
      if (err instanceof MdmApiError) return send(req, res, err.status, 'บันทึกผลรีวิวไม่สำเร็จ', `${renderApiError(err)}${back}`);
      return next(err);
    }
  });

  return router;
}

module.exports = { createPidRevealRoutes };
