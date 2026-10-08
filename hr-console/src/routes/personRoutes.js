const express = require('express');
const { escapeHtml, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');
const { PERSONNEL_TYPES } = require('../personnelTypes');
const { UUID_RE } = require('../masterData');
const { csrfTokenMatches } = require('../session/csrf');
const { renderHistory } = require('../historyView');

// หน้าดูข้อมูลบุคคล (อ่านอย่างเดียว): ค้นหา / รายละเอียด / แสดงเลขบัตรเต็มแบบมีเหตุผล
// - query string ใช้เฉพาะ q/filter/cursor เท่านั้น ห้ามมี pid; เหตุผลของการแสดงเลขบัตรส่งแบบ POST body เท่านั้น
// - ปุ่ม/คอลัมน์ซ่อนตาม scope ใน access token (UI เท่านั้น - MDM API ตรวจ scope ซ้ำทุก request)

const SCOPE_PID_MASKED = 'personnel:read:pid_masked';
const SCOPE_PID = 'personnel:read:pid';
const SCOPE_EMPLOYMENT = 'personnel:read:employment';
const SCOPE_INACTIVE = 'personnel:read:inactive';

const PAGE_SIZE = 50;
const HISTORY_PAGE_SIZE = 20;

// ข้อความยืนยันหลังบันทึกสำเร็จ (redirect มาพร้อม ?saved=<รหัส>) รับเฉพาะรหัสที่รู้จัก ไม่สะท้อนค่าใดจาก query ลงหน้า
const SAVED_MESSAGES = {
  created: 'เพิ่มบุคคลใหม่เรียบร้อยแล้ว บุคคลนี้อยู่ในสถานะรอยืนยันตัวตน (PENDING_CLAIM) และจะเชื่อมกับ ThaID อัตโนมัติเมื่อเข้าสู่ระบบครั้งแรก',
  employment: 'บันทึกการเปลี่ยนแปลงข้อมูลการจ้างเรียบร้อยแล้ว (เก็บประวัติเดิมไว้เป็นช่วงเวลา)',
  nochange: 'ไม่มีการเปลี่ยนแปลงข้อมูล จึงไม่ได้บันทึกอะไร',
  deactivated: 'บันทึกการพ้นสภาพเรียบร้อยแล้ว ระบบระงับการเข้าถึงของบุคคลนี้แล้ว',
  contact: 'บันทึกข้อมูลติดต่อเรียบร้อยแล้ว',
  emergency: 'บันทึกผู้ติดต่อฉุกเฉินเรียบร้อยแล้ว',
  identity: 'บันทึกชื่อ-นามสกุล/วันเกิดที่ HR กรอกเรียบร้อยแล้ว (ข้อมูลนี้รอยืนยันด้วย ThaID)',
  reactivated: 'คืนสภาพเรียบร้อยแล้ว บุคคลนี้ต้องยืนยันตัวตนผ่าน ThaID ใหม่ในการเข้าสู่ระบบครั้งถัดไป',
};
const REASON_MIN = 10;
const REASON_MAX = 500;

const STATUS_LABEL = { ACTIVE: 'ใช้งาน (ACTIVE)', PENDING_CLAIM: 'รอยืนยันตัวตน (PENDING_CLAIM)', INACTIVE: 'พ้นสภาพ (INACTIVE)' };
const PERSONNEL_TYPE_LABEL = Object.fromEntries(PERSONNEL_TYPES.map((t) => [t.value, t.label]));
const naturalCompare = (a, b) => String(a).localeCompare(String(b), 'th', { numeric: true });

function fmt(value) {
  return value ? String(value).replace('T', ' ').slice(0, 19) : '-';
}

function pageOpts(req) {
  return { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin };
}

function fullName(basic = {}) {
  return `${basic.titleTh || ''}${basic.firstNameTh || ''} ${basic.lastNameTh || ''}`.trim() || '(ไม่มีชื่อ)';
}

function apiErrorText(err) {
  if (err instanceof MdmApiError) {
    return `MDM API ปฏิเสธคำขอ (${err.status}): ${err.problem?.detail || err.problem?.title || ''}`;
  }
  return 'เกิดข้อผิดพลาดที่ไม่คาดคิด';
}

// ตัวเลือกสถานะ: INACTIVE ต้องมี personnel:read:inactive (ไม่งั้น API ตอบ 403) จึงซ่อนไว้เมื่อ token ไม่มี scope นี้
function statusFilters(scopes) {
  const filters = [
    { value: 'ALL', label: 'ทั้งหมด' },
    { value: 'ACTIVE', label: 'ACTIVE' },
    { value: 'PENDING_CLAIM', label: 'PENDING_CLAIM' },
  ];
  if (scopes.has(SCOPE_INACTIVE)) filters.push({ value: 'INACTIVE', label: 'INACTIVE' });
  return filters;
}

function statusesForFilter(filter, scopes) {
  if (filter === 'ALL') return scopes.has(SCOPE_INACTIVE) ? ['ACTIVE', 'PENDING_CLAIM', 'INACTIVE'] : ['ACTIVE', 'PENDING_CLAIM'];
  return [filter];
}

function parseSearchQuery(query, scopes) {
  const allowedStatuses = statusFilters(scopes).map((f) => f.value);
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  return {
    q,
    status: allowedStatuses.includes(query.status) ? query.status : 'ALL',
    orgUnitId: typeof query.orgUnitId === 'string' && UUID_RE.test(query.orgUnitId) ? query.orgUnitId : '',
    personnelType: PERSONNEL_TYPES.some((t) => t.value === query.personnelType) ? query.personnelType : '',
    cursor: typeof query.cursor === 'string' && UUID_RE.test(query.cursor) ? query.cursor : '',
  };
}

// ลิงก์/ฟอร์มกลับมาที่รายการ ใส่เฉพาะ q/status/orgUnitId/personnelType/cursor
function listUrl(filters, extra = {}) {
  const qs = new URLSearchParams();
  const merged = { ...filters, ...extra };
  for (const key of ['q', 'status', 'orgUnitId', 'personnelType', 'cursor']) {
    if (merged[key]) qs.set(key, merged[key]);
  }
  const query = qs.toString();
  return `/hr/persons${query ? `?${query}` : ''}`;
}

function orgUnitOptions(orgUnits, selected) {
  return [...orgUnits]
    .filter((o) => o.isActive)
    .sort((a, b) => naturalCompare(a.code, b.code))
    .map(
      (o) =>
        `<option value="${escapeHtml(o.orgUnitId)}"${o.orgUnitId === selected ? ' selected' : ''}>${escapeHtml(o.code)} — ${escapeHtml(o.nameTh)}</option>`
    )
    .join('\n');
}

function renderSearchForm(filters, orgUnits, scopes) {
  const statusOptions = statusFilters(scopes)
    .map((f) => `<option value="${escapeHtml(f.value)}"${f.value === filters.status ? ' selected' : ''}>${escapeHtml(f.label)}</option>`)
    .join('');
  const typeOptions = PERSONNEL_TYPES.map(
    (t) => `<option value="${escapeHtml(t.value)}"${t.value === filters.personnelType ? ' selected' : ''}>${escapeHtml(t.label)}</option>`
  ).join('');
  return `<form method="get" action="/hr/persons">
    <div class="row">
      <div><label>ชื่อ หรือ ชื่อ นามสกุล <span class="hint">(ขึ้นต้นด้วย อย่างน้อย 2 ตัวอักษร)</span>
        <input type="search" name="q" value="${escapeHtml(filters.q)}" maxlength="100" /></label></div>
      <div><label>สถานะ<select name="status">${statusOptions}</select></label></div>
    </div>
    <div class="row">
      <div><label>หน่วยงาน (รวมหน่วยงานย่อย)<select name="orgUnitId"><option value="">ทั้งหมด</option>${orgUnitOptions(orgUnits, filters.orgUnitId)}</select></label></div>
      <div><label>ประเภทบุคลากร<select name="personnelType"><option value="">ทั้งหมด</option>${typeOptions}</select></label></div>
    </div>
    <p><button type="submit">ค้นหา</button> <a href="/hr/persons">ล้างตัวกรอง</a></p>
  </form>`;
}

function renderResultsTable(persons, scopes) {
  const showMasked = scopes.has(SCOPE_PID_MASKED);
  const rows = persons
    .map((p) => {
      const basic = p.basic || {};
      const position = basic.positionTitle || basic.jobTitleText || '-';
      return `<tr>
        <td>${escapeHtml(fullName(basic))}</td>
        ${showMasked ? `<td>${escapeHtml(basic.employeeNoMasked || '-')}</td>` : ''}
        <td>${escapeHtml(PERSONNEL_TYPE_LABEL[basic.personnelType] || basic.personnelType || '-')}</td>
        <td>${escapeHtml(position)}</td>
        <td>${escapeHtml(basic.orgUnit?.nameTh || '-')}</td>
        <td><span class="badge badge-${escapeHtml(String(p.status).toLowerCase())}">${escapeHtml(p.status)}</span></td>
        <td><span class="badge badge-${escapeHtml(String(p.verification?.verificationStatus || '').toLowerCase())}">${escapeHtml(p.verification?.verificationStatus || '-')}</span></td>
        <td class="actions"><a href="/hr/persons/${encodeURIComponent(p.personId)}">ดูรายละเอียด</a></td>
      </tr>`;
    })
    .join('\n');
  const columns = 7 + (showMasked ? 1 : 0);
  return `<table>
    <tr><th>ชื่อ-สกุล</th>${showMasked ? '<th>เลขบัตร (ปิด)</th>' : ''}<th>ประเภท</th><th>ตำแหน่ง / ลักษณะงาน</th><th>สังกัด</th><th>สถานะ</th><th>การยืนยัน</th><th></th></tr>
    ${rows || `<tr><td colspan="${columns}">ไม่พบรายการ</td></tr>`}
  </table>`;
}

function definitionList(items) {
  return `<dl class="kv">${items
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`)
    .join('')}</dl>`;
}

function positionText(position, jobTitleText) {
  const parts = [];
  if (position?.titleTh) parts.push(`${escapeHtml(position.titleTh)}${position.positionNo ? ` <span class="hint">(${escapeHtml(position.positionNo)})</span>` : ''}`);
  if (jobTitleText) parts.push(`<span class="hint">ชื่อตำแหน่ง/ลักษณะงาน:</span> ${escapeHtml(jobTitleText)}`);
  return parts.length > 0 ? parts.join('<br>') : '-';
}

function renderEmploymentHistory(history) {
  const rows = [...history]
    .sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)))
    .map(
      (e) => `<tr>
        <td>${escapeHtml(e.effectiveFrom || '-')}</td>
        <td>${escapeHtml(e.effectiveTo || '-')}${e.isCurrent ? ' <span class="badge">ปัจจุบัน</span>' : ''}</td>
        <td>${escapeHtml(PERSONNEL_TYPE_LABEL[e.personnelType] || e.personnelType || '-')}</td>
        <td>${positionText(e.position, e.jobTitleText)}</td>
        <td>${escapeHtml(e.orgUnit?.nameTh || '-')}</td>
        <td>${escapeHtml(e.levelCode || '-')}</td>
        <td>${escapeHtml(e.employmentStatus || '-')}${e.separationDate ? `<br><span class="hint">พ้นสภาพ ${escapeHtml(e.separationDate)}</span>` : ''}</td>
      </tr>`
    )
    .join('\n');
  return `<table>
    <tr><th>มีผลตั้งแต่</th><th>สิ้นสุด</th><th>ประเภท</th><th>ตำแหน่ง</th><th>สังกัด</th><th>ระดับ</th><th>สถานะ</th></tr>
    ${rows || '<tr><td colspan="7">ไม่มีประวัติ</td></tr>'}
  </table>`;
}

function revealForm(req, personId, { reason = '', errors = [] } = {}) {
  return `<h1>แสดงเลขบัตรประชาชน</h1>
    <p>การแสดงเลขบัตรถูกบันทึกใน audit log พร้อมเหตุผลและชื่อผู้ดำเนินการ ใช้เมื่อจำเป็นต้องตรวจเอกสารเท่านั้น</p>
    ${errors.length > 0 ? `<ul class="error">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
    <form method="post" action="/hr/persons/${encodeURIComponent(personId)}/reveal-pid" autocomplete="off">
      <input type="hidden" name="_csrf" value="${escapeHtml(req.hrAuth.csrfToken)}" />
      <label>เหตุผลที่ต้องดูเลขบัตร <span class="hint">(${REASON_MIN}–${REASON_MAX} ตัวอักษร ห้ามใส่เลขบัตรประชาชน)</span>
        <textarea name="justification" rows="3" minlength="${REASON_MIN}" maxlength="${REASON_MAX}" required>${escapeHtml(reason)}</textarea></label>
      <p><button type="submit">แสดงเลขบัตร</button> <a href="/hr/persons/${encodeURIComponent(personId)}">ยกเลิก</a></p>
    </form>`;
}

