const express = require('express');
const { escapeHtml, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');
const { UUID_RE } = require('../masterData');
const { csrfTokenMatches } = require('../session/csrf');
const { isValidPid, normalizePidInput, looksLikePid } = require('../pid');
const { renderFailure, statusFor, failureMessage, isVersionConflict, problemType, isRemoteFailure } = require('../apiErrors');
const { POSITION_LOCK_SCRIPT, renderEmploymentFields, validateEmploymentInput, isRealDate } = require('../employmentForm');
const { todayBangkok, renderDateInput, formatThaiDate } = require('../thaiTime');

// PR-D3: HR เพิ่มบุคคลใหม่ / ย้ายหน่วยงาน-ตำแหน่ง-ประเภท / พ้นสภาพ / คืนสภาพ - เฉพาะผู้มี realm role hr_master_data_admin
// gate ที่นี่เป็นชั้นแรก (UX + ปิดทางเข้า) MDM API ตรวจ role + scope จาก token ซ้ำทุก request เสมอ (403 insufficient-role)
//
// กติกาที่ใช้ทุกฟอร์ม:
//  - CSRF token ต่อ session (เหมือนฟอร์มแสดงเลขบัตร) และไม่ cache หน้า
//  - ทุกการเขียนมีเหตุผล (บังคับ ห้ามมีเลข 13 หลัก) และส่ง expectedVersion ที่ได้ตอนโหลดฟอร์มเสมอ: 409 version-conflict -> บอกผู้ใช้ +
//    ปุ่ม "โหลดข้อมูลล่าสุด" (ไม่เก็บสิ่งที่พิมพ์ไว้เพราะค่าเดิมในฟอร์มล้าสมัยแล้ว)
//  - เลขบัตร (เฉพาะฟอร์มเพิ่มบุคคล): อยู่ใน POST body เท่านั้น ไม่เข้า URL/redirect/session/log และ "ไม่เติมกลับ" ลงฟอร์มเมื่อ validation ไม่ผ่าน
//    ฟอร์มย้าย/คืนสภาพไม่ส่งเลขบัตร (MDM API คงเลขเดิมของ employment ให้เมื่อไม่ส่ง employeeNo)
//  - error ของ API (403/404/409/422/400) แสดงเป็นภาษาไทย ไม่ใช่หน้า 500; ระบบล่ม/เครือข่าย -> 502 หน้าไทย

const REASON_MIN = 5;
const REASON_MAX = 500;
const NAME_MAX = 200;
const MIN_BIRTH_DATE = '1900-01-01';
const SEPARATION_STATUSES = [
  { value: 'RESIGNED', label: 'ลาออก' },
  { value: 'RETIRED', label: 'เกษียณอายุ' },
  { value: 'TRANSFERRED_OUT', label: 'โอนย้ายออก' },
  { value: 'TERMINATED', label: 'ถูกให้ออก/ปลดออก/เลิกจ้าง' },
  { value: 'DECEASED', label: 'เสียชีวิต' },
];

function pageOpts(req) {
  return { displayName: req.hrAuth.displayName, isMasterDataAdmin: req.hrAuth.isMasterDataAdmin };
}

function requireMasterDataAdmin(req, res, next) {
  if (!req.hrAuth?.isMasterDataAdmin) {
    return res
      .status(403)
      .send(
        layout('ไม่มีสิทธิ์', '<p class="error">บัญชีนี้ไม่มีสิทธิ์จัดการข้อมูลบุคคล (ต้องมี role hr_master_data_admin) กรุณาติดต่อผู้ดูแลระบบ</p><p><a href="/hr/persons">← กลับไปรายการ</a></p>', pageOpts(req))
      );
  }
  return next();
}

function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}

function errorList(errors) {
  return errors && errors.length > 0 ? `<ul class="error">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : '';
}

function csrfField(req) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(req.hrAuth.csrfToken)}" />`;
}

