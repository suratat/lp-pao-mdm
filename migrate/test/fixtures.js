const path = require('node:path');
const crypto = require('node:crypto');
const { makeFakePid } = require(path.join(__dirname, '..', '..', 'api', 'src', 'security', 'pid'));
const defaultColumnMap = require('../config/column-map.json');

const FIXTURE_ORG_UNIT_CODE = 'PERSONNEL-ADMIN'; // seed T1 (1700000000018): org_unit_id ...003

// POS-0002 (seed T1) ถูกจองโดย api/test/fixtures.js#insertFixturePerson (FIXTURE_PERSON_ID) อยู่แล้ว -
// เทสที่ผ่าน APPLY จริง (สร้าง mdm.employment) ต้องสร้างตำแหน่งใหม่ของตัวเอง ไม่ชนกับ EXCLUDE constraint
// "ตำแหน่งหนึ่งมีผู้ครองได้หนึ่งคนในช่วงเวลาหนึ่ง" (§1.6) - ดู api/test/employmentImport.test.js#makePosition
async function makePosition(adminPool, orgUnitId) {
  const positionNo = `POS-MIGRATE-${crypto.randomUUID()}`;
  await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบ migrate', 'GENERAL', $2)`,
    [positionNo, orgUnitId]
  );
  return positionNo;
}

// เขียน CSV เองแบบง่าย (เฉพาะ test fixture ไม่ใช่ runtime - ไม่นับเป็น dependency ใหม่) ตามลำดับ
// หัวคอลัมน์ของ columnMap.columns
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function buildCsv(logicalRows, columnMap = defaultColumnMap) {
  const fields = Object.keys(columnMap.columns);
  const headers = fields.map((f) => columnMap.columns[f]);
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of logicalRows) {
    lines.push(fields.map((f) => csvEscape(row[f])).join(','));
  }
  return lines.join('\n');
}

// ค่าเริ่มต้นของแถวที่ผ่านทุกกฎคุณภาพ - ใช้รหัสสังกัด/ตำแหน่งที่ seed ไว้แล้วใน T1 (1700000000018)
function validRow(overrides = {}) {
  return {
    pid: makeFakePid(),
    expectedFirstNameTh: 'ทดสอบ',
    expectedLastNameTh: 'นำเข้า',
    employeeNo: `EMP-MIGRATE-${Math.random().toString(36).slice(2, 10)}`,
    personnelTypeRaw: 'ข้าราชการ อบจ.',
    positionNo: 'POS-0002',
    orgUnitCode: 'PERSONNEL-ADMIN',
    levelCode: 'ชำนาญการ',
    appointedDateRaw: '01/10/2560',
    effectiveFromRaw: '01/10/2560',
    employmentStatusRaw: 'ปฏิบัติงาน',
    emailWork: 'test@lp-pao.go.th',
    externalValue: 'LHR-0001',
    ...overrides,
  };
}

module.exports = { buildCsv, validRow, defaultColumnMap, makePosition, FIXTURE_ORG_UNIT_CODE };
