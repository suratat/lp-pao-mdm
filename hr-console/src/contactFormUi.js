// ส่วนหน้าเว็บของฟอร์มแก้ไขข้อมูลติดต่อ (ช่องอีเมลพร้อมปุ่ม "ตรวจสอบอีเมล" และสคริปต์ตรวจรูปแบบฝั่ง browser)
// ไฟล์นี้มีสำเนา "ที่ต้องเหมือนกันทุกตัว" ใน portal/src และ hr-console/src (Dockerfile COPY เฉพาะโฟลเดอร์ตัวเอง) มีเทสต์เทียบเนื้อไฟล์
// ถ้า JavaScript ปิด: ฟอร์มยังบันทึกได้ (เซิร์ฟเวอร์และ API ตรวจซ้ำ) และปุ่มตรวจสอบอีเมลจะไม่แสดง
const fs = require('node:fs');
const path = require('node:path');

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// attribute ของ <input> ที่ให้สคริปต์ตรวจ: rule = 'email' | 'mobile' | 'phoneAlt'; original = ค่าที่เก็บไว้ตอนเปิดฟอร์ม
// (ตรวจเฉพาะเมื่อผู้ใช้แก้ค่า - ค่าเดิมที่ไม่ผ่านกติกาใหม่ไม่ถูกบังคับแก้)
function ruleAttrs(rule, original) {
  return `data-rule="${escapeAttr(rule)}" data-original="${escapeAttr(original)}"`;
}

function fieldErrorHtml(name) {
  return `<span class="field-error error" data-for="${escapeAttr(name)}" role="alert"></span>`;
}

// ปุ่ม + พื้นที่แสดงผล วางต่อท้ายช่องอีเมล (ซ่อนไว้จนกว่าสคริปต์ทำงาน)
function emailCheckWidgetHtml() {
  return `<p class="email-check" data-email-check-box hidden><button type="button" data-email-check>ตรวจสอบอีเมล</button> <span data-email-check-result role="status" aria-live="polite"></span></p>`;
}

const jsString = (value) => JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c');

// สคริปต์ inline ของหน้า: ฝังกติกาจาก contactValidation.js (ตัวเดียวกับที่เซิร์ฟเวอร์ใช้) เพื่อให้ browser ตรวจเหมือนกัน
function contactFormScript({ checkUrl, csrfToken = '' }) {
  const rules = fs.readFileSync(path.join(__dirname, 'contactValidation.js'), 'utf8');
  return `<script>
(function () {
  var module = { exports: {} };
  ${rules}
  var R = module.exports;
  var form = document.querySelector('form[data-contact-form]');
  if (!form) return;
  var CHECK_URL = ${jsString(checkUrl)};
  var CSRF = ${jsString(csrfToken)};
  var RULES = { email: R.validateEmail, mobile: R.validateMobile, phoneAlt: R.validatePhoneAlt };
  var inputs = Array.prototype.slice.call(form.querySelectorAll('input[data-rule]'));

  function errorEl(input) {
    return form.querySelector('.field-error[data-for="' + input.name + '"]');
  }
  function show(input, message) {
    var el = errorEl(input);
    if (el) el.textContent = message || '';
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }
  function check(input) {
    var rule = RULES[input.getAttribute('data-rule')];
    var message = '';
    if (rule && input.value !== (input.getAttribute('data-original') || '')) {
      var result = rule(input.value);
      if (!result.ok) message = result.message;
    }
    show(input, message);
    return message === '';
  }

  inputs.forEach(function (input) {
    input.addEventListener('blur', function () { check(input); });
  });
  form.addEventListener('submit', function (event) {
    var firstBad = null;
    inputs.forEach(function (input) {
      if (!check(input) && !firstBad) firstBad = input;
    });
    if (firstBad) {
      event.preventDefault();
      firstBad.focus();
    }
  });

  var box = form.querySelector('[data-email-check-box]');
  var button = form.querySelector('[data-email-check]');
  var out = form.querySelector('[data-email-check-result]');
  var emailInput = form.querySelector('input[data-rule="email"]');
  if (box && button && out && emailInput && window.fetch) {
    box.hidden = false;
    var say = function (message, ok) {
      out.textContent = message;
      out.className = ok ? 'ok' : 'error';
    };
    emailInput.addEventListener('input', function () { out.textContent = ''; });
    button.addEventListener('click', function () {
      var parsed = R.validateEmail(emailInput.value);
      if (!parsed.ok) return say(parsed.message, false);
      if (parsed.value === null) return say('กรุณากรอกอีเมลก่อนตรวจสอบ', false);
      button.disabled = true;
      say('กำลังตรวจสอบ...', true);
      var headers = { 'Content-Type': 'application/json' };
      if (CSRF) headers['X-CSRF-Token'] = CSRF;
      fetch(CHECK_URL, { method: 'POST', credentials: 'same-origin', headers: headers, body: JSON.stringify({ email: parsed.value }) })
        .then(function (res) { return res.json(); })
        .then(function (data) { say(data && data.message ? data.message : 'ตรวจสอบไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง', !!data && data.status === 'ok'); })
        .catch(function () { say('ตรวจสอบไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง', false); })
        .then(function () { button.disabled = false; });
    });
  }
})();
</script>`;
}

module.exports = { ruleAttrs, fieldErrorHtml, emailCheckWidgetHtml, contactFormScript, escapeAttr };