function validateWriteReason(raw) {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  const errors = [];
  if (reason.length < REASON_MIN) errors.push(`กรุณาระบุเหตุผลอย่างน้อย ${REASON_MIN} ตัวอักษร`);
  if (reason.length > REASON_MAX) errors.push(`เหตุผลยาวเกิน ${REASON_MAX} ตัวอักษร`);
  if (looksLikePid(reason)) errors.push('ห้ามใส่เลขบัตรประชาชนในเหตุผล');
  return { reason, errors };
}

function reasonField(value) {
  return `<label>เหตุผล <span class="hint">(จำเป็น ${REASON_MIN}–${REASON_MAX} ตัวอักษร ห้ามใส่เลขบัตรประชาชน - บันทึกในประวัติการเปลี่ยนแปลง)</span></label>
    <textarea name="reason" rows="3" maxlength="${REASON_MAX}" required>${escapeHtml(value)}</textarea>`;
}

function parseExpectedVersion(raw) {
  return /^\d{1,9}$/.test(String(raw ?? '')) && Number(raw) >= 1 ? Number(raw) : null;
}

const personName = (basic = {}) => `${basic.titleTh || ''}${basic.firstNameTh || ''} ${basic.lastNameTh || ''}`.trim() || '(ไม่มีชื่อ)';

const byEffectiveDesc = (a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom));

function employmentPrefill(e = {}) {
  return {
    personnelType: e.personnelType,
    orgUnitId: e.orgUnit?.orgUnitId,
    positionId: e.position?.positionId,
    jobTitleText: e.jobTitleText,
    appointedDate: e.appointedDate,
    levelCode: e.levelCode,
    emailWork: e.emailWork,
  };
}

