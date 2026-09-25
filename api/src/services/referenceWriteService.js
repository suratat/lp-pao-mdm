const { withTransaction } = require('../db/transaction');
const { HttpProblem } = require('../security/httpProblem');
const {
  presentOrgUnit,
  presentPosition,
  ORG_UNIT_COLUMNS,
  POSITION_COLUMNS,
} = require('./referenceService');

// T10: เพิ่ม/แก้ master data หน่วยงาน (mdm.org_unit) และตำแหน่ง (mdm.position)
// - ไม่มีการลบจริง: ปิดใช้งานด้วย is_active=false เท่านั้น (FK จาก position/employment)
// - ทุก write บันทึก audit.reference_change_log ใน transaction เดียวกัน (แยกจาก data_change_log ที่เป็นของข้อมูลบุคคล)
// - ไม่ส่ง outbox_event: outbox_event.person_id NOT NULL และ master data ไม่ใช่ข้อมูลบุคคล

// pg_advisory_xact_lock ตัวเดียวสำหรับทุกการเขียน org_unit: ต้นไม้หน่วยงานมี invariant ข้ามแถว (ไม่มี cycle,
// parent ต้อง active) ที่ row lock อย่างเดียวกันสองคนแก้พร้อมกันไม่ได้ (และเสี่ยง deadlock) - ปริมาณงานต่ำมาก
// (เจ้าหน้าที่ไม่กี่คน) จึงเลือก serialize ทั้งหมดให้เรียบง่ายและถูกต้อง
const ORG_UNIT_WRITE_LOCK_KEY = 'mdm.org_unit.write';

const PG_UNIQUE_VIOLATION = '23505';
const PG_FK_VIOLATION = '23503';

function asJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

async function writeChangeLog(client, { tableName, recordId, action, changes, actor }) {
  for (const { field, oldValue, newValue } of changes) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO audit.reference_change_log
         (table_name, record_id, action, field_name, old_value, new_value, actor_sub, actor_client)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tableName, recordId, action, field, asJson(oldValue), asJson(newValue), actor.sub, actor.azp ?? null]
    );
  }
}

// เทียบเฉพาะฟิลด์ที่แก้ได้ (fieldMap: field ใน DB -> ค่าใหม่) กับแถวเดิม คืนเฉพาะที่เปลี่ยนจริง
function diffFields(existingRow, nextValues) {
  const changes = [];
  for (const [field, newValue] of Object.entries(nextValues)) {
    const oldValue = existingRow[field] ?? null;
    if (oldValue !== (newValue ?? null)) changes.push({ field, oldValue, newValue: newValue ?? null });
  }
  return changes;
}

// ---------------------------------------------------------------- org unit

// ตรวจ parent ใหม่: ต้องมีอยู่จริงและ active, และไม่ทำให้เกิด cycle (selfId = org_unit ที่กำลังแก้ ถ้ามี)
async function assertValidParent(client, parentId, selfId) {
  const { rows } = await client.query(`SELECT org_unit_id, is_active FROM mdm.org_unit WHERE org_unit_id = $1`, [parentId]);
  if (rows.length === 0 || !rows[0].is_active) {
    throw new HttpProblem(422, 'org-unit-parent-invalid', 'หน่วยงานต้นสังกัดไม่ถูกต้อง', 'ไม่พบหน่วยงานต้นสังกัด หรือหน่วยงานนั้นถูกปิดใช้งานแล้ว');
  }
  if (!selfId) return;

  // เดินขึ้นจาก parent ใหม่ ถ้าเจอ selfId แปลว่า parent ใหม่เป็นลูกหลานของตัวเอง (หรือคือตัวเอง)
  const { rows: cycle } = await client.query(
    `WITH RECURSIVE ancestors AS (
       SELECT org_unit_id, parent_id FROM mdm.org_unit WHERE org_unit_id = $1
       UNION
       SELECT o.org_unit_id, o.parent_id FROM mdm.org_unit o JOIN ancestors a ON o.org_unit_id = a.parent_id
     )
     SELECT 1 FROM ancestors WHERE org_unit_id = $2 LIMIT 1`,
    [parentId, selfId]
  );
  if (cycle.length > 0) {
    throw new HttpProblem(422, 'org-unit-parent-cycle', 'หน่วยงานต้นสังกัดทำให้เกิดวงวน', 'ไม่สามารถตั้งหน่วยงานตัวเองหรือหน่วยงานลูกหลานเป็นต้นสังกัดได้');
  }
}

