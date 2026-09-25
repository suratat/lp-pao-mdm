const ORG_UNIT_COLUMNS = 'org_unit_id, parent_id, code, name_th, name_en, unit_level, is_active';
const POSITION_COLUMNS = 'position_id, position_no, title_th, line_of_work, position_type, org_unit_id, is_active';

function presentOrgUnit(r) {
  return {
    orgUnitId: r.org_unit_id,
    parentId: r.parent_id,
    code: r.code,
    nameTh: r.name_th,
    nameEn: r.name_en,
    unitLevel: r.unit_level,
    isActive: r.is_active,
  };
}

function presentPosition(r) {
  return {
    positionId: r.position_id,
    positionNo: r.position_no,
    titleTh: r.title_th,
    // lineOfWork เป็น {type: string} ไม่ nullable ใน Position schema - ตัดออกเมื่อไม่มีค่าแทนที่จะส่ง null
    lineOfWork: r.line_of_work ?? undefined,
    positionType: r.position_type,
    orgUnitId: r.org_unit_id,
    isActive: r.is_active,
  };
}

async function listOrgUnits(pool, activeOnly) {
  const { rows } = await pool.query(
    `SELECT ${ORG_UNIT_COLUMNS}
     FROM mdm.org_unit
     ${activeOnly ? 'WHERE is_active = true' : ''}
     ORDER BY code`
  );
  return rows.map(presentOrgUnit);
}

// activeOnly ค่าเริ่มต้น false = คงพฤติกรรมเดิมก่อน T10 (คืนทั้ง active และ inactive)
async function listPositions(pool, orgUnitId, activeOnly = false) {
  const params = [];
  const conditions = [];
  if (orgUnitId) {
    params.push(orgUnitId);
    conditions.push(`org_unit_id = $${params.length}`);
  }
  if (activeOnly) conditions.push('is_active = true');

  const { rows } = await pool.query(
    `SELECT ${POSITION_COLUMNS}
     FROM mdm.position ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY position_no`,
    params
  );
  return rows.map(presentPosition);
}

async function listPositionTypes(pool, activeOnly = true) {
  const { rows } = await pool.query(
    `SELECT code, name_th, is_active FROM mdm.position_type ${activeOnly ? 'WHERE is_active = true' : ''} ORDER BY code`
  );
  return rows.map((r) => ({ code: r.code, nameTh: r.name_th, isActive: r.is_active }));
}

module.exports = {
  listOrgUnits,
  listPositions,
  listPositionTypes,
  presentOrgUnit,
  presentPosition,
  ORG_UNIT_COLUMNS,
  POSITION_COLUMNS,
};
