async function listOrgUnits(pool, activeOnly) {
  const { rows } = await pool.query(
    `SELECT org_unit_id, parent_id, code, name_th, name_en, unit_level, is_active
     FROM mdm.org_unit
     ${activeOnly ? 'WHERE is_active = true' : ''}
     ORDER BY code`
  );
  return rows.map((r) => ({
    orgUnitId: r.org_unit_id,
    parentId: r.parent_id,
    code: r.code,
    nameTh: r.name_th,
    nameEn: r.name_en,
    unitLevel: r.unit_level,
    isActive: r.is_active,
  }));
}

async function listPositions(pool, orgUnitId) {
  const params = [];
  let where = '';
  if (orgUnitId) {
    params.push(orgUnitId);
    where = 'WHERE org_unit_id = $1';
  }

  const { rows } = await pool.query(
    `SELECT position_id, position_no, title_th, line_of_work, position_type, org_unit_id, is_active
     FROM mdm.position ${where} ORDER BY position_no`,
    params
  );
  return rows.map((r) => ({
    positionId: r.position_id,
    positionNo: r.position_no,
    titleTh: r.title_th,
    // lineOfWork เป็น {type: string} ไม่ nullable ใน Position schema - ตัดออกเมื่อไม่มีค่าแทนที่จะส่ง null
    lineOfWork: r.line_of_work ?? undefined,
    positionType: r.position_type,
    orgUnitId: r.org_unit_id,
    isActive: r.is_active,
  }));
}

module.exports = { listOrgUnits, listPositions };
