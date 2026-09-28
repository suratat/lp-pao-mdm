const vm = require('node:vm');

// รัน "สคริปต์ inline จริง" จากหน้า approve ที่ render แล้วใน sandbox ด้วย DOM จำลองแบบเรียบง่าย (ไม่มี jsdom ในรายการ dependency)
// จำลองเฉพาะสิ่งที่สคริปต์ใช้: select + option (appendChild/removeChild/options/firstChild), addEventListener, getAttribute
const unescapeHtml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function makeEl(attrs = {}) {
  const handlers = {};
  return {
    attrs,
    handlers,
    value: '',
    disabled: false,
    required: false,
    textContent: '',
    children: [],
    get options() { return this.children; },
    get firstChild() { return this.children[0] || null; },
    getAttribute(name) { return this.attrs[name] ?? null; },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    fire(type) { (handlers[type] || []).forEach((fn) => fn()); },
    appendChild(child) {
      this.children = this.children.filter((c) => c !== child);
      this.children.push(child);
    },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
  };
}

function parseOptions(selectHtml) {
  return [...selectHtml.matchAll(/<option value="([^"]*)"(?: data-org-unit="([^"]*)")?>([\s\S]*?)<\/option>/g)].map((m) => {
    const el = makeEl(m[2] ? { 'data-org-unit': m[2] } : {});
    el.value = unescapeHtml(m[1]);
    el.textContent = unescapeHtml(m[3]).trim();
    return el;
  });
}

const selectHtmlOf = (html, name) => html.match(new RegExp(`<select name="${name}"[^>]*>([\\s\\S]*?)</select>`))[1];

function loadApproveForm(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const typeSelect = makeEl({ 'data-position-rules': unescapeHtml(html.match(/data-position-rules="([^"]*)"/)[1]) });
  typeSelect.value = 'CIVIL_SERVANT'; // ค่าเริ่มต้นของ dropdown = ตัวแรก (ข้าราชการ)
  const orgSelect = makeEl();
  orgSelect.children = parseOptions(selectHtmlOf(html, 'orgUnitId'));
  const posSelect = makeEl();
  posSelect.children = parseOptions(selectHtmlOf(html, 'positionId'));
  const hint = makeEl();
  const win = makeEl();
  const doc = { getElementById: (id) => ({ personnelType: typeSelect, orgUnitId: orgSelect, positionId: posSelect, positionHint: hint })[id] };
  vm.runInNewContext(script, { document: doc, window: win, JSON, Array });
  return {
    typeSelect,
    orgSelect,
    posSelect,
    hint,
    win,
    // ตัวเลือกตำแหน่งที่ผู้ใช้เห็นอยู่ตอนนี้ (ไม่รวม placeholder)
    visiblePositions: () => posSelect.children.filter((o) => o.value !== '').map((o) => o.value),
    placeholderText: () => posSelect.children[0].textContent,
    chooseOrg(id) { orgSelect.value = id; orgSelect.fire('change'); },
    chooseType(type) { typeSelect.value = type; typeSelect.fire('change'); },
  };
}

module.exports = { loadApproveForm, selectHtmlOf, parseOptions };
