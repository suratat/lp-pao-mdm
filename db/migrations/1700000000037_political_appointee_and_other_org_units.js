/* eslint-disable camelcase */

exports.shorthands = undefined;

// พบระหว่าง seed ตำแหน่งจริงต่อจาก 1700000000034: คณะผู้บริหาร (นายก อบจ., รองนายก, เลขานุการนายก,
// ที่ปรึกษานายก, ผู้ช่วยผู้บริหาร) เป็นฝ่ายการเมือง ไม่ใช่ข้าราชการประจำ ไม่มีเลขที่ตำแหน่งตามกรอบ
// อัตรากำลัง และไม่เข้าโครงสร้างส่วนราชการ 11 หน่วยงานที่ seed ไว้ใน 1700000000033 - ตาม decision ของ
// ผู้ใช้ (2026-09-18) เพิ่ม:
//   - mdm.org_unit: EX (คณะผู้บริหาร), OT (อื่นๆ - ช่องทางรองรับสังกัดที่ยังจัดเข้าพวกไหนไม่ได้ในอนาคต)
//     เป็น DIVISION ลูกของ HQ เหมือนหน่วยงานอื่นทั้งหมด (องค์กรนี้เก็บลึกสุดแค่ระดับกอง/สำนักใน MDM - ดู
//     comment ใน 1700000000033)
//   - mdm.personnel_type: POLITICAL_APPOINTEE (ผู้ดำรงตำแหน่งทางการเมือง)
//   - mdm.position_type: POLITICAL (ฝ่ายการเมือง)
// การยกเว้นกฎ POSITION_NOT_FOUND สำหรับ POLITICAL_APPOINTEE อยู่ที่ migrate/src/quality/rules.js
// (POSITION_OPTIONAL_TYPES) - org_unit_code ยังคงบังคับต้องมีเหมือนกลุ่มอื่นทุกกลุ่ม
//
// valid_from ของ EX/OT: ไม่มีวันที่ประกาศจัดตั้ง/ปรับโครงสร้างที่แน่ชัด (เหมือนกรณี 1700000000033) ใช้
// วันที่ seed ข้อมูลนี้แทน (2026-09-18) - เป็นสมมติฐานตามแบบเดิม ไม่ใช่วันที่ยืนยันจากผู้ใช้ตรงๆ ในงานนี้
const SEED_VALID_FROM = '2026-09-18';

exports.up = async (pgm) => {
  const {
    rows: [hq],
  } = await pgm.db.query(`SELECT org_unit_id FROM mdm.org_unit WHERE code = 'HQ'`);
  if (!hq) {
    throw new Error(
      'ไม่พบ org_unit code=HQ ใน mdm.org_unit - ต้อง apply migration 1700000000033_seed_real_org_units.js ก่อน'
    );
  }

  for (const [code, nameTh] of [
    ['EX', 'คณะผู้บริหาร'],
    ['OT', 'อื่นๆ'],
  ]) {
    await pgm.db.query(
      `INSERT INTO mdm.org_unit (parent_id, code, name_th, unit_level, is_active, valid_from)
       VALUES ($1, $2, $3, 'DIVISION', true, $4)`,
      [hq.org_unit_id, code, nameTh, SEED_VALID_FROM]
    );
  }

  await pgm.db.query(
    `INSERT INTO mdm.personnel_type (code, name_th) VALUES ('POLITICAL_APPOINTEE', 'ผู้ดำรงตำแหน่งทางการเมือง')`
  );
  await pgm.db.query(`INSERT INTO mdm.position_type (code, name_th) VALUES ('POLITICAL', 'ฝ่ายการเมือง')`);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DELETE FROM mdm.position_type WHERE code = 'POLITICAL'`);
  await pgm.db.query(`DELETE FROM mdm.personnel_type WHERE code = 'POLITICAL_APPOINTEE'`);
  await pgm.db.query(`DELETE FROM mdm.org_unit WHERE code = ANY($1::varchar[])`, [['EX', 'OT']]);
};
