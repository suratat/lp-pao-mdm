const express = require('express');
const { escapeHtml, layout } = require('../views/html');
const { MdmApiError } = require('../mdmClient');
const { UUID_RE } = require('../masterData');
const { csrfTokenMatches } = require('../session/csrf');
const { looksLikePid } = require('../pid');
const { renderFailure, statusFor, failureMessage, isVersionConflict, isRemoteFailure } = require('../apiErrors');
const { isRealDate } = require('../employmentForm');
const { todayBangkok, renderDateInput, formatThaiDate } = require('../thaiTime');
const rules = require('../contactValidation');
const { ruleAttrs, fieldErrorHtml, emailCheckWidgetHtml, contactFormScript } = require('../contactFormUi');
const { createCheckEmailHandler, createRateLimiter } = require('../emailCheck');
const { pageOpts, requireMasterDataAdmin, noStore, errorList, csrfField, reasonField, parseExpectedVersion, validateWriteReason } = require('./personEditRoutes');

// PR-D4: HR แก้ข้อมูลส่วนบุคคล (ข้อมูลติดต่อ, ผู้ติดต่อฉุกเฉิน, ชื่อ-วันเกิดที่ HR กรอกของคนที่ยังไม่ยืนยัน ThaID) - เฉพาะ hr_master_data_admin
// กติกา: อ่านจาก GET /persons/{id}/manage-profile ทุกครั้ง (หน้าแสดงค่าเต็มเฉพาะหน้าแก้ไข หน้ารายละเอียดไม่แสดงข้อมูลติดต่อเลย), เหตุผลบังคับ,
// expectedVersion จากตอนเปิดฟอร์ม, CSRF, ไม่ cache; 409 version-conflict -> ปุ่มโหลดข้อมูลล่าสุด; 409 identity-locked / 403 / 422 -> หน้าไทย ไม่ใช่ 500
// ข้อมูลติดต่อ/ผู้ติดต่อฉุกเฉินไม่ถูกใส่ใน URL, redirect, session หรือ log ใดๆ (redirect มีแค่รหัส ?saved=)

const NAME_MAX = 200;
const MIN_BIRTH_DATE = '1900-01-01';

// ไม่เก็บที่อยู่ปัจจุบันทุกช่อง (บ้านเลขที่, ข้อความเต็ม, หมู่, ซอย, ถนน, รหัสไปรษณีย์, รหัสพื้นที่, sameAsRegistered) แล้ว (API ไม่รับ; ข้อมูลเดิมคงอยู่ในฐานข้อมูล) ป้าย emailPersonal ที่ผู้ใช้เห็นคือ "อีเมล"
// rule = กติกาตรวจรูปแบบ (contactValidation.js) ใช้ทั้งฝั่ง browser, เซิร์ฟเวอร์นี้ และ API (ตัวตัดสิน)
const CONTACT_FIELDS = [
  { key: 'mobilePhone', label: 'เบอร์โทรศัพท์มือถือ', max: 30, hint: 'ตัวเลข 10 หลักขึ้นต้น 06, 08 หรือ 09 เช่น 0812345678', group: 'contact', rule: 'mobile', validate: rules.validateMobile },
  { key: 'phoneAlt', label: 'เบอร์โทรสำรอง', max: 30, hint: 'มือถือ หรือโทรศัพท์บ้าน/สำนักงาน 9 หลักขึ้นต้น 02, 03, 04, 05 หรือ 07', group: 'contact', rule: 'phoneAlt', validate: rules.validatePhoneAlt },
  { key: 'emailPersonal', label: 'อีเมล', max: 300, group: 'contact', rule: 'email', validate: rules.validateEmail },
  { key: 'lineId', label: 'LINE ID', max: 100, group: 'contact' },
];
const EMERGENCY_SLOTS = [1, 2, 3];
const EMERGENCY_FIELDS = [
  { key: 'fullName', label: 'ชื่อ-นามสกุล', max: 200 },
  { key: 'relationship', label: 'ความสัมพันธ์', max: 50 },
  { key: 'phone', label: 'เบอร์โทร', max: 20 },
];

