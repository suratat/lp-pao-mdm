const path = require('node:path');
const crypto = require('node:crypto');
const { makeFakePid } = require(path.join(__dirname, '..', '..', 'api', 'src', 'security', 'pid'));
const defaultColumnMap = require('../config/column-map.json');

// org_unit/position ของ fixture นี้สร้างสดใหม่ทุกครั้ง (ไม่พึ่ง org_unit/position ที่ seed จริงจาก
// migration) เพื่อไม่ให้ test พังเมื่อโครงสร้างส่วนราชการจริงเปลี่ยนแปลง - ดู makeOrgUnit ด้านล่าง
async function makeOrgUnit(adminPool, overrides = {}) {
  const code = overrides.code || `TEST-ORG-${crypto.randomUUID()}`;
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.org_unit (code, name_th, unit_level)
     VALUES ($1, $2, 'DIVISION') RETURNING org_unit_id`,
    [code, overrides.nameTh || 'หน่วยงานทดสอบ migrate']
  );
  return { orgUnitId: rows[0].org_unit_id, code };
}

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

// ค่าเริ่มต้นของแถวที่ผ่านทุกกฎคุณภาพ - "positionNo"/"orgUnitCode" ไม่มี default อีกต่อไป (เดิมอ้าง
// รหัสสังกัด/ตำแหน่งที่ seed ไว้ใน T1 1700000000018 ซึ่งถูกแทนที่ด้วยโครงสร้างจริงแล้ว) ผู้เรียกต้องสร้าง
// org_unit/position ของตัวเองก่อนผ่าน makeOrgUnit/makePosition แล้วส่งเข้ามาเสมอ เพื่อไม่ให้ผลลัพธ์ของ
// กฎคุณภาพขึ้นกับข้อมูลที่ seed จาก migration ใด ๆ
function validRow(overrides = {}) {
  if (overrides.positionNo === undefined || overrides.orgUnitCode === undefined) {
    throw new Error('validRow() ต้องระบุ positionNo และ orgUnitCode เสมอ (ไม่มี default จาก seed อีกต่อไป)');
  }
  return {
    pid: makeFakePid(),
    expectedFirstNameTh: 'ทดสอบ',
    expectedLastNameTh: 'นำเข้า',
    personnelTypeRaw: 'ข้าราชการ อบจ.',
    levelCode: 'ชำนาญการ',
    appointedDateRaw: '01/10/2560',
    effectiveFromRaw: '01/10/2560',
    employmentStatusRaw: 'ปฏิบัติงาน',
    emailWork: 'test@lp-pao.go.th',
    externalValue: 'LHR-0001',
    ...overrides,
  };
}

module.exports = { buildCsv, validRow, defaultColumnMap, makeOrgUnit, makePosition };
