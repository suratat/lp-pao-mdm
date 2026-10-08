const { escapeHtml } = require('./views/html');
const { PERSONNEL_TYPES, positionRuleFor } = require('./personnelTypes');
const { MAX_LENGTH: JOB_TITLE_MAX_LENGTH, checkJobTitleText } = require('./jobTitleText');
const { UUID_RE } = require('./masterData');

// ส่วนฟอร์ม "ข้อมูลการจ้าง" ที่ใช้ร่วมกัน: อนุมัติ claim, เพิ่มบุคคลใหม่, ย้ายหน่วยงาน/ตำแหน่ง/ประเภท, คืนสภาพ (ย้ายมาจาก claimRequestRoutes.js
// ไม่เปลี่ยนพฤติกรรม - เพิ่มแค่พารามิเตอร์ selected สำหรับเติมค่าเดิมลงฟอร์มแก้ไข)
const naturalCompare = (a, b) => String(a).localeCompare(String(b), 'th', { numeric: true });

function personnelTypeOptions(selected) {
  return PERSONNEL_TYPES.map((t) => `<option value="${escapeHtml(t.value)}"${t.value === selected ? ' selected' : ''}>${escapeHtml(t.label)}</option>`).join('\n');
}

function positionRules() {
  return Object.fromEntries(PERSONNEL_TYPES.map((t) => [t.value, t.positionRule]));
}

// dropdown หน่วยงาน "รหัส — ชื่อ" (เฉพาะที่ active) ค่าที่ส่งคือ orgUnitId
function orgUnitOptions(orgUnits, selected) {
  return [...orgUnits]
    .filter((o) => o.isActive)
    .sort((a, b) => naturalCompare(a.code, b.code))
    .map((o) => `<option value="${escapeHtml(o.orgUnitId)}"${o.orgUnitId === selected ? ' selected' : ''}>${escapeHtml(o.code)} — ${escapeHtml(o.nameTh)}</option>`)
    .join('\n');
}

// dropdown ตำแหน่ง "เลขที่ตำแหน่ง — ชื่อตำแหน่ง · ประเภทตำแหน่ง (ชื่อไทย)" (เฉพาะที่ active) ไม่แสดงระดับ/สายงาน
// (ระดับเป็นของ employment.level_code, สายงานเราไม่เก็บ) ทุก option พก data-org-unit ไว้ให้สคริปต์กรองตามหน่วยงานที่เลือก
function positionOptions(positions, positionTypes, selected) {
  const typeName = new Map(positionTypes.map((t) => [t.code, t.nameTh]));
  return [...positions]
    .filter((p) => p.isActive)
    .sort((a, b) => naturalCompare(a.positionNo, b.positionNo))
    .map(
      (p) =>
        `<option value="${escapeHtml(p.positionId)}"${p.positionId === selected ? ' selected' : ''} data-org-unit="${escapeHtml(p.orgUnitId)}">${escapeHtml(p.positionNo)} — ${escapeHtml(p.titleTh)} · ${escapeHtml(typeName.get(p.positionType) || p.positionType)}</option>`
    )
    .join('\n');
}