async function createOrgUnit(pool, body, actor) {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ORG_UNIT_WRITE_LOCK_KEY]);

    if (body.parentId) await assertValidParent(client, body.parentId, null);

    let row;
    try {
      const { rows } = await client.query(
        `INSERT INTO mdm.org_unit (parent_id, code, name_th, name_en, unit_level, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING ${ORG_UNIT_COLUMNS}`,
        [body.parentId ?? null, body.code, body.nameTh, body.nameEn ?? null, body.unitLevel]
      );
      row = rows[0];
    } catch (err) {
      // UNIQUE index บน code เป็นตัวตัดสิน (ไม่ใช้ check-then-insert) - constraint อื่นของตารางนี้ไม่มีที่ผู้ใช้ชนได้
      if (err.code === PG_UNIQUE_VIOLATION) {
        throw new HttpProblem(409, 'org-unit-code-conflict', 'รหัสหน่วยงานซ้ำ', `มีหน่วยงานรหัส "${body.code}" อยู่แล้ว`);
      }
      throw err;
    }

    await writeChangeLog(client, {
      tableName: 'org_unit',
      recordId: row.org_unit_id,
      action: 'CREATE',
      actor,
      changes: [
        { field: 'code', oldValue: null, newValue: row.code },
        { field: 'parent_id', oldValue: null, newValue: row.parent_id },
        { field: 'name_th', oldValue: null, newValue: row.name_th },
        { field: 'name_en', oldValue: null, newValue: row.name_en },
        { field: 'unit_level', oldValue: null, newValue: row.unit_level },
        { field: 'is_active', oldValue: null, newValue: row.is_active },
      ],
    });

    return presentOrgUnit(row);
  });
}

async function updateOrgUnit(pool, orgUnitId, body, actor) {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ORG_UNIT_WRITE_LOCK_KEY]);

    const { rows } = await client.query(`SELECT ${ORG_UNIT_COLUMNS} FROM mdm.org_unit WHERE org_unit_id = $1 FOR UPDATE`, [orgUnitId]);
    if (rows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบหน่วยงานนี้');
    const existing = rows[0];

    const next = {
      parent_id: body.parentId ?? null,
      name_th: body.nameTh,
      name_en: body.nameEn ?? null,
      unit_level: body.unitLevel,
      is_active: body.isActive,
    };
    const changes = diffFields(existing, next);
    if (changes.length === 0) return presentOrgUnit(existing);

    if (next.parent_id && (next.parent_id !== existing.parent_id || (next.is_active && !existing.is_active))) {
      await assertValidParent(client, next.parent_id, orgUnitId);
    }

    if (existing.is_active && !next.is_active) {
      const { rows: usage } = await client.query(
        `SELECT
           (SELECT count(*)::int FROM mdm.org_unit WHERE parent_id = $1 AND is_active) AS active_children,
           (SELECT count(*)::int FROM mdm.position WHERE org_unit_id = $1 AND is_active) AS active_positions,
           (SELECT count(*)::int FROM mdm.employment WHERE org_unit_id = $1 AND is_current) AS current_employments`,
        [orgUnitId]
      );
      const u = usage[0];
      if (u.active_children > 0 || u.active_positions > 0 || u.current_employments > 0) {
        throw new HttpProblem(
          409,
          'org-unit-in-use',
          'ปิดใช้งานหน่วยงานไม่ได้',
          `ยังมีหน่วยงานลูกที่ใช้งานอยู่ ${u.active_children}, ตำแหน่งที่ใช้งานอยู่ ${u.active_positions}, ผู้ปฏิบัติงานปัจจุบัน ${u.current_employments} - ต้องย้ายหรือปิดรายการเหล่านี้ก่อน`
        );
      }
    }

    const { rows: updated } = await client.query(
      `UPDATE mdm.org_unit
       SET parent_id = $2, name_th = $3, name_en = $4, unit_level = $5, is_active = $6
       WHERE org_unit_id = $1
       RETURNING ${ORG_UNIT_COLUMNS}`,
      [orgUnitId, next.parent_id, next.name_th, next.name_en, next.unit_level, next.is_active]
    );

    await writeChangeLog(client, { tableName: 'org_unit', recordId: orgUnitId, action: 'UPDATE', actor, changes });
    return presentOrgUnit(updated[0]);
  });
}

// ---------------------------------------------------------------- position

function positionNoConflict(positionNo) {
  return new HttpProblem(409, 'position-no-conflict', 'เลขที่ตำแหน่งซ้ำ', `มีตำแหน่งเลขที่ "${positionNo}" อยู่แล้ว`);
}

// FOR SHARE: กัน org_unit ถูกปิดใช้งานระหว่างที่กำลังผูกตำแหน่งเข้ากับมัน (updateOrgUnit ล็อกแถวเดียวกัน FOR UPDATE
// แล้วนับตำแหน่ง active - ถ้าเราเข้ามาก่อนมันจะรอเรา แล้วเห็นตำแหน่งใหม่ ถ้ามันมาก่อนเราจะเห็น is_active=false)
async function assertActiveOrgUnit(client, orgUnitId) {
  const { rows } = await client.query(`SELECT is_active FROM mdm.org_unit WHERE org_unit_id = $1 FOR SHARE`, [orgUnitId]);
  if (rows.length === 0 || !rows[0].is_active) {
    throw new HttpProblem(422, 'org-unit-invalid', 'หน่วยงานไม่ถูกต้อง', 'ไม่พบหน่วยงานที่ระบุ หรือหน่วยงานนั้นถูกปิดใช้งานแล้ว');
  }
}