function validateReason(raw) {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  const errors = [];
  if (reason.length < REASON_MIN) errors.push(`กรุณาระบุเหตุผลอย่างน้อย ${REASON_MIN} ตัวอักษร`);
  if (reason.length > REASON_MAX) errors.push(`เหตุผลยาวเกิน ${REASON_MAX} ตัวอักษร`);
  // เหตุผลถูกส่งต่อไปเก็บใน access_log ของ API - ห้ามมีเลขบัตรปนอยู่ (ตัดตัวคั่นออกก่อนนับ เช่น 1-2345-67890-12-3)
  if (/\d{13}/.test(reason.replace(/[\s-]/g, ''))) errors.push('ห้ามใส่เลขบัตรประชาชนในเหตุผล');
  return { reason, errors };
}

function createPersonRoutes({ mdmClient }) {
  const router = express.Router();

  // ทุกหน้าในกลุ่มนี้มีข้อมูลบุคคล/CSRF token - ห้าม cache ที่เบราว์เซอร์หรือ proxy
  router.use('/hr/persons', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    next();
  });

  const send = (req, res, status, title, body) => res.status(status).send(layout(title, body, pageOpts(req)));

  router.get('/hr/persons', async (req, res, next) => {
    const scopes = req.hrAuth.scopes;
    const filters = parseSearchQuery(req.query, scopes);
    try {
      const orgUnits = await mdmClient.listOrgUnits(req.hrAuth.accessToken, { activeOnly: true });
      const form = renderSearchForm(filters, orgUnits, scopes);

      if (filters.q && filters.q.length < 2) {
        return send(req, res, 200, 'ข้อมูลบุคคล', `<h1>ข้อมูลบุคคล</h1>${form}<p class="error">กรุณากรอกคำค้นอย่างน้อย 2 ตัวอักษร</p>`);
      }

      const result = await mdmClient.searchPersons(req.hrAuth.accessToken, {
        q: filters.q,
        status: statusesForFilter(filters.status, scopes),
        orgUnitId: filters.orgUnitId,
        personnelType: filters.personnelType,
        cursor: filters.cursor,
        limit: PAGE_SIZE,
      });
      const nextLink = result.page?.nextCursor
        ? `<p><a href="${escapeHtml(listUrl(filters, { cursor: result.page.nextCursor }))}">หน้าถัดไป</a></p>`
        : '';
      const addButton = req.hrAuth.isMasterDataAdmin ? '<p><a class="button" href="/hr/persons/new">+ เพิ่มบุคคลใหม่</a></p>' : '';
      return send(req, res, 200, 'ข้อมูลบุคคล', `<h1>ข้อมูลบุคคล</h1>${addButton}${form}${renderResultsTable(result.data, scopes)}${nextLink}`);
    } catch (err) {
      if (err instanceof MdmApiError && [400, 403].includes(err.status)) {
        return send(req, res, err.status, 'ข้อมูลบุคคล', `<h1>ข้อมูลบุคคล</h1><p class="error">${escapeHtml(apiErrorText(err))}</p>`);
      }
      return next(err);
    }
  });

  router.get('/hr/persons/:personId', async (req, res, next) => {
    const { personId } = req.params;
    if (!UUID_RE.test(personId)) return send(req, res, 404, 'ไม่พบบุคคล', '<p class="error">ไม่พบบุคคลนี้</p>');
    const scopes = req.hrAuth.scopes;
    const token = req.hrAuth.accessToken;
    try {
      const person = await mdmClient.getPerson(token, personId);
      const basic = person.basic || {};

      // ประวัติ employment ต้องมี personnel:read:employment; ถ้า token ไม่มี scope ก็ไม่เรียก (ไม่แสดง error)
      let historyHtml = '<p class="muted">บัญชีนี้ไม่มีสิทธิ์ดูประวัติการปฏิบัติงาน</p>';
      if (scopes.has(SCOPE_EMPLOYMENT)) {
        try {
          historyHtml = renderEmploymentHistory(await mdmClient.getEmployment(token, personId));
        } catch (err) {
          if (!(err instanceof MdmApiError) || err.status !== 403) throw err;
        }
      }

      const verification = person.verification || {};
      const isAdmin = req.hrAuth.isMasterDataAdmin === true;
      const flash = SAVED_MESSAGES[String(req.query.saved)] ? `<p class="ok"><strong>${escapeHtml(SAVED_MESSAGES[String(req.query.saved)])}</strong></p>` : '';

      // ปุ่มแก้ไข: เฉพาะผู้มี role hr_master_data_admin (ซ่อนเพื่อ UX เท่านั้น - MDM API ตรวจ role ซ้ำทุกคำขอ)
      const id = encodeURIComponent(personId);
      const actionButtons = isAdmin
        ? `<p class="actions">${
            person.status === 'INACTIVE'
              ? `<a class="button" href="/hr/persons/${id}/reactivate">คืนสภาพ</a>`
              : `<a class="button" href="/hr/persons/${id}/employment/edit">ย้ายหน่วยงาน / ตำแหน่ง / ประเภท</a><a class="button" href="/hr/persons/${id}/deactivate">พ้นสภาพ</a>`
          }</p>
          <p class="actions"><a class="button" href="/hr/persons/${id}/contact/edit">แก้ข้อมูลติดต่อ</a><a class="button" href="/hr/persons/${id}/emergency-contacts/edit">แก้ผู้ติดต่อฉุกเฉิน</a><a class="button" href="/hr/persons/${id}/expected-identity/edit">ชื่อ-วันเกิดที่ HR กรอก</a></p>`
        : '';

      // ประวัติการเปลี่ยนแปลง (เฉพาะ hr_master_data_admin): ความล้มเหลวของส่วนนี้ต้องไม่ทำให้ทั้งหน้าล้ม
      let historySection = '';
      if (isAdmin) {
        try {
          const cursor = /^\d{1,18}$/.test(String(req.query.historyCursor)) ? String(req.query.historyCursor) : undefined;
          const result = await mdmClient.getPersonHistory(token, personId, { cursor, limit: HISTORY_PAGE_SIZE });
          const lookups = { orgUnits: new Map(), positions: new Map() };
          if (result.data.some((e) => e.fieldKey === 'employment.org_unit_id' || e.fieldKey === 'employment.position_id')) {
            const [orgUnits, positions] = await Promise.all([
              mdmClient.listOrgUnits(token, { activeOnly: false }),
              mdmClient.listPositions(token, { activeOnly: false }),
            ]);
            for (const o of orgUnits) lookups.orgUnits.set(o.orgUnitId, `${o.code} — ${o.nameTh}`);
            for (const p of positions) lookups.positions.set(p.positionId, `${p.positionNo} — ${p.titleTh}`);
          }
          historySection = `<h2 id="history">ประวัติการเปลี่ยนแปลง</h2>
            <p class="hint">เห็นเฉพาะว่าฟิลด์ใดเปลี่ยน ใคร เมื่อไหร่ และเหตุผล ค่าของข้อมูลส่วนบุคคลบางชนิดถูกปกปิด</p>
            ${renderHistory({ entries: result.data, nextCursor: result.page?.nextCursor, personId, lookups })}`;
        } catch (err) {
          historySection = `<h2 id="history">ประวัติการเปลี่ยนแปลง</h2><p class="error">แสดงประวัติการเปลี่ยนแปลงไม่ได้ในขณะนี้ (${escapeHtml(
            err instanceof MdmApiError && err.status === 403 ? 'ไม่มีสิทธิ์ดูประวัติ' : 'ระบบขัดข้อง กรุณาลองใหม่ภายหลัง'
          )})</p>`;
        }
      }
      const pidButton = scopes.has(SCOPE_PID)
        ? ` <form class="inline" method="get" action="/hr/persons/${encodeURIComponent(personId)}/reveal-pid"><button type="submit">แสดงเลขบัตร</button></form>`
        : '';
      const maskedRow = scopes.has(SCOPE_PID_MASKED) || basic.employeeNoMasked
        ? [['เลขบัตรประชาชน', `${escapeHtml(basic.employeeNoMasked || '-')}${pidButton}`]]
        : scopes.has(SCOPE_PID)
          ? [['เลขบัตรประชาชน', pidButton.trim()]]
          : [];

      const body = `<p><a href="/hr/persons">← กลับไปรายการ</a></p>
        <h1>${escapeHtml(fullName(basic))}</h1>
        ${flash}
        ${actionButtons}
        <h2>ข้อมูลทั่วไป</h2>
        ${definitionList([
          ['สถานะ', `<span class="badge badge-${escapeHtml(String(person.status).toLowerCase())}">${escapeHtml(person.status)}</span>`],
          ['การยืนยันตัวตน (ThaID)', `<span class="badge badge-${escapeHtml(String(verification.verificationStatus || '').toLowerCase())}">${escapeHtml(verification.verificationStatus || '-')}</span>`],
          ['ยืนยัน ThaID ล่าสุด', escapeHtml(fmt(verification.thaidVerifiedAt))],
          ['เชื่อมตัวตนเมื่อ', escapeHtml(fmt(verification.claimedAt))],
          ...maskedRow,
          ['ชื่อ-สกุล (อังกฤษ)', escapeHtml(`${basic.titleEn || ''} ${basic.firstNameEn || ''} ${basic.lastNameEn || ''}`.trim())],
          ['อีเมลที่ทำงาน', escapeHtml(basic.emailWork || '')],
          ['version', escapeHtml(person.version)],
          ['แก้ไขล่าสุด', escapeHtml(fmt(person.updatedAt))],
        ])}
        <h2>ตำแหน่งปัจจุบัน</h2>
        ${definitionList([
          ['ประเภทบุคลากร', escapeHtml(PERSONNEL_TYPE_LABEL[basic.personnelType] || basic.personnelType || '-')],
          ['ตำแหน่ง', positionText(basic.positionTitle ? { titleTh: basic.positionTitle, positionNo: basic.positionNo } : null, null)],
          ['ชื่อตำแหน่ง/ลักษณะงาน', escapeHtml(basic.jobTitleText || '')],
          ['ระดับ', escapeHtml(basic.levelCode || '')],
          ['สังกัด', escapeHtml(basic.orgUnit ? `${basic.orgUnit.nameTh}${basic.orgUnit.parentNameTh ? ` (${basic.orgUnit.parentNameTh})` : ''}` : '-')],
        ])}
        <h2>ประวัติการปฏิบัติงาน (Employment)</h2>
        ${historyHtml}
        ${historySection}`;
      return send(req, res, 200, fullName(basic), body);
    } catch (err) {
      if (err instanceof MdmApiError && [403, 404].includes(err.status)) {
        return send(req, res, err.status, 'ข้อมูลบุคคล', `<p class="error">${escapeHtml(err.status === 404 ? 'ไม่พบบุคคลนี้' : apiErrorText(err))}</p><p><a href="/hr/persons">← กลับไปรายการ</a></p>`);
      }
      return next(err);
    }
  });

  // ฟอร์มกรอกเหตุผล - ต้องมี personnel:read:pid ใน token (ไม่มี = ไม่แสดงปุ่ม และเข้าตรงก็ 403)
  router.get('/hr/persons/:personId/reveal-pid', (req, res) => {
    const { personId } = req.params;
    if (!UUID_RE.test(personId)) return send(req, res, 404, 'ไม่พบบุคคล', '<p class="error">ไม่พบบุคคลนี้</p>');
    if (!req.hrAuth.scopes.has(SCOPE_PID)) {
      return send(req, res, 403, 'ไม่มีสิทธิ์', '<p class="error">บัญชีนี้ยังไม่ได้รับสิทธิ์แสดงเลขบัตรประชาชน</p>');
    }
    return send(req, res, 200, 'แสดงเลขบัตรประชาชน', revealForm(req, personId));
  });

  router.post('/hr/persons/:personId/reveal-pid', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res, next) => {
    const { personId } = req.params;
    if (!UUID_RE.test(personId)) return send(req, res, 404, 'ไม่พบบุคคล', '<p class="error">ไม่พบบุคคลนี้</p>');
    if (!csrfTokenMatches(req.hrAuth.csrfToken, req.body?._csrf)) {
      return send(req, res, 403, 'คำขอไม่ถูกต้อง', '<p class="error">คำขอไม่ถูกต้องหรือหมดอายุ (CSRF) กรุณากลับไปเปิดหน้ารายละเอียดแล้วลองใหม่</p>');
    }
    if (!req.hrAuth.scopes.has(SCOPE_PID)) {
      return send(req, res, 403, 'ไม่มีสิทธิ์', '<p class="error">บัญชีนี้ยังไม่ได้รับสิทธิ์แสดงเลขบัตรประชาชน</p>');
    }

    const { reason, errors } = validateReason(req.body?.justification);
    if (errors.length > 0) {
      return send(req, res, 422, 'แสดงเลขบัตรประชาชน', revealForm(req, personId, { reason, errors }));
    }

    try {
      const pid = await mdmClient.revealPid(req.hrAuth.accessToken, personId, reason);
      // แสดงในการตอบกลับของ POST นี้โดยตรง (ไม่ redirect, ไม่เก็บใน session/log) - กลับไปหน้ารายละเอียดจะเป็นแบบปิดเหมือนเดิม
      return send(
        req,
        res,
        200,
        'เลขบัตรประชาชน',
        `<h1>เลขบัตรประชาชน</h1>
         <p class="pid">${escapeHtml(pid)}</p>
         <p class="hint">การดูครั้งนี้ถูกบันทึกใน audit log แล้ว ห้ามคัดลอกไปเก็บหรือส่งต่อโดยไม่จำเป็น</p>
         <p><a href="/hr/persons/${encodeURIComponent(personId)}">← กลับไปหน้ารายละเอียด</a></p>`
      );
    } catch (err) {
      if (err instanceof MdmApiError && [400, 403, 404].includes(err.status)) {
        return send(req, res, err.status, 'แสดงเลขบัตรประชาชน', `<p class="error">${escapeHtml(apiErrorText(err))}</p><p><a href="/hr/persons/${encodeURIComponent(personId)}">← กลับไปหน้ารายละเอียด</a></p>`);
      }
      return next(err);
    }
  });

  return router;
}

module.exports = { createPersonRoutes, validateReason };