// lock ช่องตำแหน่ง/ชื่อตำแหน่ง-ลักษณะงานตามประเภทบุคลากร + กรองตำแหน่งตามหน่วยงาน (ฝั่ง client เพื่อ UX เท่านั้น - server ของ console และ
// MDM API ตรวจซ้ำเสมอ):
//   FORBIDDEN -> ตำแหน่ง: ล้างค่า+disable | ชื่อตำแหน่ง/ลักษณะงาน: enable (ไม่บังคับ)
//   REQUIRED  -> ตำแหน่ง: enable+required | ชื่อตำแหน่ง/ลักษณะงาน: ซ่อน+disable+ล้างค่า
//   OPTIONAL (OTHER) -> เลือกได้อย่างใดอย่างหนึ่ง: เลือกตำแหน่งแล้ว = ปิดช่องข้อความ, กรอกข้อความแล้ว = ปิดช่องตำแหน่ง (ปิดแล้วค่าว่างเสมอ)
//     ผู้ใช้เปลี่ยนใจได้โดยล้างช่องที่กรอกไว้ (เลือกตำแหน่งกลับเป็น "— เลือกตำแหน่ง —" หรือลบข้อความ) อีกช่องจะเปิดกลับเอง
//     ถ้าเบราว์เซอร์คืนค่าฟอร์มมาทั้งสองช่อง (ไม่ควรเกิด) ตำแหน่งชนะและข้อความถูกล้าง
//   (ยังไม่เลือกหน่วยงาน = ช่องตำแหน่งถูก disable เพราะยังไม่มีรายการให้เลือก)
// refresh() รันตอนโหลดหน้า (select มีค่าเริ่มต้นอยู่แล้ว) + ทุกครั้งที่เปลี่ยนประเภทหรือหน่วยงาน + ตอน pageshow (เบราว์เซอร์คืนค่าฟอร์มเดิมเมื่อ
// กด Back/bfcache โดยไม่ยิง change event - ถ้าไม่ apply ซ้ำ ช่องอาจค้างสถานะไม่ตรงกับประเภท/หน่วยงานที่เลือก) ส่วนการเลือกตำแหน่ง/พิมพ์ข้อความ
// เรียกเฉพาะ applyState() (ไม่สร้างรายการตำแหน่งใหม่ทุกตัวอักษร)
const POSITION_LOCK_SCRIPT = `<script>
(function () {
  var typeSelect = document.getElementById('personnelType');
  var orgSelect = document.getElementById('orgUnitId');
  var posSelect = document.getElementById('positionId');
  var hint = document.getElementById('positionHint');
  var jobInput = document.getElementById('jobTitleText');
  var jobRow = document.getElementById('jobTitleRow');
  var jobHint = document.getElementById('jobTitleHint');
  var rules = JSON.parse(typeSelect.getAttribute('data-position-rules'));
  var HINTS = { REQUIRED: '(จำเป็นต้องระบุ)', FORBIDDEN: '(ประเภทนี้ไม่มีตำแหน่ง - ช่องถูกปิด)', OPTIONAL: '(ไม่บังคับ - เลือกตำแหน่งหรือกรอกชื่อตำแหน่ง/ลักษณะงานอย่างใดอย่างหนึ่ง)' };
  var JOB_HINTS = { FORBIDDEN: '(ไม่บังคับ)', OPTIONAL: '(ไม่บังคับ - กรอกแล้วช่องตำแหน่งจะถูกปิด)' };
  var all = Array.prototype.slice.call(posSelect.options);
  var placeholder = all.shift();

  function filterPositions() {
    var orgId = orgSelect.value;
    var keep = posSelect.value;
    var visible = all.filter(function (o) { return orgId && o.getAttribute('data-org-unit') === orgId; });
    while (posSelect.firstChild) posSelect.removeChild(posSelect.firstChild);
    posSelect.appendChild(placeholder);
    visible.forEach(function (o) { posSelect.appendChild(o); });
    placeholder.textContent = !orgId ? '— เลือกหน่วยงานก่อน —' : visible.length === 0 ? '— หน่วยงานนี้ไม่มีตำแหน่งที่ใช้งานอยู่ —' : '— เลือกตำแหน่ง —';
    posSelect.value = visible.some(function (o) { return o.value === keep; }) ? keep : '';
  }

  function applyState() {
    var rule = rules[typeSelect.value] || 'OPTIONAL';
    var posOff = rule === 'FORBIDDEN';
    var jobOff = rule === 'REQUIRED';
    var why = '';
    if (rule === 'OPTIONAL') {
      if (posSelect.value !== '') { jobOff = true; why = '(ปิดเพราะเลือกตำแหน่งแล้ว - เลือก "— เลือกตำแหน่ง —" กลับเพื่อกรอกข้อความแทน)'; }
      else if (jobInput.value.trim() !== '') { posOff = true; why = '(ปิดเพราะกรอกชื่อตำแหน่ง/ลักษณะงานแล้ว - ลบข้อความเพื่อเลือกตำแหน่งแทน)'; }
    }
    if (posOff) posSelect.value = '';
    if (jobOff) jobInput.value = '';
    posSelect.disabled = posOff || !orgSelect.value;
    posSelect.required = rule === 'REQUIRED';
    jobInput.disabled = jobOff;
    jobRow.hidden = rule === 'REQUIRED';
    hint.textContent = rule === 'OPTIONAL' && posOff ? why : HINTS[rule];
    jobHint.textContent = rule === 'OPTIONAL' && jobOff ? why : (JOB_HINTS[rule] || '');
  }

  function refresh() { filterPositions(); applyState(); }

  typeSelect.addEventListener('change', refresh);
  orgSelect.addEventListener('change', refresh);
  posSelect.addEventListener('change', applyState);
  jobInput.addEventListener('input', applyState);
  window.addEventListener('pageshow', refresh);
  refresh();
})();
</script>`;