const LOCKED_MESSAGES = {
  THAID_VERIFIED: 'บุคคลนี้ยืนยันตัวตนผ่าน ThaID แล้ว ชื่อ-นามสกุลและวันเกิดมาจาก ThaID เป็นหลัก แก้ด้วยมือไม่ได้',
  NOT_PENDING_CLAIM: 'บุคคลนี้ไม่ได้อยู่ในสถานะรอยืนยันตัวตน (PENDING_CLAIM) จึงแก้ชื่อ-นามสกุลและวันเกิดที่ HR กรอกไม่ได้',
};

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const personUrl = (personId) => `/hr/persons/${encodeURIComponent(personId)}`;

// error สังเคราะห์ที่หน้านี้ตัดสินเองก่อนเรียก API (เช่น version ไม่ตรงตอนคำนวณฟิลด์ที่เปลี่ยน) ใช้ข้อความเดียวกับที่ API ตอบ
// ฟอร์มที่แสดงซ้ำหลัง validation ไม่ผ่าน "ไม่เติมกลับ" ค่าที่ดูเหมือนเลขบัตร (กฎข้อ 1: ห้าม pid ปรากฏใน response) - ผู้ใช้ได้ข้อความบอกให้แก้อยู่แล้ว
const scrub = (value) => {
  if (typeof value === 'string') return looksLikePid(value) ? '' : value;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
};

// compute() โยนเมื่อค่าที่แก้ไม่ผ่านการตรวจรูปแบบ (ข้อความไทยพร้อมแสดง ไม่มีค่าที่กรอก)
class FormErrors extends Error {
  constructor(errors, original) {
    super('form-errors');
    this.errors = errors;
    this.original = original; // ค่าปัจจุบัน (ให้ฟอร์มที่วาดซ้ำรู้ว่าช่องไหนผู้ใช้แก้)
  }
}

const syntheticProblem = (status, type) => new MdmApiError(status, { type: `https://mdm.lp-pao.go.th/problems/${type}` });

