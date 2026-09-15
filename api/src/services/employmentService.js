const { withTransaction } = require('../db/transaction');
const { HttpProblem } = require('../security/httpProblem');
const { presentEmployment } = require('./personPresenter');
const { closeAndOpenEmployment } = require('./employmentShared');

const EMPLOYMENT_SELECT = `
  SELECT e.*, pos.position_no, pos.title_th AS position_title_th, pos.line_of_work, pos.position_type,
         pos.is_active AS position_is_active,
         ou.code AS org_unit_code, ou.name_th AS org_unit_name_th, parent_ou.name_th AS org_unit_parent_name_th
  FROM mdm.employment e
  LEFT JOIN mdm.position pos ON pos.position_id = e.position_id
  JOIN mdm.org_unit ou ON ou.org_unit_id = e.org_unit_id
  LEFT JOIN mdm.org_unit parent_ou ON parent_ou.org_unit_id = ou.parent_id
`;

async function getEmploymentHistory(pool, personId, currentOnly) {
  const { rows: personRows } = await pool.query(`SELECT 1 FROM mdm.person WHERE person_id = $1`, [personId]);
  if (personRows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลนี้');

  const { rows } = await pool.query(
    `${EMPLOYMENT_SELECT} WHERE e.person_id = $1 ${currentOnly ? 'AND e.is_current = true' : ''}
     ORDER BY e.effective_from DESC`,
    [personId]
  );
  return rows.map(presentEmployment);
}

function mapChangeLogValue(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

// PUT /persons/{id}/employment (§2.1, §1.6 optimistic lock ผ่าน expectedVersion)
async function upsertEmployment(pool, personId, body) {
  return withTransaction(pool, async (client) => {
    const { rows: personRows } = await client.query(
      `SELECT version FROM mdm.person WHERE person_id = $1 FOR UPDATE`,
      [personId]
    );
    if (personRows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลนี้');

    const currentVersion = personRows[0].version;
    if (body.expectedVersion !== undefined && body.expectedVersion !== currentVersion) {
      throw new HttpProblem(
        409,
        'version-conflict',
        'version ไม่ตรงกับปัจจุบัน',
        `expectedVersion=${body.expectedVersion} แต่ปัจจุบันคือ ${currentVersion}`
      );
    }

    let employmentId;
    let changes;
    try {
      ({ employmentId, changes } = await closeAndOpenEmployment(client, personId, body, 'HR'));
    } catch (err) {
      // closeAndOpenEmployment ห่อ error ของ Postgres ด้วย mapEmploymentConstraintError ให้แล้ว (มี .code)
      if (err.code) throw new HttpProblem(409, err.code, err.message);
      throw err;
    }

    if (changes.length > 0) {
      for (const change of changes) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO audit.data_change_log (person_id, table_name, field_name, old_value, new_value, changed_by, reason)
           VALUES ($1, 'employment', $2, $3, $4, 'HR', $5)`,
          [personId, change.fieldKey, mapChangeLogValue(change.oldValue), mapChangeLogValue(change.newValue), body.referenceDocument ?? null]
        );
      }

      const newVersion = currentVersion + 1;
      await client.query(`UPDATE mdm.person SET version = $2 WHERE person_id = $1`, [personId, newVersion]);
      await client.query(
        `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
         VALUES ($1, 'EMPLOYMENT_UPDATED', $2, $3, $4)`,
        [
          personId,
          JSON.stringify(changes.map((c) => c.fieldKey)),
          JSON.stringify({ personId, version: newVersion, status: 'ACTIVE' }),
          newVersion,
        ]
      );
    }

    const { rows: freshRows } = await client.query(`${EMPLOYMENT_SELECT} WHERE e.employment_id = $1`, [
      employmentId,
    ]);
    return presentEmployment(freshRows[0]);
  });
}

module.exports = { getEmploymentHistory, upsertEmployment, EMPLOYMENT_SELECT };