const LIMITS = { levelCode: 50, emailWork: 255, referenceDocument: 200 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(text) {
  if (!DATE_RE.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

// วันนี้ตามเวลาไทย (YYYY-MM-DD) - ค่าเริ่มต้นของ "วันที่มีผล"
function todayBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

// ช่องกรอกข้อมูลการจ้างทั้งชุด (ไม่รวม employeeNo/เหตุผล/CSRF ซึ่งเป็นของแต่ละฟอร์ม) values = ค่าที่จะเติมลงฟอร์ม (ค่าเดิม หรือค่าที่ผู้ใช้เพิ่งกรอก)
function renderEmploymentFields({ values = {}, orgUnits, positions, positionTypes }) {
  return `<label>ประเภทบุคลากร</label>
    <select name="personnelType" id="personnelType" required data-position-rules="${escapeHtml(JSON.stringify(positionRules()))}">${personnelTypeOptions(values.personnelType)}</select>
    <label>หน่วยงาน</label>
    <select name="orgUnitId" id="orgUnitId" required>
      <option value="">— เลือกหน่วยงาน —</option>
      ${orgUnitOptions(orgUnits, values.orgUnitId)}
    </select>
    <label>ตำแหน่ง <span class="hint" id="positionHint"></span></label>
    <select name="positionId" id="positionId">
      <option value="">— เลือกตำแหน่ง —</option>
      ${positionOptions(positions, positionTypes, values.positionId)}
    </select>
    <div id="jobTitleRow">
      <label>ชื่อตำแหน่ง/ลักษณะงาน <span class="hint" id="jobTitleHint"></span></label>
      <input name="jobTitleText" id="jobTitleText" maxlength="${JOB_TITLE_MAX_LENGTH}" autocomplete="off" value="${escapeHtml(values.jobTitleText)}" placeholder="เช่น พนักงานขับรถยนต์ หรือ ผู้ช่วยช่างไฟฟ้า" />
    </div>
    <label>วันที่มีผล (effectiveFrom)</label>
    <input name="effectiveFrom" type="date" required value="${escapeHtml(values.effectiveFrom || '')}" />
    <label>วันบรรจุ (appointedDate)</label>
    <input name="appointedDate" type="date" value="${escapeHtml(values.appointedDate || '')}" />
    <label>ระดับ/ชั้น (levelCode)</label>
    <input name="levelCode" maxlength="${LIMITS.levelCode}" value="${escapeHtml(values.levelCode)}" />
    <label>อีเมลที่ทำงาน</label>
    <input name="emailWork" type="email" maxlength="${LIMITS.emailWork}" value="${escapeHtml(values.emailWork)}" />
    <label>เลขที่คำสั่ง (referenceDocument)</label>
    <input name="referenceDocument" maxlength="${LIMITS.referenceDocument}" value="${escapeHtml(values.referenceDocument)}" />`;
}

// อ่านค่าฟอร์มข้อมูลการจ้าง + ตรวจซ้ำที่ server ของ console (ช่องที่ disable/กรองฝั่ง client แก้ผ่าน devtools/curl ได้ - MDM API ตรวจอีกชั้นเสมอ)
// คืน { errors, values } : values เป็นค่าที่ผู้ใช้กรอก (ใช้เติมกลับฟอร์มเมื่อไม่ผ่าน) และ employment เป็น payload ส่ง API (undefined ถ้ามี errors)
async function validateEmploymentInput({ body, mdmClient, token }) {
  const errors = [];
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const values = {
    personnelType: text(body.personnelType),
    orgUnitId: text(body.orgUnitId),
    positionId: text(body.positionId),
    effectiveFrom: text(body.effectiveFrom),
    appointedDate: text(body.appointedDate),
    levelCode: text(body.levelCode),
    emailWork: text(body.emailWork),
    referenceDocument: text(body.referenceDocument),
  };

  if (!PERSONNEL_TYPES.some((t) => t.value === values.personnelType)) errors.push('กรุณาเลือกประเภทบุคลากร');
  const rule = positionRuleFor(values.personnelType);
  if (rule === 'FORBIDDEN' && values.positionId) errors.push('ประเภทบุคลากรนี้ไม่มีเลขที่ตำแหน่ง ห้ามระบุเลขที่ตำแหน่ง');
  if (rule === 'REQUIRED' && !values.positionId) errors.push('ประเภทบุคลากรนี้ต้องระบุเลขที่ตำแหน่ง');

  if (!values.orgUnitId) {
    errors.push('กรุณาเลือกหน่วยงาน');
  } else if (!UUID_RE.test(values.orgUnitId)) {
    errors.push('หน่วยงานที่เลือกไม่ถูกต้อง');
  } else {
    const orgUnits = await mdmClient.listOrgUnits(token, { activeOnly: true });
    if (!orgUnits.some((o) => o.orgUnitId === values.orgUnitId && o.isActive)) errors.push('ไม่พบหน่วยงานที่เลือก หรือหน่วยงานถูกปิดใช้งานแล้ว');
  }

  if (values.positionId && rule !== 'FORBIDDEN') {
    if (!UUID_RE.test(values.positionId)) {
      errors.push('ตำแหน่งที่เลือกไม่ถูกต้อง');
    } else {
      const positions = await mdmClient.listPositions(token, { activeOnly: true });
      const found = positions.find((p) => p.positionId === values.positionId && p.isActive);
      if (!found) errors.push('ไม่พบตำแหน่งที่เลือก หรือตำแหน่งถูกปิดใช้งานแล้ว');
      else if (found.orgUnitId !== values.orgUnitId) errors.push('ตำแหน่งที่เลือกไม่อยู่ในหน่วยงานที่เลือก');
    }
  }

  const jobTitle = checkJobTitleText(body.jobTitleText);
  if (jobTitle.error) errors.push(jobTitle.error);
  values.jobTitleText = jobTitle.text || '';
  if (jobTitle.text) {
    if (rule === 'REQUIRED') errors.push('ประเภทบุคลากรนี้ต้องใช้เลขที่ตำแหน่ง ห้ามระบุชื่อตำแหน่ง/ลักษณะงานแบบข้อความ');
    else if (rule === 'OPTIONAL' && values.positionId) errors.push('ประเภทนี้เลือกได้อย่างใดอย่างหนึ่งระหว่างตำแหน่งกับชื่อตำแหน่ง/ลักษณะงาน ห้ามระบุทั้งสองอย่าง');
  }

  if (!isRealDate(values.effectiveFrom)) errors.push('กรุณาระบุวันที่มีผลให้ถูกต้อง');
  if (values.appointedDate && !isRealDate(values.appointedDate)) errors.push('วันบรรจุไม่ถูกต้อง');
  if (values.levelCode.length > LIMITS.levelCode) errors.push(`ระดับ/ชั้นยาวเกิน ${LIMITS.levelCode} ตัวอักษร`);
  if (values.emailWork.length > LIMITS.emailWork) errors.push(`อีเมลที่ทำงานยาวเกิน ${LIMITS.emailWork} ตัวอักษร`);
  if (values.emailWork && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.emailWork)) errors.push('รูปแบบอีเมลที่ทำงานไม่ถูกต้อง');
  if (values.referenceDocument.length > LIMITS.referenceDocument) errors.push(`เลขที่คำสั่งยาวเกิน ${LIMITS.referenceDocument} ตัวอักษร`);

  if (errors.length > 0) return { errors, values };
  return {
    errors,
    values,
    employment: {
      personnelType: values.personnelType,
      orgUnitId: values.orgUnitId,
      positionId: values.positionId || undefined,
      jobTitleText: values.jobTitleText || undefined,
      effectiveFrom: values.effectiveFrom,
      appointedDate: values.appointedDate || undefined,
      levelCode: values.levelCode || undefined,
      emailWork: values.emailWork || undefined,
      referenceDocument: values.referenceDocument || undefined,
    },
  };
}

module.exports = {
  naturalCompare,
  personnelTypeOptions,
  positionRules,
  orgUnitOptions,
  positionOptions,
  POSITION_LOCK_SCRIPT,
  renderEmploymentFields,
  validateEmploymentInput,
  todayBangkok,
  isRealDate,
  LIMITS,
};