async function assertActivePositionType(client, code) {
  const { rows } = await client.query(`SELECT is_active FROM mdm.position_type WHERE code = $1`, [code]);
  if (rows.length === 0 || !rows[0].is_active) {
    throw new HttpProblem(422, 'position-type-invalid', 'หมวดตำแหน่งไม่ถูกต้อง', `ไม่พบหมวดตำแหน่ง "${code}" หรือถูกปิดใช้งานแล้ว`);
  }
}

async function createPosition(pool, body, actor) {
  return withTransaction(pool, async (client) => {
    await assertActiveOrgUnit(client, body.orgUnitId);
    await assertActivePositionType(client, body.positionType);

    let row;
    try {
      const { rows } = await client.query(
        `INSERT INTO mdm.position (position_no, title_th, line_of_work, position_type, org_unit_id, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING ${POSITION_COLUMNS}`,
        [body.positionNo, body.titleTh, body.lineOfWork ?? null, body.positionType, body.orgUnitId]
      );
      row = rows[0];
    } catch (err) {
      // สอง request พร้อมกันด้วย position_no เดียวกัน: UNIQUE index ให้แค่ตัวเดียวผ่าน อีกตัวจะมาตกที่นี่
      if (err.code === PG_UNIQUE_VIOLATION) throw positionNoConflict(body.positionNo);
      if (err.code === PG_FK_VIOLATION) {
        throw new HttpProblem(422, 'position-reference-invalid', 'ข้อมูลอ้างอิงไม่ถูกต้อง', 'หน่วยงานหรือหมวดตำแหน่งที่ระบุไม่มีอยู่');
      }
      throw err;
    }

    await writeChangeLog(client, {
      tableName: 'position',
      recordId: row.position_id,
      action: 'CREATE',
      actor,
      changes: [
        { field: 'position_no', oldValue: null, newValue: row.position_no },
        { field: 'title_th', oldValue: null, newValue: row.title_th },
        { field: 'line_of_work', oldValue: null, newValue: row.line_of_work },
        { field: 'position_type', oldValue: null, newValue: row.position_type },
        { field: 'org_unit_id', oldValue: null, newValue: row.org_unit_id },
        { field: 'is_active', oldValue: null, newValue: row.is_active },
      ],
    });

    return presentPosition(row);
  });
}

async function updatePosition(pool, positionId, body, actor) {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(`SELECT ${POSITION_COLUMNS} FROM mdm.position WHERE position_id = $1 FOR UPDATE`, [positionId]);
    if (rows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบตำแหน่งนี้');
    const existing = rows[0];

    const next = {
      position_no: body.positionNo,
      title_th: body.titleTh,
      line_of_work: body.lineOfWork ?? null,
      position_type: body.positionType,
      org_unit_id: body.orgUnitId,
      is_active: body.isActive,
    };
    const changes = diffFields(existing, next);
    if (changes.length === 0) return presentPosition(existing);

    const orgUnitChanged = next.org_unit_id !== existing.org_unit_id;
    const deactivating = existing.is_active && !next.is_active;
    const reactivating = !existing.is_active && next.is_active;

    if (orgUnitChanged || deactivating) {
      const { rows: occupants } = await client.query(
        `SELECT count(*)::int AS n FROM mdm.employment WHERE position_id = $1 AND is_current`,
        [positionId]
      );
      if (occupants[0].n > 0) {
        throw new HttpProblem(
          409,
          'position-occupied',
          'แก้ตำแหน่งไม่ได้เพราะมีผู้ดำรงตำแหน่งอยู่',
          `ตำแหน่งนี้มีผู้ดำรงตำแหน่งปัจจุบัน ${occupants[0].n} คน - ต้องย้ายผู้ดำรงตำแหน่งออกก่อนจึงจะปิดใช้งานหรือย้ายสังกัดได้`
        );
      }
    }

    // สังกัดใหม่ (หรือสังกัดเดิมเมื่อเปิดใช้งานกลับ) ต้อง active
    if (orgUnitChanged || reactivating) await assertActiveOrgUnit(client, next.org_unit_id);
    if (next.position_type !== existing.position_type) await assertActivePositionType(client, next.position_type);

    let updated;
    try {
      ({ rows: updated } = await client.query(
        `UPDATE mdm.position
         SET position_no = $2, title_th = $3, line_of_work = $4, position_type = $5, org_unit_id = $6, is_active = $7
         WHERE position_id = $1
         RETURNING ${POSITION_COLUMNS}`,
        [positionId, next.position_no, next.title_th, next.line_of_work, next.position_type, next.org_unit_id, next.is_active]
      ));
    } catch (err) {
      if (err.code === PG_UNIQUE_VIOLATION) throw positionNoConflict(body.positionNo);
      if (err.code === PG_FK_VIOLATION) {
        throw new HttpProblem(422, 'position-reference-invalid', 'ข้อมูลอ้างอิงไม่ถูกต้อง', 'หน่วยงานหรือหมวดตำแหน่งที่ระบุไม่มีอยู่');
      }
      throw err;
    }

    await writeChangeLog(client, { tableName: 'position', recordId: positionId, action: 'UPDATE', actor, changes });
    return presentPosition(updated[0]);
  });
}

module.exports = { createOrgUnit, updateOrgUnit, createPosition, updatePosition };
