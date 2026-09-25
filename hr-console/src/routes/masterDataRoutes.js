const express = require('express');
const { escapeHtml, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');
const {
  POSITION_NO_PATTERN,
  POSITION_NO_MESSAGE,
  ORG_UNIT_CODE_PATTERN,
  ORG_UNIT_CODE_MESSAGE,
  UNIT_LEVELS,
  UUID_RE,
  parseOrgUnitForm,
  parsePositionForm,
} = require('../masterData');

// T10: หน้าจัดการ master data หน่วยงาน/ตำแหน่ง - เฉพาะผู้มี realm role hr_master_data_admin (แยกจาก hr_officer)
// gate ที่ HR Console นี้เป็นเพียงชั้นแรก (UX + ปิดทางเข้า) - MDM API ตรวจ scope personnel:manage:reference และ
// role จาก access token ซ้ำอีกชั้นเสมอ (ดู api/src/routes/reference.js)
const PAGE_SIZE = 50;
const UNIT_LEVEL_LABEL = Object.fromEntries(UNIT_LEVELS.map((l) => [l.value, l.label]));

function forbiddenPage(req) {
  return layout(
    'ไม่มีสิทธิ์',
    `<p class="error">บัญชีนี้ไม่มีสิทธิ์จัดการหน่วยงาน/ตำแหน่ง (ต้องมี role hr_master_data_admin) กรุณาติดต่อผู้ดูแลระบบ</p>`,
    { displayName: req.hrAuth.displayName, isMasterDataAdmin: false }
  );
}

// gate ชั้น HR Console: ต้องมี hr_master_data_admin (จาก session ที่ตรวจ id_token แล้ว) ไม่เช่นนั้น 403 ทุก method/path
function requireMasterDataAdmin(req, res, next) {
  if (!req.hrAuth?.isMasterDataAdmin) return res.status(403).send(forbiddenPage(req));
  return next();
}

function pageOpts(req) {
  return { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin };
}

function tabs(active) {
  return `<p class="tabs">
    <a href="/hr/master-data/org-units">${active === 'org' ? '<strong>หน่วยงาน</strong>' : 'หน่วยงาน'}</a>
    <a href="/hr/master-data/positions">${active === 'pos' ? '<strong>ตำแหน่ง</strong>' : 'ตำแหน่ง'}</a>
  </p>`;
}

function errorList(errors) {
  if (!errors || errors.length === 0) return '';
  return `<ul class="error">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
}

// แปลง error จาก MDM API เป็นข้อความในฟอร์ม (4xx ที่ผู้ใช้แก้ได้) - 5xx/อื่นๆ ส่งต่อให้ error handler กลาง
function apiErrorMessages(err) {
  const problem = err.problem || {};
  const messages = [];
  if (Array.isArray(problem.errors) && problem.errors.length > 0) {
    for (const e of problem.errors) messages.push(`${e.field || ''} ${e.message || ''}`.trim());
  } else {
    messages.push([problem.title, problem.detail].filter(Boolean).join(' - ') || `MDM API ปฏิเสธคำขอ (${err.status})`);
  }
  return messages;
}

function isUserFixableApiError(err) {
  return err instanceof MdmApiError && [400, 403, 404, 409, 422].includes(err.status);
}

function options(items, selected, { blank } = {}) {
  const blankOpt = blank !== undefined ? `<option value="">${escapeHtml(blank)}</option>` : '';
  return (
    blankOpt +
    items
      .map((i) => `<option value="${escapeHtml(i.value)}"${i.value === selected ? ' selected' : ''}>${escapeHtml(i.label)}</option>`)
      .join('')
  );
}

const orgUnitLabel = (o) => `${o.code} — ${o.nameTh}${o.isActive ? '' : ' (ปิดใช้งาน)'}`;

// สคริปต์ฝั่ง client: ตรวจ pattern แบบทันที (setCustomValidity), ตัดช่องว่างหัวท้ายก่อนตรวจ/ส่ง, ยืนยันก่อนปิดใช้งาน
const CLIENT_SCRIPT = `<script>
(function () {
  document.querySelectorAll('form[data-validate]').forEach(function (form) {
    form.querySelectorAll('[data-pattern]').forEach(function (input) {
      var re = new RegExp(input.getAttribute('data-pattern'));
      var msg = input.getAttribute('data-pattern-message');
      function check() {
        var v = input.value.trim();
        input.setCustomValidity(v === '' || re.test(v) ? '' : msg);
      }
      input.addEventListener('input', check);
      input.addEventListener('blur', function () { input.value = input.value.trim(); check(); });
      check();
    });
    form.addEventListener('submit', function (e) {
      var active = form.querySelector('select[name="isActive"]');
      if (active && active.getAttribute('data-was') === 'true' && active.value === 'false' &&
          !confirm('ยืนยันปิดใช้งานรายการนี้? (ไม่ลบข้อมูล เปิดใช้งานกลับได้ภายหลัง)')) {
        e.preventDefault();
      }
    });
  });
})();
</script>`;

function activeSelect(values, wasActive) {
  return `<label>สถานะ
      <select name="isActive" data-was="${wasActive ? 'true' : 'false'}">
        <option value="true"${values.isActive === 'true' ? ' selected' : ''}>ใช้งาน</option>
        <option value="false"${values.isActive === 'false' ? ' selected' : ''}>ปิดใช้งาน (soft-delete ไม่ลบข้อมูล)</option>
      </select>
    </label>`;
}

function renderOrgUnitForm({ action, mode, values, errors, orgUnits, selfId, wasActive }) {
  const parentChoices = orgUnits
    .filter((o) => o.orgUnitId !== selfId && (o.isActive || o.orgUnitId === values.parentId))
    .map((o) => ({ value: o.orgUnitId, label: orgUnitLabel(o) }));

  const codeField =
    mode === 'create'
      ? `<label>รหัสหน่วยงาน <span class="hint">(แก้ไม่ได้ภายหลัง)</span>
          <input name="code" required maxlength="50" pattern="${escapeHtml(ORG_UNIT_CODE_PATTERN)}"
                 data-pattern="${escapeHtml(ORG_UNIT_CODE_PATTERN)}" data-pattern-message="${escapeHtml(ORG_UNIT_CODE_MESSAGE)}"
                 title="${escapeHtml(ORG_UNIT_CODE_MESSAGE)}" value="${escapeHtml(values.code)}" />
        </label>`
      : `<label>รหัสหน่วยงาน <span class="hint">(แก้ไม่ได้)</span>
          <input value="${escapeHtml(values.code)}" disabled />
        </label>`;

  return `${errorList(errors)}
  <form method="post" action="${escapeHtml(action)}" data-validate>
    ${codeField}
    <label>ชื่อหน่วยงาน (ไทย) <input name="nameTh" required maxlength="255" value="${escapeHtml(values.nameTh)}" /></label>
    <label>ชื่อหน่วยงาน (อังกฤษ) <input name="nameEn" maxlength="255" value="${escapeHtml(values.nameEn)}" /></label>
    <label>ระดับ
      <select name="unitLevel" required>${options(UNIT_LEVELS, values.unitLevel, { blank: '-- เลือกระดับ --' })}</select>
    </label>
    <label>หน่วยงานต้นสังกัด
      <select name="parentId">${options(parentChoices, values.parentId, { blank: '-- ไม่มีต้นสังกัด --' })}</select>
    </label>
    ${mode === 'edit' ? activeSelect(values, wasActive) : ''}
    <p><button type="submit">บันทึก</button> <a href="/hr/master-data/org-units">ยกเลิก</a></p>
  </form>
  ${CLIENT_SCRIPT}`;
}

function renderPositionForm({ action, mode, values, errors, orgUnits, positionTypes, wasActive }) {
  const orgChoices = orgUnits
    .filter((o) => o.isActive || o.orgUnitId === values.orgUnitId)
    .map((o) => ({ value: o.orgUnitId, label: orgUnitLabel(o) }));
  const typeChoices = positionTypes
    .filter((t) => t.isActive || t.code === values.positionType)
    .map((t) => ({ value: t.code, label: `${t.nameTh}${t.isActive ? '' : ' (ปิดใช้งาน)'}` }));

  return `${errorList(errors)}
  <form method="post" action="${escapeHtml(action)}" data-validate>
    <label>เลขที่ตำแหน่ง
      <input name="positionNo" required maxlength="50" pattern="${escapeHtml(POSITION_NO_PATTERN)}"
             data-pattern="${escapeHtml(POSITION_NO_PATTERN)}" data-pattern-message="${escapeHtml(POSITION_NO_MESSAGE)}"
             title="${escapeHtml(POSITION_NO_MESSAGE)}" placeholder="52-1-07-3106-003" value="${escapeHtml(values.positionNo)}" />
      <span class="hint">ต้องไม่ซ้ำกับตำแหน่งอื่น</span>
    </label>
    <label>ชื่อตำแหน่ง <input name="titleTh" required maxlength="255" value="${escapeHtml(values.titleTh)}" /></label>
    <label>สายงาน <input name="lineOfWork" maxlength="100" value="${escapeHtml(values.lineOfWork)}" /></label>
    <label>หมวดตำแหน่ง
      <select name="positionType" required>${options(typeChoices, values.positionType, { blank: '-- เลือกหมวดตำแหน่ง --' })}</select>
    </label>
    <label>หน่วยงาน <span class="hint">(เลือกจากรายการเท่านั้น)</span>
      <select name="orgUnitId" required>${options(orgChoices, values.orgUnitId, { blank: '-- เลือกหน่วยงาน --' })}</select>
    </label>
    ${mode === 'edit' ? activeSelect(values, wasActive) : ''}
    <p><button type="submit">บันทึก</button> <a href="/hr/master-data/positions">ยกเลิก</a></p>
  </form>
  ${CLIENT_SCRIPT}`;
}

function statusFilterLinks(basePath, params, current) {
  const link = (value, label) => {
    const qs = new URLSearchParams({ ...params, status: value });
    qs.delete('page');
    return value === current ? `<strong>${label}</strong>` : `<a href="${basePath}?${escapeHtml(qs.toString())}">${label}</a>`;
  };
  return `<p>แสดง: ${link('active', 'ใช้งาน')} · ${link('inactive', 'ปิดใช้งาน')} · ${link('all', 'ทั้งหมด')}</p>`;
}

function filterByStatus(items, status) {
  if (status === 'inactive') return items.filter((i) => !i.isActive);
  if (status === 'all') return items;
  return items.filter((i) => i.isActive);
}

function normalizeStatus(value) {
  return ['active', 'inactive', 'all'].includes(value) ? value : 'active';
}

function createMasterDataRoutes({ mdmClient }) {
  const router = express.Router();
  router.use('/hr/master-data', requireMasterDataAdmin);

  const token = (req) => req.hrAuth.accessToken;
  const sendPage = (res, status, title, body, req) => res.status(status).send(layout(title, body, pageOpts(req)));

  // ส่งต่อ error ที่ผู้ใช้แก้ได้กลับไปแสดงในฟอร์ม; อย่างอื่น (รวม 5xx) ให้ error handler กลาง
  async function renderFormOrNext(err, req, res, next, render) {
    if (!isUserFixableApiError(err)) return next(err);
    return render(apiErrorMessages(err), err.status === 400 ? 422 : err.status);
  }

  router.get('/hr/master-data', (req, res) => res.redirect(302, '/hr/master-data/org-units'));

  // ---------------------------------------------------------------- org units
  router.get('/hr/master-data/org-units', async (req, res, next) => {
    try {
      const status = normalizeStatus(req.query.status);
      const all = await mdmClient.listOrgUnits(token(req), { activeOnly: false });
      const byId = new Map(all.map((o) => [o.orgUnitId, o]));
      const rows = filterByStatus(all, status)
        .map(
          (o) => `<tr>
            <td>${escapeHtml(o.code)}</td>
            <td>${escapeHtml(o.nameTh)}${o.nameEn ? `<br><span class="hint">${escapeHtml(o.nameEn)}</span>` : ''}</td>
            <td>${escapeHtml(UNIT_LEVEL_LABEL[o.unitLevel] || o.unitLevel)}</td>
            <td>${o.parentId && byId.get(o.parentId) ? escapeHtml(byId.get(o.parentId).nameTh) : '<span class="muted">-</span>'}</td>
            <td>${o.isActive ? 'ใช้งาน' : '<span class="muted">ปิดใช้งาน</span>'}</td>
            <td class="actions"><a href="/hr/master-data/org-units/${encodeURIComponent(o.orgUnitId)}/edit">แก้ไข</a></td>
          </tr>`
        )
        .join('');
      const saved = req.query.saved ? '<p class="ok">บันทึกเรียบร้อยแล้ว</p>' : '';
      sendPage(
        res,
        200,
        'หน่วยงาน',
        `<h1>จัดการหน่วยงาน</h1>${tabs('org')}${saved}
         <p><a href="/hr/master-data/org-units/new">+ เพิ่มหน่วยงาน</a></p>
         ${statusFilterLinks('/hr/master-data/org-units', {}, status)}
         <table>
           <tr><th>รหัส</th><th>ชื่อ</th><th>ระดับ</th><th>ต้นสังกัด</th><th>สถานะ</th><th></th></tr>
           ${rows || '<tr><td colspan="6">ไม่มีรายการ</td></tr>'}
         </table>`,
        req
      );
    } catch (err) {
      next(err);
    }
  });

  const emptyOrgValues = { code: '', nameTh: '', nameEn: '', unitLevel: '', parentId: '', isActive: 'true' };

  router.get('/hr/master-data/org-units/new', async (req, res, next) => {
    try {
      const orgUnits = await mdmClient.listOrgUnits(token(req), { activeOnly: false });
      sendPage(
        res,
        200,
        'เพิ่มหน่วยงาน',
        `<h1>เพิ่มหน่วยงาน</h1>${tabs('org')}${renderOrgUnitForm({ action: '/hr/master-data/org-units', mode: 'create', values: emptyOrgValues, errors: [], orgUnits })}`,
        req
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/hr/master-data/org-units', express.urlencoded({ extended: false }), async (req, res, next) => {
    const { body, values, errors } = parseOrgUnitForm(req.body || {}, { mode: 'create' });
    const render = async (errs, status) => {
      const orgUnits = await mdmClient.listOrgUnits(token(req), { activeOnly: false });
      sendPage(
        res,
        status,
        'เพิ่มหน่วยงาน',
        `<h1>เพิ่มหน่วยงาน</h1>${tabs('org')}${renderOrgUnitForm({ action: '/hr/master-data/org-units', mode: 'create', values, errors: errs, orgUnits })}`,
        req
      );
    };
    try {
      if (errors.length > 0) return await render(errors, 422);
      await mdmClient.createOrgUnit(token(req), body);
      return res.redirect(302, '/hr/master-data/org-units?saved=1');
    } catch (err) {
      return renderFormOrNext(err, req, res, next, render).catch(next);
    }
  });

  async function loadOrgUnit(req, res) {
    if (!UUID_RE.test(req.params.orgUnitId)) return null;
    const orgUnits = await mdmClient.listOrgUnits(token(req), { activeOnly: false });
    const existing = orgUnits.find((o) => o.orgUnitId === req.params.orgUnitId);
    return existing ? { orgUnits, existing } : null;
  }

  router.get('/hr/master-data/org-units/:orgUnitId/edit', async (req, res, next) => {
    try {
      const found = await loadOrgUnit(req, res);
      if (!found) return sendPage(res, 404, 'ไม่พบ', '<p class="error">ไม่พบหน่วยงานนี้</p>', req);
      const { orgUnits, existing } = found;
      const values = {
        code: existing.code,
        nameTh: existing.nameTh,
        nameEn: existing.nameEn || '',
        unitLevel: existing.unitLevel,
        parentId: existing.parentId || '',
        isActive: existing.isActive ? 'true' : 'false',
      };
      return sendPage(
        res,
        200,
        'แก้ไขหน่วยงาน',
        `<h1>แก้ไขหน่วยงาน</h1>${tabs('org')}${renderOrgUnitForm({
          action: `/hr/master-data/org-units/${encodeURIComponent(existing.orgUnitId)}`,
          mode: 'edit',
          values,
          errors: [],
          orgUnits,
          selfId: existing.orgUnitId,
          wasActive: existing.isActive,
        })}`,
        req
      );
    } catch (err) {
      return next(err);
    }
  });

  router.post('/hr/master-data/org-units/:orgUnitId', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const found = await loadOrgUnit(req, res);
      if (!found) return sendPage(res, 404, 'ไม่พบ', '<p class="error">ไม่พบหน่วยงานนี้</p>', req);
      const { existing } = found;
      const { body, values, errors } = parseOrgUnitForm(req.body || {}, { mode: 'edit' });
      values.code = existing.code;
      const render = async (errs, status) => {
        const orgUnits = await mdmClient.listOrgUnits(token(req), { activeOnly: false });
        sendPage(
          res,
          status,
          'แก้ไขหน่วยงาน',
          `<h1>แก้ไขหน่วยงาน</h1>${tabs('org')}${renderOrgUnitForm({
            action: `/hr/master-data/org-units/${encodeURIComponent(existing.orgUnitId)}`,
            mode: 'edit',
            values,
            errors: errs,
            orgUnits,
            selfId: existing.orgUnitId,
            wasActive: existing.isActive,
          })}`,
          req
        );
      };
      if (errors.length > 0) return await render(errors, 422);
      try {
        await mdmClient.updateOrgUnit(token(req), existing.orgUnitId, body);
        return res.redirect(302, '/hr/master-data/org-units?saved=1');
      } catch (err) {
        return await renderFormOrNext(err, req, res, next, render);
      }
    } catch (err) {
      return next(err);
    }
  });

  // ---------------------------------------------------------------- positions
  router.get('/hr/master-data/positions', async (req, res, next) => {
    try {
      const status = normalizeStatus(req.query.status);
      const orgUnitId = UUID_RE.test(req.query.orgUnitId || '') ? req.query.orgUnitId : '';
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

      const [orgUnits, positionTypes, allPositions] = await Promise.all([
        mdmClient.listOrgUnits(token(req), { activeOnly: false }),
        mdmClient.listPositionTypes(token(req)),
        mdmClient.listPositions(token(req), { orgUnitId: orgUnitId || undefined }),
      ]);
      const orgById = new Map(orgUnits.map((o) => [o.orgUnitId, o]));
      const typeByCode = new Map(positionTypes.map((t) => [t.code, t.nameTh]));

      const needle = q.toLowerCase();
      const filtered = filterByStatus(allPositions, status).filter(
        (p) => !needle || p.positionNo.toLowerCase().includes(needle) || p.titleTh.toLowerCase().includes(needle)
      );
      const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      const currentPage = Math.min(page, totalPages);
      const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

      const rows = pageItems
        .map(
          (p) => `<tr>
            <td>${escapeHtml(p.positionNo)}</td>
            <td>${escapeHtml(p.titleTh)}${p.lineOfWork ? `<br><span class="hint">${escapeHtml(p.lineOfWork)}</span>` : ''}</td>
            <td>${escapeHtml(typeByCode.get(p.positionType) || p.positionType)}</td>
            <td>${escapeHtml(orgById.get(p.orgUnitId)?.nameTh || '-')}</td>
            <td>${p.isActive ? 'ใช้งาน' : '<span class="muted">ปิดใช้งาน</span>'}</td>
            <td class="actions"><a href="/hr/master-data/positions/${encodeURIComponent(p.positionId)}/edit">แก้ไข</a></td>
          </tr>`
        )
        .join('');

      const baseParams = { ...(orgUnitId ? { orgUnitId } : {}), ...(q ? { q } : {}), status };
      const pageLink = (n, label) =>
        `<a href="/hr/master-data/positions?${escapeHtml(new URLSearchParams({ ...baseParams, page: String(n) }).toString())}">${label}</a>`;
      const pager =
        totalPages > 1
          ? `<p>หน้า ${currentPage}/${totalPages} ${currentPage > 1 ? pageLink(currentPage - 1, '‹ ก่อนหน้า') : ''} ${currentPage < totalPages ? pageLink(currentPage + 1, 'ถัดไป ›') : ''}</p>`
          : '';
      const orgFilter = options(
        orgUnits.map((o) => ({ value: o.orgUnitId, label: orgUnitLabel(o) })),
        orgUnitId,
        { blank: '-- ทุกหน่วยงาน --' }
      );
      const saved = req.query.saved ? '<p class="ok">บันทึกเรียบร้อยแล้ว</p>' : '';

      sendPage(
        res,
        200,
        'ตำแหน่ง',
        `<h1>จัดการตำแหน่ง</h1>${tabs('pos')}${saved}
         <p><a href="/hr/master-data/positions/new">+ เพิ่มตำแหน่ง</a></p>
         <form method="get" action="/hr/master-data/positions" class="row">
           <select name="orgUnitId">${orgFilter}</select>
           <input name="q" placeholder="ค้นหาเลขที่/ชื่อตำแหน่ง" value="${escapeHtml(q)}" />
           <input type="hidden" name="status" value="${escapeHtml(status)}" />
           <button type="submit">ค้นหา</button>
         </form>
         ${statusFilterLinks('/hr/master-data/positions', { ...(orgUnitId ? { orgUnitId } : {}), ...(q ? { q } : {}) }, status)}
         <p class="hint">พบ ${filtered.length} ตำแหน่ง</p>
         <table>
           <tr><th>เลขที่ตำแหน่ง</th><th>ชื่อตำแหน่ง</th><th>หมวด</th><th>หน่วยงาน</th><th>สถานะ</th><th></th></tr>
           ${rows || '<tr><td colspan="6">ไม่มีรายการ</td></tr>'}
         </table>${pager}`,
        req
      );
    } catch (err) {
      next(err);
    }
  });

  async function positionFormData(req) {
    const [orgUnits, positionTypes] = await Promise.all([
      mdmClient.listOrgUnits(token(req), { activeOnly: false }),
      mdmClient.listPositionTypes(token(req)),
    ]);
    return { orgUnits, positionTypes };
  }

  const emptyPositionValues = { positionNo: '', titleTh: '', lineOfWork: '', positionType: '', orgUnitId: '', isActive: 'true' };

  router.get('/hr/master-data/positions/new', async (req, res, next) => {
    try {
      const data = await positionFormData(req);
      sendPage(
        res,
        200,
        'เพิ่มตำแหน่ง',
        `<h1>เพิ่มตำแหน่ง</h1>${tabs('pos')}${renderPositionForm({ action: '/hr/master-data/positions', mode: 'create', values: emptyPositionValues, errors: [], ...data })}`,
        req
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/hr/master-data/positions', express.urlencoded({ extended: false }), async (req, res, next) => {
    const { body, values, errors } = parsePositionForm(req.body || {}, { mode: 'create' });
    const render = async (errs, status) => {
      const data = await positionFormData(req);
      sendPage(
        res,
        status,
        'เพิ่มตำแหน่ง',
        `<h1>เพิ่มตำแหน่ง</h1>${tabs('pos')}${renderPositionForm({ action: '/hr/master-data/positions', mode: 'create', values, errors: errs, ...data })}`,
        req
      );
    };
    try {
      if (errors.length > 0) return await render(errors, 422);
      await mdmClient.createPosition(token(req), body);
      return res.redirect(302, '/hr/master-data/positions?saved=1');
    } catch (err) {
      return renderFormOrNext(err, req, res, next, render).catch(next);
    }
  });

  async function loadPosition(req) {
    if (!UUID_RE.test(req.params.positionId)) return null;
    const positions = await mdmClient.listPositions(token(req), {});
    return positions.find((p) => p.positionId === req.params.positionId) || null;
  }

  router.get('/hr/master-data/positions/:positionId/edit', async (req, res, next) => {
    try {
      const existing = await loadPosition(req);
      if (!existing) return sendPage(res, 404, 'ไม่พบ', '<p class="error">ไม่พบตำแหน่งนี้</p>', req);
      const data = await positionFormData(req);
      const values = {
        positionNo: existing.positionNo,
        titleTh: existing.titleTh,
        lineOfWork: existing.lineOfWork || '',
        positionType: existing.positionType,
        orgUnitId: existing.orgUnitId,
        isActive: existing.isActive ? 'true' : 'false',
      };
      return sendPage(
        res,
        200,
        'แก้ไขตำแหน่ง',
        `<h1>แก้ไขตำแหน่ง</h1>${tabs('pos')}${renderPositionForm({
          action: `/hr/master-data/positions/${encodeURIComponent(existing.positionId)}`,
          mode: 'edit',
          values,
          errors: [],
          wasActive: existing.isActive,
          ...data,
        })}`,
        req
      );
    } catch (err) {
      return next(err);
    }
  });

  router.post('/hr/master-data/positions/:positionId', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const existing = await loadPosition(req);
      if (!existing) return sendPage(res, 404, 'ไม่พบ', '<p class="error">ไม่พบตำแหน่งนี้</p>', req);
      const { body, values, errors } = parsePositionForm(req.body || {}, { mode: 'edit' });
      const render = async (errs, status) => {
        const data = await positionFormData(req);
        sendPage(
          res,
          status,
          'แก้ไขตำแหน่ง',
          `<h1>แก้ไขตำแหน่ง</h1>${tabs('pos')}${renderPositionForm({
            action: `/hr/master-data/positions/${encodeURIComponent(existing.positionId)}`,
            mode: 'edit',
            values,
            errors: errs,
            wasActive: existing.isActive,
            ...data,
          })}`,
          req
        );
      };
      if (errors.length > 0) return await render(errors, 422);
      try {
        await mdmClient.updatePosition(token(req), existing.positionId, body);
        return res.redirect(302, '/hr/master-data/positions?saved=1');
      } catch (err) {
        return await renderFormOrNext(err, req, res, next, render);
      }
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createMasterDataRoutes, requireMasterDataAdmin };