function createPersonProfileRoutes({ mdmClient, emailCheck = {} }) {
  const router = express.Router();
  const guard = [noStore, requireMasterDataAdmin];
  const send = (req, res, status, title, body) => res.status(status).send(layout(title, body, pageOpts(req)));
  const notFound = (req, res) => send(req, res, 404, 'ไม่พบบุคคล', '<p class="error">ไม่พบบุคคลนี้</p>');

  const sendFailure = (req, res, err, { title, reloadUrl, personId }) =>
    send(req, res, statusFor(err), title, renderFailure(err, { reloadUrl, backUrl: personUrl(personId), backLabel: '← กลับไปหน้ารายละเอียด' }));

  const csrfFailure = (req, res, backUrl) =>
    send(req, res, 403, 'คำขอไม่ถูกต้อง', `<p class="error">คำขอไม่ถูกต้องหรือหมดอายุ (CSRF) กรุณากลับไปเปิดหน้านี้ใหม่แล้วลองอีกครั้ง</p><p><a href="${escapeHtml(backUrl)}">← กลับ</a></p>`);

  const formShell = (req, personId, { heading, intro, errors, version, action, fields, submitLabel, reason, formAttrs = '', afterForm = '' }) =>
    `<p><a href="${personUrl(personId)}">← กลับไปหน้ารายละเอียด</a></p>
      <h1>${escapeHtml(heading)}</h1>
      ${intro}
      ${errorList(errors)}
      <form method="post" action="${escapeHtml(action)}" autocomplete="off" ${formAttrs}>
        ${csrfField(req)}
        <input type="hidden" name="expectedVersion" value="${escapeHtml(version)}" />
        ${fields}
        ${reasonField(reason)}
        <p><button type="submit" class="primary">${escapeHtml(submitLabel)}</button> <a href="${personUrl(personId)}">ยกเลิก</a></p>
      </form>
      ${afterForm}`;

  // อ่านโปรไฟล์ -> วาดฟอร์ม; render(profile) คืน { status, title, body }
  async function showForm(req, res, next, { title, render }) {
    const { personId } = req.params;
    if (!UUID_RE.test(personId)) return notFound(req, res);
    try {
      const profile = await mdmClient.getManageProfile(req.hrAuth.accessToken, personId);
      return send(req, res, 200, title, render(profile));
    } catch (err) {
      if (isRemoteFailure(err)) return sendFailure(req, res, err, { title, personId });
      return next(err);
    }
  }

  // ขั้นตอนเขียนที่ใช้ร่วมกัน: CSRF -> expectedVersion -> validate -> (compute) -> API -> redirect
  //  - validate(body) คืน { values, errors, ...ที่ต้องใช้ต่อ }; redisplay(values, errors, version, status) วาดฟอร์มเดิมพร้อมค่าที่พิมพ์
  //  - compute(profile, parsed) คืน { body } = ข้อมูลที่ส่ง API หรือ null ถ้าไม่มีอะไรเปลี่ยน
  async function handleWrite(req, res, next, { title, formPath, validate, compute, call, savedCode }) {
    const { personId } = req.params;
    if (!UUID_RE.test(personId)) return notFound(req, res);
    const formUrl = `${personUrl(personId)}/${formPath}`;
    if (!csrfTokenMatches(req.hrAuth.csrfToken, req.body?._csrf)) return csrfFailure(req, res, formUrl);
    const token = req.hrAuth.accessToken;
    const expectedVersion = parseExpectedVersion(req.body.expectedVersion);
    if (expectedVersion === null) {
      return send(req, res, 422, title, `<p class="error">ข้อมูลฟอร์มไม่ครบ กรุณาเปิดหน้านี้ใหม่</p><p><a class="button" href="${formUrl}">โหลดข้อมูลล่าสุด</a></p>`);
    }
    const reasonCheck = validateWriteReason(req.body.reason);
    const parsed = validate(req.body);
    const redisplay = (errors, status, original) =>
      send(req, res, status, title, parsed.render(req, { personId, version: expectedVersion, values: scrub(parsed.values), ...(original ? { original } : {}), reason: scrub(reasonCheck.reason), errors }));
    const errors = [...parsed.errors, ...reasonCheck.errors];
    if (errors.length > 0) return redisplay(errors, 422);

    try {
      // ตรวจกับข้อมูลปัจจุบันเพื่อส่งเฉพาะฟิลด์ที่เปลี่ยน (API ตัดสิน version-conflict เองเมื่อส่ง; ที่นี่ตรวจก่อนเพื่อไม่คำนวณ diff จากข้อมูลคนละเวอร์ชัน)
      const profile = await mdmClient.getManageProfile(token, personId);
      const blocked = parsed.preflight ? parsed.preflight(profile) : null;
      if (blocked) throw blocked;
      if (profile.version !== expectedVersion) throw syntheticProblem(409, 'version-conflict');
      let payload;
      try {
        payload = compute(profile, parsed);
      } catch (err) {
        // ค่าที่ผู้ใช้แก้ไม่ผ่านกติกาตรวจรูปแบบ (ตรวจกับค่าปัจจุบันจึงทำได้เฉพาะตรงนี้) -> กลับฟอร์มพร้อมข้อความไทย คงค่าที่พิมพ์
        if (err instanceof FormErrors) return redisplay(err.errors, 422, err.original);
        throw err;
      }
      if (!payload) return res.redirect(303, `${personUrl(personId)}?saved=nochange`);

      let result;
      try {
        result = await call(token, personId, { ...payload, reason: reasonCheck.reason, expectedVersion });
      } catch (err) {
        if (!(err instanceof MdmApiError)) throw err;
        // 400/422 ที่ API ตอบ (เช่น ค่าไม่ผ่านกฎของ API) -> กลับฟอร์มพร้อมข้อความไทย คงค่าที่พิมพ์; อื่นๆ -> หน้า error
        if ([400, 422].includes(err.status)) return redisplay([failureMessage(err)], statusFor(err));
        throw err;
      }
      return res.redirect(303, `${personUrl(personId)}?saved=${result?.version === expectedVersion ? 'nochange' : savedCode}`);
    } catch (err) {
      if (isRemoteFailure(err)) return sendFailure(req, res, err, { title, reloadUrl: isVersionConflict(err) ? formUrl : undefined, personId });
      return next(err);
    }
  }

  const bodyParser = express.urlencoded({ extended: false, limit: '32kb' });

  // ------------------------------------------------------------------------------------------------------------------ ข้อมูลติดต่อ

  const contactValuesFrom = (profile) => {
    const c = profile.contact || {};
    return {
      mobilePhone: c.mobilePhone,
      phoneAlt: c.phoneAlt,
      emailPersonal: c.emailPersonal,
      lineId: c.lineId,
    };
  };

  function renderContactForm(req, { personId, version, values, original = values, reason = '', errors = [] }) {
    const field = (f) => {
      const value = escapeHtml(values[f.key] ?? '');
      const attrs = f.rule ? `${ruleAttrs(f.rule, original[f.key] ?? '')} inputmode="${f.rule === 'email' ? 'email' : 'tel'}"` : '';
      const input = `<input id="${f.key}" name="${f.key}" maxlength="${f.max}" value="${value}" ${attrs} />${f.rule ? fieldErrorHtml(f.key) : ''}`;
      const widget = f.rule === 'email' ? emailCheckWidgetHtml() : '';
      return `<label for="${f.key}">${escapeHtml(f.label)}${f.hint ? ` <span class="hint">(${escapeHtml(f.hint)})</span>` : ''}</label>${input}${widget}`;
    };
    const fields = `<h2>ช่องทางติดต่อ</h2>${CONTACT_FIELDS.filter((f) => f.group === 'contact').map(field).join('')}`;
    return formShell(req, personId, {
      heading: 'แก้ข้อมูลติดต่อ',
      intro: '<p>ส่งเฉพาะช่องที่คุณเปลี่ยน <strong>ช่องที่เว้นว่างหมายถึงล้างค่าเดิมทิ้ง</strong> ช่องที่ไม่แตะจะคงเดิม บันทึกการเปลี่ยนแปลงพร้อมชื่อผู้แก้และเหตุผลไว้ในประวัติ</p>',
      errors,
      version,
      action: `${personUrl(personId)}/contact/edit`,
      fields,
      submitLabel: 'บันทึกข้อมูลติดต่อ',
      reason,
      formAttrs: 'data-contact-form',
      afterForm: contactFormScript({ checkUrl: `${personUrl(personId)}/contact/check-email`, csrfToken: req.hrAuth.csrfToken }),
    });
  }

  router.get('/hr/persons/:personId/contact/edit', ...guard, (req, res, next) =>
    showForm(req, res, next, {
      title: 'แก้ข้อมูลติดต่อ',
      render: (profile) =>
        renderContactForm(req, { personId: profile.personId, version: profile.version, values: contactValuesFrom(profile), original: contactValuesFrom(profile) }),
    })
  );

  const validateContact = (body) => {
    const values = Object.fromEntries(CONTACT_FIELDS.map((f) => [f.key, text(body[f.key])]));
    const errors = [];
    for (const f of CONTACT_FIELDS) {
      if (values[f.key].length > f.max) errors.push(`${f.label}ยาวเกิน ${f.max} ตัวอักษร`);
      else if (!f.rule && looksLikePid(values[f.key])) errors.push(`${f.label}ห้ามมีตัวเลข 13 หลักติดกัน (ห้ามใส่เลขบัตรประชาชน)`);
    }
    // รูปแบบอีเมล/เบอร์โทรตรวจใน computeContact (ต้องเทียบกับค่าปัจจุบัน: ค่าเดิมที่ไม่ได้แก้ไม่ถูกบังคับแก้ย้อนหลัง)
    return { values, errors, render: (req2, ctx) => renderContactForm(req2, ctx) };
  };

  // ส่งเฉพาะฟิลด์ที่ต่างจากค่าปัจจุบัน; ช่องว่าง = ล้างค่า (null); เบอร์/อีเมลตรวจรูปแบบเฉพาะที่แก้ (API ตรวจซ้ำและเป็นผู้ตัดสิน)
  const computeContact = (profile, { values }) => {
    const current = contactValuesFrom(profile);
    const body = {};
    const errors = [];
    for (const f of CONTACT_FIELDS) {
      if ((current[f.key] ?? '') === values[f.key]) continue;
      let next = values[f.key] === '' ? null : values[f.key];
      if (f.validate) {
        const result = f.validate(values[f.key]);
        if (!result.ok) {
          errors.push(result.message);
          continue;
        }
        next = result.value;
        if ((current[f.key] ?? null) === next) continue; // normalize แล้วเท่าค่าเดิม
      }
      body[f.key] = next;
    }
    if (errors.length > 0) throw new FormErrors(errors, current);
    return Object.keys(body).length > 0 ? { ...body } : null;
  };

  router.post('/hr/persons/:personId/contact/edit', ...guard, bodyParser, (req, res, next) =>
    handleWrite(req, res, next, {
      title: 'แก้ข้อมูลติดต่อ',
      formPath: 'contact/edit',
      validate: validateContact,
      compute: computeContact,
      call: (token, personId, body) => mdmClient.patchContact(token, personId, body),
      savedCode: 'contact',
    })
  );

  // ปุ่ม "ตรวจสอบอีเมล" ของหน้าแก้ข้อมูลติดต่อ: ต้องล็อกอิน + hr_master_data_admin + CSRF (header) เหมือนหน้าแก้ไข จำกัด 10 ครั้ง/นาทีต่อ session
  // ตอบ JSON ข้อความไทย ผลเป็นข้อมูลประกอบเท่านั้น (ไม่บล็อกการบันทึก) ไม่ log ค่าอีเมล
  const emailLimiter = emailCheck.limiter || createRateLimiter({ max: 10, windowMs: 60 * 1000 });
  const checkEmail = createCheckEmailHandler({
    keyOf: (req) => req.hrAuth.csrfToken, // token ต่อ session (ไม่ใช่ข้อมูลส่วนบุคคล) ใช้เป็นตัวแทน session ในตัวนับ
    limiter: emailLimiter,
    ...(emailCheck.checkDomain ? { checkDomain: emailCheck.checkDomain } : {}),
  });
  router.post(
    '/hr/persons/:personId/contact/check-email',
    noStore,
    express.json({ limit: '2kb' }),
    (req, res, next) => {
      if (!req.hrAuth?.isMasterDataAdmin) return res.status(403).json({ status: 'forbidden', message: 'ไม่มีสิทธิ์ใช้งานส่วนนี้' });
      if (!UUID_RE.test(req.params.personId)) return res.status(404).json({ status: 'not_found', message: 'ไม่พบบุคคล' });
      if (!csrfTokenMatches(req.hrAuth.csrfToken, req.get('x-csrf-token'))) return res.status(403).json({ status: 'forbidden', message: 'คำขอไม่ถูกต้องหรือหมดอายุ กรุณาโหลดหน้านี้ใหม่' });
      return next();
    },
    checkEmail
  );

  // ----------------------------------------------------------------------------------------------------------------- ผู้ติดต่อฉุกเฉิน

  function renderEmergencyForm(req, { personId, version, values, reason = '', errors = [] }) {
    const slots = EMERGENCY_SLOTS.map(
      (slot) => `<fieldset><legend>ผู้ติดต่อฉุกเฉินลำดับที่ ${slot}</legend>
        ${EMERGENCY_FIELDS.map(
          (f) => `<label>${escapeHtml(f.label)}</label><input name="c${slot}_${f.key}" maxlength="${f.max}" value="${escapeHtml(values[slot]?.[f.key] ?? '')}" />`
        ).join('')}
      </fieldset>`
    ).join('');
    return formShell(req, personId, {
      heading: 'แก้ผู้ติดต่อฉุกเฉิน',
      intro: `<p>มีได้สูงสุด 3 ช่อง ช่องที่เว้นว่างทั้งช่องหมายถึงไม่มีผู้ติดต่อในลำดับนั้น (ถ้าเดิมมีจะถูกลบ) ช่องที่กรอกต้องกรอกให้ครบทั้ง 3 ข้อ: ชื่อ-นามสกุล ความสัมพันธ์ และเบอร์โทร
        ประวัติการเปลี่ยนแปลงจะบันทึกว่าช่อง/ข้อมูลใดเปลี่ยน โดยไม่เก็บชื่อหรือเบอร์ของผู้ติดต่อ</p>`,
      errors,
      version,
      action: `${personUrl(personId)}/emergency-contacts/edit`,
      fields: slots,
      submitLabel: 'บันทึกผู้ติดต่อฉุกเฉิน',
      reason,
    });
  }

  const emergencyValuesFrom = (profile) => {
    const values = {};
    for (const c of profile.emergencyContacts || []) if (EMERGENCY_SLOTS.includes(c.priority)) values[c.priority] = c;
    return values;
  };

  router.get('/hr/persons/:personId/emergency-contacts/edit', ...guard, (req, res, next) =>
    showForm(req, res, next, {
      title: 'แก้ผู้ติดต่อฉุกเฉิน',
      render: (profile) => renderEmergencyForm(req, { personId: profile.personId, version: profile.version, values: emergencyValuesFrom(profile) }),
    })
  );

  // แถวที่กรอกไม่ครบ "ต้องปฏิเสธทั้งฟอร์ม" บอกว่าช่องไหนขาดอะไร (ห้ามทิ้งเงียบ - บั๊กเดิมของ portal) แถวว่างทั้งแถวคือไม่มีผู้ติดต่อ
  const validateEmergency = (body) => {
    const values = {};
    const errors = [];
    for (const slot of EMERGENCY_SLOTS) {
      const row = Object.fromEntries(EMERGENCY_FIELDS.map((f) => [f.key, text(body[`c${slot}_${f.key}`])]));
      values[slot] = row;
      const filled = EMERGENCY_FIELDS.filter((f) => row[f.key] !== '');
      if (filled.length === 0) continue;
      const missing = EMERGENCY_FIELDS.filter((f) => row[f.key] === '').map((f) => f.label);
      if (missing.length > 0) errors.push(`ผู้ติดต่อฉุกเฉินลำดับที่ ${slot}: กรอกไม่ครบ ขาด${missing.join(', ')} (ถ้าไม่ต้องการช่องนี้ให้ล้างทุกช่องของลำดับนั้น)`);
      for (const f of EMERGENCY_FIELDS) {
        if (row[f.key].length > f.max) errors.push(`ผู้ติดต่อฉุกเฉินลำดับที่ ${slot}: ${f.label}ยาวเกิน ${f.max} ตัวอักษร`);
        else if (looksLikePid(row[f.key])) errors.push(`ผู้ติดต่อฉุกเฉินลำดับที่ ${slot}: ${f.label}ห้ามมีตัวเลข 13 หลักติดกัน`);
      }
    }
    return { values, errors, render: (req2, ctx) => renderEmergencyForm(req2, ctx) };
  };

  // แทนที่ทั้งรายการเสมอ (ตามสัญญา API) - API ไม่เพิ่ม version เมื่อไม่มีอะไรเปลี่ยน -> ใช้ผลนั้นบอก "ไม่มีการเปลี่ยนแปลง"
  const computeEmergency = (profile, { values }) => ({
    contacts: EMERGENCY_SLOTS.filter((slot) => EMERGENCY_FIELDS.every((f) => values[slot][f.key] !== '')).map((slot) => ({
      fullName: values[slot].fullName,
      relationship: values[slot].relationship,
      phone: values[slot].phone,
      priority: slot,
    })),
  });

  router.post('/hr/persons/:personId/emergency-contacts/edit', ...guard, bodyParser, (req, res, next) =>
    handleWrite(req, res, next, {
      title: 'แก้ผู้ติดต่อฉุกเฉิน',
      formPath: 'emergency-contacts/edit',
      validate: validateEmergency,
      compute: computeEmergency,
      call: (token, personId, body) => mdmClient.replaceEmergencyContacts(token, personId, body),
      savedCode: 'emergency',
    })
  );

  // ------------------------------------------------------------------------------------------------- ชื่อ-นามสกุลไทย/วันเกิด (HR กรอก)

  const IDENTITY_NOTE = `<p class="hint"><strong>ข้อมูลที่ HR กรอก รอยืนยัน ThaID</strong> - ไม่ใช่ข้อมูลจาก ThaID เมื่อบุคคลนี้เข้าสู่ระบบด้วย ThaID ครั้งแรก ระบบจะใช้ข้อมูลจาก ThaID เป็นหลักเสมอ และแก้ไขที่นี่ไม่ได้อีก</p>`;

  function renderIdentityForm(req, { personId, version, values, reason = '', errors = [] }) {
    const fields = `<div class="row">
        <div><label>ชื่อ (ไทย)</label><input name="firstNameTh" maxlength="${NAME_MAX}" value="${escapeHtml(values.firstNameTh)}" required /></div>
        <div><label>นามสกุล (ไทย)</label><input name="lastNameTh" maxlength="${NAME_MAX}" value="${escapeHtml(values.lastNameTh)}" required /></div>
      </div>
      <label>วันเกิด <span class="hint">(ไม่บังคับ เว้นว่าง = ล้างค่า)</span></label>
      ${renderDateInput({ name: 'birthDate', value: values.birthDate || '', min: MIN_BIRTH_DATE, max: todayBangkok() })}`;
    return formShell(req, personId, {
      heading: 'แก้ชื่อ-นามสกุลและวันเกิด (ที่ HR กรอก)',
      intro: IDENTITY_NOTE,
      errors,
      version,
      action: `${personUrl(personId)}/expected-identity/edit`,
      fields,
      submitLabel: 'บันทึก',
      reason,
    });
  }

  function renderIdentityLocked(personId, identity) {
    const shown = [
      ['ชื่อ (ไทย)', identity.firstNameTh],
      ['นามสกุล (ไทย)', identity.lastNameTh],
      ['วันเกิด', formatThaiDate(identity.birthDate)],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
      .join('');
    return `<p><a href="${personUrl(personId)}">← กลับไปหน้ารายละเอียด</a></p>
      <h1>แก้ชื่อ-นามสกุลและวันเกิด (ที่ HR กรอก)</h1>
      <p class="error"><strong>แก้ไม่ได้:</strong> ${escapeHtml(LOCKED_MESSAGES[identity.lockedReason] || 'ไม่อนุญาตให้แก้ข้อมูลระบุตัวตนของบุคคลนี้')}</p>
      ${shown ? `<p class="hint">ค่าที่ HR เคยกรอกไว้ (ไม่ใช่ค่าจาก ThaID):</p><dl class="kv">${shown}</dl>` : ''}`;
  }

  router.get('/hr/persons/:personId/expected-identity/edit', ...guard, (req, res, next) =>
    showForm(req, res, next, {
      title: 'แก้ชื่อ-วันเกิด',
      render: (profile) => {
        const identity = profile.expectedIdentity || {};
        if (!identity.editable) return renderIdentityLocked(profile.personId, identity);
        return renderIdentityForm(req, {
          personId: profile.personId,
          version: profile.version,
          values: { firstNameTh: identity.firstNameTh, lastNameTh: identity.lastNameTh, birthDate: identity.birthDate },
        });
      },
    })
  );

  const validateIdentity = (body) => {
    const values = { firstNameTh: text(body.firstNameTh), lastNameTh: text(body.lastNameTh), birthDate: text(body.birthDate) };
    const errors = [];
    for (const [key, label] of [['firstNameTh', 'ชื่อ'], ['lastNameTh', 'นามสกุล']]) {
      if (!values[key]) errors.push(`กรุณากรอก${label}`);
      else if (values[key].length > NAME_MAX) errors.push(`${label}ยาวเกิน ${NAME_MAX} ตัวอักษร`);
      else if (looksLikePid(values[key])) errors.push(`${label}ห้ามมีเลขบัตรประชาชน`);
    }
    if (values.birthDate) {
      if (!isRealDate(values.birthDate)) errors.push('วันเกิดไม่ถูกต้อง');
      else if (values.birthDate < MIN_BIRTH_DATE || values.birthDate > todayBangkok()) errors.push(`วันเกิดต้องอยู่ระหว่าง ${formatThaiDate(MIN_BIRTH_DATE)} ถึงวันนี้`);
    }
    return {
      values,
      errors,
      render: (req2, ctx) => renderIdentityForm(req2, ctx),
      // คนที่ยืนยันแล้ว: รายงาน identity-locked ก่อน version-conflict (เหมือนลำดับของ API)
      preflight: (profile) => (profile.expectedIdentity?.editable ? null : syntheticProblem(409, 'identity-locked')),
    };
  };

  const computeIdentity = (profile, { values }) => {
    const current = profile.expectedIdentity || {};
    const body = {};
    if ((current.firstNameTh ?? '') !== values.firstNameTh) body.firstNameTh = values.firstNameTh;
    if ((current.lastNameTh ?? '') !== values.lastNameTh) body.lastNameTh = values.lastNameTh;
    if ((current.birthDate ?? '') !== values.birthDate) body.birthDate = values.birthDate === '' ? null : values.birthDate;
    return Object.keys(body).length > 0 ? body : null;
  };

  router.post('/hr/persons/:personId/expected-identity/edit', ...guard, bodyParser, (req, res, next) =>
    handleWrite(req, res, next, {
      title: 'แก้ชื่อ-วันเกิด',
      formPath: 'expected-identity/edit',
      validate: validateIdentity,
      compute: computeIdentity,
      call: (token, personId, body) => mdmClient.patchExpectedIdentity(token, personId, body),
      savedCode: 'identity',
    })
  );

  return router;
}

module.exports = { createPersonProfileRoutes, CONTACT_FIELDS };