function createPersonEditRoutes({ mdmClient }) {
  const router = express.Router();
  const send = (req, res, status, title, body) => res.status(status).send(layout(title, body, pageOpts(req)));
  const guard = [noStore, requireMasterDataAdmin];

  // หน้าความล้มเหลว (ไม่มีฟอร์ม): ข้อความไทย + ปุ่มโหลดล่าสุดเมื่อ version-conflict + ลิงก์กลับ
  const sendFailure = (req, res, err, { title, reloadUrl, backUrl, backLabel }) =>
    send(req, res, statusFor(err), title, renderFailure(err, { reloadUrl, backUrl, backLabel }));

  const csrfFailure = (req, res, backUrl) =>
    send(req, res, 403, 'คำขอไม่ถูกต้อง', `<p class="error">คำขอไม่ถูกต้องหรือหมดอายุ (CSRF) กรุณากลับไปเปิดหน้านี้ใหม่แล้วลองอีกครั้ง</p><p><a href="${escapeHtml(backUrl)}">← กลับ</a></p>`);

  async function loadLists(token) {
    const [orgUnits, positions, positionTypes] = await Promise.all([
      mdmClient.listOrgUnits(token, { activeOnly: true }),
      mdmClient.listPositions(token, { activeOnly: true }),
      mdmClient.listPositionTypes(token, { activeOnly: false }),
    ]);
    return { orgUnits, positions, positionTypes };
  }

  // ข้อมูลบุคคลปัจจุบัน + ประวัติการจ้าง (employee_no ถูกตัดทิ้งโดย mdmClient เสมอ)
  async function loadPerson(token, personId) {
    const [person, history] = await Promise.all([mdmClient.getPerson(token, personId), mdmClient.getEmployment(token, personId)]);
    const sorted = [...history].sort(byEffectiveDesc);
    return { person, history: sorted, current: sorted.find((e) => e.isCurrent) || null, latest: sorted[0] || null };
  }


  // ------------------------------------------------------------------------------------------------------------------ เพิ่มบุคคลใหม่

  function renderCreateForm(req, lists, { values = {}, errors = [], pidNotice = false } = {}) {
    return `<h1>เพิ่มบุคคลใหม่</h1>
      <p>ระบบสร้าง record สถานะ <strong>รอยืนยันตัวตน (PENDING_CLAIM)</strong> เมื่อบุคคลนี้เข้าสู่ระบบด้วย ThaID ครั้งแรก ระบบจะเชื่อมกับ record นี้อัตโนมัติและเติมข้อมูลระบุตัวตนจาก ThaID
      ชื่อและวันเกิดที่กรอกที่นี่เป็นข้อมูลที่ HR กรอก <strong>รอยืนยันด้วย ThaID</strong> (ThaID เป็นหลักเสมอ)</p>
      ${errorList(errors)}
      ${pidNotice ? '<p class="error">เพื่อความปลอดภัย ระบบไม่เติมเลขบัตรประชาชนกลับลงฟอร์ม กรุณากรอกเลขบัตรอีกครั้ง</p>' : ''}
      <form method="post" action="/hr/persons/new" autocomplete="off">
        ${csrfField(req)}
        <label>เลขบัตรประชาชน 13 หลัก <span class="hint">(ตรวจหลักสุดท้ายอัตโนมัติ - ส่งเฉพาะตอนกดบันทึก ไม่แสดงซ้ำ ไม่บันทึกไว้ในหน้าจอ)</span></label>
        <input name="pid" inputmode="numeric" maxlength="17" autocomplete="off" required />
        <div class="row">
          <div><label>ชื่อ (ไทย)</label><input name="firstNameTh" maxlength="${NAME_MAX}" value="${escapeHtml(values.firstNameTh)}" required /></div>
          <div><label>นามสกุล (ไทย)</label><input name="lastNameTh" maxlength="${NAME_MAX}" value="${escapeHtml(values.lastNameTh)}" required /></div>
        </div>
        <label>วันเกิด <span class="hint">(ไม่บังคับ)</span></label>
        ${renderDateInput({ name: 'birthDate', value: values.birthDate || '', min: MIN_BIRTH_DATE, max: todayBangkok() })}
        ${renderEmploymentFields({ values: { effectiveFrom: todayBangkok(), ...values }, ...lists })}
        ${reasonField(values.reason)}
        <p><button type="submit" class="primary">เพิ่มบุคคล</button> <a href="/hr/persons">ยกเลิก</a></p>
      </form>
      ${POSITION_LOCK_SCRIPT}`;
  }

  router.get('/hr/persons/new', ...guard, async (req, res, next) => {
    try {
      const lists = await loadLists(req.hrAuth.accessToken);
      send(req, res, 200, 'เพิ่มบุคคลใหม่', renderCreateForm(req, lists));
    } catch (err) {
      if (isRemoteFailure(err)) return sendFailure(req, res, err, { title: 'เพิ่มบุคคลใหม่', backUrl: '/hr/persons', backLabel: '← กลับไปรายการ' });
      return next(err);
    }
  });

  router.post('/hr/persons/new', ...guard, express.urlencoded({ extended: false, limit: '32kb' }), async (req, res, next) => {
    if (!csrfTokenMatches(req.hrAuth.csrfToken, req.body?._csrf)) return csrfFailure(req, res, '/hr/persons/new');
    const token = req.hrAuth.accessToken;
    const text = (v) => (typeof v === 'string' ? v.trim() : '');

    // ค่าที่เติมกลับฟอร์มได้ "ไม่รวมเลขบัตร" (pid ถูกทิ้งทันทีหลังตรวจ/ส่ง)
    const values = {
      firstNameTh: text(req.body.firstNameTh),
      lastNameTh: text(req.body.lastNameTh),
      birthDate: text(req.body.birthDate),
      reason: text(req.body.reason),
    };
    try {
      const errors = [];
      const pid = normalizePidInput(req.body.pid);
      if (!/^\d{13}$/.test(pid)) errors.push('เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก');
      else if (!isValidPid(pid)) errors.push('เลขบัตรประชาชนไม่ถูกต้อง (ไม่ผ่านการตรวจหลักสุดท้าย) กรุณาตรวจสอบเลขที่กรอก');

      for (const [key, label] of [['firstNameTh', 'ชื่อ'], ['lastNameTh', 'นามสกุล']]) {
        if (!values[key]) errors.push(`กรุณากรอก${label}`);
        else if (values[key].length > NAME_MAX) errors.push(`${label}ยาวเกิน ${NAME_MAX} ตัวอักษร`);
        else if (looksLikePid(values[key])) errors.push(`${label}ห้ามมีเลขบัตรประชาชน`);
      }
      if (values.birthDate) {
        if (!isRealDate(values.birthDate)) errors.push('วันเกิดไม่ถูกต้อง');
        else if (values.birthDate < MIN_BIRTH_DATE || values.birthDate > todayBangkok()) errors.push(`วันเกิดต้องอยู่ระหว่าง ${formatThaiDate(MIN_BIRTH_DATE)} ถึงวันนี้`);
      }
      const reasonCheck = validateWriteReason(values.reason);
      errors.push(...reasonCheck.errors);

      const employmentCheck = await validateEmploymentInput({ body: req.body, mdmClient, token });
      errors.push(...employmentCheck.errors);
      Object.assign(values, employmentCheck.values);

      if (errors.length > 0) {
        const lists = await loadLists(token);
        return send(req, res, 422, 'เพิ่มบุคคลใหม่', renderCreateForm(req, lists, { values, errors, pidNotice: true }));
      }

      const created = await mdmClient.createPerson(token, {
        pid,
        expectedFirstNameTh: values.firstNameTh,
        expectedLastNameTh: values.lastNameTh,
        expectedBirthDate: values.birthDate || undefined,
        reason: reasonCheck.reason,
        employment: { ...employmentCheck.employment, employeeNo: pid },
      });
      return res.redirect(303, `/hr/persons/${encodeURIComponent(created.personId)}?saved=created`);
    } catch (err) {
      if (!isRemoteFailure(err)) return next(err);
      // API ปฏิเสธ (เช่น 409 duplicate-pid / 422): กลับมาที่ฟอร์มพร้อมข้อความไทย คงค่าที่กรอกยกเว้นเลขบัตร
      const links = [];
      if (err instanceof MdmApiError && problemType(err) === 'duplicate-pid' && UUID_RE.test(err.problem?.existingPersonId || '')) {
        links.push(`<p>ดูข้อมูลบุคคลที่มีอยู่แล้ว: <a href="/hr/persons/${encodeURIComponent(err.problem.existingPersonId)}">เปิดรายละเอียด</a></p>`);
      }
      if (err instanceof MdmApiError && [401, 403].includes(err.status)) {
        return sendFailure(req, res, err, { title: 'เพิ่มบุคคลใหม่', backUrl: '/hr/persons', backLabel: '← กลับไปรายการ' });
      }
      try {
        const lists = await loadLists(token);
        return send(req, res, statusFor(err), 'เพิ่มบุคคลใหม่', `${links.join('')}${renderCreateForm(req, lists, { values, errors: [failureMessage(err)], pidNotice: true })}`);
      } catch (inner) {
        return sendFailure(req, res, inner, { title: 'เพิ่มบุคคลใหม่', backUrl: '/hr/persons', backLabel: '← กลับไปรายการ' });
      }
    }
  });

  // ------------------------------------------------------------------------------------------------------------- ย้ายหน่วยงาน/ตำแหน่ง/ประเภท

  const editUrl = (personId) => `/hr/persons/${encodeURIComponent(personId)}/employment/edit`;
  const detailUrl = (personId) => `/hr/persons/${encodeURIComponent(personId)}`;

  function renderEmploymentForm(req, { personId, person, current, lists, values, errors = [], reason = '', kind = 'edit', latest }) {
    const isEdit = kind === 'edit';
    const minDate = isEdit ? current?.effectiveFrom : '';
    return `<h1>${isEdit ? 'ย้ายหน่วยงาน / ตำแหน่ง / ประเภทบุคลากร' : 'คืนสภาพ'} - ${escapeHtml(personName(person.basic))}</h1>
      <p>${
        isEdit
          ? 'ระบบจะปิดข้อมูลการจ้างปัจจุบัน (สิ้นสุดวันที่มีผลใหม่) และเปิดข้อมูลใหม่ เก็บประวัติเป็นช่วงเวลา เลขบัตรประชาชนคงเดิม ไม่ต้องกรอก'
          : 'คืนสถานะใช้งานและเปิดข้อมูลการจ้างใหม่ ผู้ใช้ต้องยืนยันตัวตนผ่าน ThaID ใหม่ในการเข้าสู่ระบบครั้งถัดไป เลขบัตรประชาชนคงเดิม ไม่ต้องกรอก'
      }</p>
      ${isEdit && current ? `<p class="hint">ข้อมูลปัจจุบันมีผลตั้งแต่ ${escapeHtml(formatThaiDate(current.effectiveFrom))} - วันที่มีผลใหม่ต้องไม่ก่อนวันนี้</p>` : ''}
      ${!isEdit && latest?.separationDate ? `<p class="hint">พ้นสภาพเมื่อ ${escapeHtml(formatThaiDate(latest.separationDate))}</p>` : ''}
      ${errorList(errors)}
      <form method="post" action="/hr/persons/${encodeURIComponent(personId)}/${isEdit ? 'employment/edit' : 'reactivate'}" autocomplete="off">
        ${csrfField(req)}
        <input type="hidden" name="expectedVersion" value="${escapeHtml(person.version)}" />
        ${renderEmploymentFields({ values: { effectiveFrom: todayBangkok(), ...values }, ...lists, effectiveFromMin: minDate || undefined })}
        ${reasonField(reason)}
        <p><button type="submit" class="primary">${isEdit ? 'บันทึกการเปลี่ยนแปลง' : 'คืนสภาพ'}</button> <a href="${detailUrl(personId)}">ยกเลิก</a></p>
      </form>
      ${POSITION_LOCK_SCRIPT}`;
  }

  async function showEmploymentForm(req, res, next, kind) {
    const { personId } = req.params;
    if (!UUID_RE.test(personId)) return send(req, res, 404, 'ไม่พบบุคคล', '<p class="error">ไม่พบบุคคลนี้</p>');
    const title = kind === 'edit' ? 'ย้ายหน่วยงาน/ตำแหน่ง' : 'คืนสภาพ';
    try {
      const token = req.hrAuth.accessToken;
      const [ctx, lists] = await Promise.all([loadPerson(token, personId), loadLists(token)]);
      const { person, current, latest } = ctx;
      if (kind === 'edit' && person.status === 'INACTIVE') {
        return send(req, res, 409, title, `<p class="error">บุคคลนี้พ้นสภาพแล้ว ย้ายหน่วยงานไม่ได้ ใช้ "คืนสภาพ" แทน</p><p><a href="${detailUrl(personId)}">← กลับ</a></p>`);
      }
      if (kind === 'reactivate' && person.status !== 'INACTIVE') {
        return send(req, res, 409, title, `<p class="error">คืนสภาพได้เฉพาะบุคคลที่พ้นสภาพแล้ว</p><p><a href="${detailUrl(personId)}">← กลับ</a></p>`);
      }
      const base = kind === 'edit' ? current : latest;
      if (!base) {
        return send(req, res, 409, title, `<p class="error">ไม่พบข้อมูลการจ้างเดิมของบุคคลนี้</p><p><a href="${detailUrl(personId)}">← กลับ</a></p>`);
      }
      return send(req, res, 200, title, renderEmploymentForm(req, { personId, person, current, latest, lists, values: employmentPrefill(base), kind }));
    } catch (err) {
      if (isRemoteFailure(err)) return sendFailure(req, res, err, { title, backUrl: detailUrl(personId), backLabel: '← กลับ' });
      return next(err);
    }
  }

  async function saveEmployment(req, res, next, kind) {
    const { personId } = req.params;
    if (!UUID_RE.test(personId)) return send(req, res, 404, 'ไม่พบบุคคล', '<p class="error">ไม่พบบุคคลนี้</p>');
    const title = kind === 'edit' ? 'ย้ายหน่วยงาน/ตำแหน่ง' : 'คืนสภาพ';
    const formUrl = kind === 'edit' ? editUrl(personId) : `/hr/persons/${encodeURIComponent(personId)}/reactivate`;
    if (!csrfTokenMatches(req.hrAuth.csrfToken, req.body?._csrf)) return csrfFailure(req, res, formUrl);
    const token = req.hrAuth.accessToken;
    const expectedVersion = parseExpectedVersion(req.body.expectedVersion);
    if (expectedVersion === null) {
      return send(req, res, 422, title, `<p class="error">ข้อมูลฟอร์มไม่ครบ กรุณาเปิดหน้านี้ใหม่</p><p><a class="button" href="${formUrl}">โหลดข้อมูลล่าสุด</a></p>`);
    }

    try {
      const reasonCheck = validateWriteReason(req.body.reason);
      const employmentCheck = await validateEmploymentInput({ body: req.body, mdmClient, token });
      const errors = [...reasonCheck.errors, ...employmentCheck.errors];

      let ctx;
      let lists;
      const reload = async () => {
        [ctx, lists] = await Promise.all([loadPerson(token, personId), loadLists(token)]);
      };
      if (kind === 'edit' && errors.length === 0) {
        await reload();
        if (ctx.current && employmentCheck.employment.effectiveFrom < ctx.current.effectiveFrom) {
          errors.push(`วันที่มีผลต้องไม่ก่อน ${formatThaiDate(ctx.current.effectiveFrom)} (วันที่มีผลของข้อมูลการจ้างปัจจุบัน)`);
        }
      }

      const redisplay = async (errs, status) => {
        if (!ctx) await reload();
        // เติมเวอร์ชันที่ผู้ใช้เห็นตอนเปิดฟอร์ม (ไม่ใช่ล่าสุด) เพื่อให้ API ตัดสิน version-conflict เอง
        const person = { ...ctx.person, version: expectedVersion };
        return send(req, res, status, title, renderEmploymentForm(req, { personId, person, current: ctx.current, latest: ctx.latest, lists, values: employmentCheck.values, errors: errs, reason: reasonCheck.reason, kind }));
      };
      if (errors.length > 0) return await redisplay(errors, 422);

      const body = { ...employmentCheck.employment, reason: reasonCheck.reason, expectedVersion };
      try {
        if (kind === 'edit') await mdmClient.updateEmployment(token, personId, body);
        else await mdmClient.reactivatePerson(token, personId, body);
      } catch (err) {
        if (!(err instanceof MdmApiError)) throw err;
        if (isVersionConflict(err) || [401, 403, 404].includes(err.status) || err.status >= 500) {
          return sendFailure(req, res, err, { title, reloadUrl: formUrl, backUrl: detailUrl(personId), backLabel: '← กลับไปหน้ารายละเอียด' });
        }
        return await redisplay([failureMessage(err)], statusFor(err));
      }

      // ตรวจว่าเปลี่ยนจริงหรือไม่ (API ตอบ 200 แม้ไม่มีอะไรเปลี่ยน และไม่เพิ่ม version) เพื่อไม่บอกว่า "บันทึกแล้ว" ทั้งที่ไม่ได้บันทึก
      let saved = kind === 'edit' ? 'employment' : 'reactivated';
      if (kind === 'edit') {
        const after = await mdmClient.getPerson(token, personId);
        if (after.version === expectedVersion) saved = 'nochange';
      }
      return res.redirect(303, `${detailUrl(personId)}?saved=${saved}`);
    } catch (err) {
      if (isRemoteFailure(err)) return sendFailure(req, res, err, { title, reloadUrl: formUrl, backUrl: detailUrl(personId), backLabel: '← กลับ' });
      return next(err);
    }
  }

  router.get('/hr/persons/:personId/employment/edit', ...guard, (req, res, next) => showEmploymentForm(req, res, next, 'edit'));
  router.post('/hr/persons/:personId/employment/edit', ...guard, express.urlencoded({ extended: false, limit: '32kb' }), (req, res, next) => saveEmployment(req, res, next, 'edit'));
  router.get('/hr/persons/:personId/reactivate', ...guard, (req, res, next) => showEmploymentForm(req, res, next, 'reactivate'));
  router.post('/hr/persons/:personId/reactivate', ...guard, express.urlencoded({ extended: false, limit: '32kb' }), (req, res, next) => saveEmployment(req, res, next, 'reactivate'));

  // -------------------------------------------------------------------------------------------------------------------------- พ้นสภาพ

  function renderDeactivateForm(req, { personId, person, values = {}, errors = [] }) {
    const options = SEPARATION_STATUSES.map(
      (s) => `<option value="${escapeHtml(s.value)}"${s.value === values.employmentStatus ? ' selected' : ''}>${escapeHtml(s.label)}</option>`
    ).join('');
    return `<h1>พ้นสภาพ - ${escapeHtml(personName(person.basic))}</h1>
      <p class="error"><strong>คำเตือน:</strong> เมื่อบันทึก ระบบจะระงับสถานะบุคคลนี้ทันที ปิดข้อมูลการจ้างปัจจุบัน ตัดการเข้าถึงระบบทั้งหมดและแจ้งระบบปลายทางทุกระบบ ย้อนกลับได้ด้วย "คืนสภาพ" เท่านั้น</p>
      ${errorList(errors)}
      <form method="post" action="/hr/persons/${encodeURIComponent(personId)}/deactivate" autocomplete="off" onsubmit="return confirm('ยืนยันให้บุคคลนี้พ้นสภาพ?')">
        ${csrfField(req)}
        <input type="hidden" name="expectedVersion" value="${escapeHtml(person.version)}" />
        <label>สาเหตุที่พ้นสภาพ</label>
        <select name="employmentStatus" required>${options}</select>
        <label>วันที่พ้นสภาพ</label>
        ${renderDateInput({ name: 'separationDate', value: values.separationDate || todayBangkok(), required: true })}
        <label>เลขที่คำสั่ง (referenceDocument) <span class="hint">(ไม่บังคับ)</span></label>
        <input name="referenceDocument" maxlength="200" value="${escapeHtml(values.referenceDocument)}" />
        ${reasonField(values.reason)}
        <p><button type="submit" class="primary">บันทึกการพ้นสภาพ</button> <a href="${detailUrl(personId)}">ยกเลิก</a></p>
      </form>`;
  }

  router.get('/hr/persons/:personId/deactivate', ...guard, async (req, res, next) => {
    const { personId } = req.params;
    if (!UUID_RE.test(personId)) return send(req, res, 404, 'ไม่พบบุคคล', '<p class="error">ไม่พบบุคคลนี้</p>');
    try {
      const person = await mdmClient.getPerson(req.hrAuth.accessToken, personId);
      if (person.status === 'INACTIVE') {
        return send(req, res, 409, 'พ้นสภาพ', `<p class="error">บุคคลนี้พ้นสภาพไปแล้ว</p><p><a href="${detailUrl(personId)}">← กลับ</a></p>`);
      }
      return send(req, res, 200, 'พ้นสภาพ', renderDeactivateForm(req, { personId, person }));
    } catch (err) {
      if (isRemoteFailure(err)) return sendFailure(req, res, err, { title: 'พ้นสภาพ', backUrl: detailUrl(personId), backLabel: '← กลับ' });
      return next(err);
    }
  });

  router.post('/hr/persons/:personId/deactivate', ...guard, express.urlencoded({ extended: false, limit: '32kb' }), async (req, res, next) => {
    const { personId } = req.params;
    if (!UUID_RE.test(personId)) return send(req, res, 404, 'ไม่พบบุคคล', '<p class="error">ไม่พบบุคคลนี้</p>');
    const formUrl = `/hr/persons/${encodeURIComponent(personId)}/deactivate`;
    if (!csrfTokenMatches(req.hrAuth.csrfToken, req.body?._csrf)) return csrfFailure(req, res, formUrl);
    const token = req.hrAuth.accessToken;
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    const expectedVersion = parseExpectedVersion(req.body.expectedVersion);
    if (expectedVersion === null) {
      return send(req, res, 422, 'พ้นสภาพ', `<p class="error">ข้อมูลฟอร์มไม่ครบ กรุณาเปิดหน้านี้ใหม่</p><p><a class="button" href="${formUrl}">โหลดข้อมูลล่าสุด</a></p>`);
    }
    const values = {
      employmentStatus: text(req.body.employmentStatus),
      separationDate: text(req.body.separationDate),
      referenceDocument: text(req.body.referenceDocument),
      reason: text(req.body.reason),
    };
    try {
      const errors = [];
      if (!SEPARATION_STATUSES.some((s) => s.value === values.employmentStatus)) errors.push('กรุณาเลือกสาเหตุที่พ้นสภาพ');
      if (!isRealDate(values.separationDate)) errors.push('กรุณาระบุวันที่พ้นสภาพให้ถูกต้อง');
      if (values.referenceDocument.length > 200) errors.push('เลขที่คำสั่งยาวเกิน 200 ตัวอักษร');
      else if (looksLikePid(values.referenceDocument)) errors.push('เลขที่คำสั่งห้ามมีเลขบัตรประชาชน');
      const reasonCheck = validateWriteReason(values.reason);
      errors.push(...reasonCheck.errors);

      const redisplay = async (errs, status) => {
        const person = { ...(await mdmClient.getPerson(token, personId)), version: expectedVersion };
        return send(req, res, status, 'พ้นสภาพ', renderDeactivateForm(req, { personId, person, values, errors: errs }));
      };
      if (errors.length > 0) return await redisplay(errors, 422);

      try {
        await mdmClient.deactivatePerson(token, personId, {
          employmentStatus: values.employmentStatus,
          separationDate: values.separationDate,
          reason: reasonCheck.reason,
          referenceDocument: values.referenceDocument || undefined,
          expectedVersion,
        });
      } catch (err) {
        if (!(err instanceof MdmApiError)) throw err;
        if (isVersionConflict(err) || [401, 403, 404, 409].includes(err.status) || err.status >= 500) {
          return sendFailure(req, res, err, { title: 'พ้นสภาพ', reloadUrl: formUrl, backUrl: detailUrl(personId), backLabel: '← กลับไปหน้ารายละเอียด' });
        }
        return await redisplay([failureMessage(err)], statusFor(err));
      }
      return res.redirect(303, `${detailUrl(personId)}?saved=deactivated`);
    } catch (err) {
      if (isRemoteFailure(err)) return sendFailure(req, res, err, { title: 'พ้นสภาพ', reloadUrl: formUrl, backUrl: detailUrl(personId), backLabel: '← กลับ' });
      return next(err);
    }
  });

  return router;
}

module.exports = {
  createPersonEditRoutes,
  validateWriteReason,
  SEPARATION_STATUSES,
  REASON_MIN,
  // ใช้ร่วมกับหน้าแก้ข้อมูลส่วนบุคคล (PR-D4)
  pageOpts,
  requireMasterDataAdmin,
  noStore,
  errorList,
  csrfField,
  reasonField,
  parseExpectedVersion,
  personName,
};
