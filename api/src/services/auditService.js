const { HttpProblem } = require('../security/httpProblem');
const { redactPidText, redactPidDeep } = require('../security/redact');

// หน้า DPO ต้องเห็นว่า "ฟิลด์ไหนเปลี่ยน ใครเปลี่ยน เมื่อไหร่" ไม่ใช่ค่าข้อมูลส่วนบุคคล: ฟิลด์ชั้น CONFIDENTIAL/SENSITIVE/RESTRICTED
// ปกปิดค่าทั้งหมด (คืน null + valuesHidden = true) ฟิลด์ชั้น INTERNAL หรือฟิลด์ที่ไม่อยู่ใน field_policy (เช่น status) แสดงค่า
// แต่ผ่าน redactPidDeep เสมอ กันเลข 13 หลักหลุดจากค่าเก่าที่เขียนก่อนมี changeLogWriter
const HIDDEN_CLASSIFICATIONS = new Set(['CONFIDENTIAL', 'SENSITIVE', 'RESTRICTED']);

function presentChangeValues(classification, oldValue, newValue) {
  if (HIDDEN_CLASSIFICATIONS.has(classification)) {
    return { oldValue: null, newValue: null, valuesHidden: true };
  }
  return { oldValue: redactPidDeep(oldValue ?? null), newValue: redactPidDeep(newValue ?? null), valuesHidden: false };
}

// GET /persons/{id}/change-log - ฟิลด์ที่ field_policy จัดเป็น CONFIDENTIAL/SENSITIVE/RESTRICTED ต้องถูก mask (§2.1)
async function getPersonChangeLog(pool, personId, { since, cursor, limit }) {
  const conditions = ['dcl.person_id = $1'];
  const params = [personId];

  if (since) {
    params.push(since);
    conditions.push(`dcl.changed_at > $${params.length}`);
  }
  if (cursor) {
    params.push(cursor);
    conditions.push(`dcl.log_id > $${params.length}`);
  }
  params.push(limit + 1);

  const { rows } = await pool.query(
    `SELECT dcl.log_id, dcl.changed_at, dcl.field_name, dcl.old_value, dcl.new_value, dcl.changed_by,
            dcl.actor_sub, dcl.actor_client, dcl.sync_event_id, dcl.reason, fp.classification
     FROM audit.data_change_log dcl
     LEFT JOIN mdm.field_policy fp ON fp.field_key = dcl.field_name
     WHERE ${conditions.join(' AND ')}
     ORDER BY dcl.log_id
     LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const data = page.map((r) => ({
    logId: Number(r.log_id),
    changedAt: r.changed_at,
    fieldKey: r.field_name,
    ...presentChangeValues(r.classification, r.old_value, r.new_value),
    changedBy: r.changed_by,
    actorSub: r.actor_sub,
    actorClient: r.actor_client,
    syncEventId: r.sync_event_id,
    reason: r.reason === null ? null : redactPidText(r.reason),
  }));

  return { data, page: { nextCursor: hasMore ? page[page.length - 1].log_id : null, limit } };
}

// GET /audit/change-logs (DPO / auditor) - source=PERSON อ่าน audit.data_change_log, source=REFERENCE อ่าน audit.reference_change_log
// (แยกกันโดยตั้งใจ ไม่ UNION: log_id ของสองตารางเป็นคนละ sequence จึงทำ cursor ร่วมกันไม่ได้) เรียงใหม่ -> เก่า
async function listChangeLogs(
  pool,
  { source = 'PERSON', from, to, actorSub, tableName, personId, changedBy, action, cursor, limit }
) {
  if (source === 'REFERENCE' && (personId || changedBy)) {
    throw new HttpProblem(400, 'bad-request', 'ตัวกรองไม่ตรงกับ source', 'personId และ changedBy ใช้ได้กับ source=PERSON เท่านั้น');
  }
  if (source === 'PERSON' && action) {
    throw new HttpProblem(400, 'bad-request', 'ตัวกรองไม่ตรงกับ source', 'action ใช้ได้กับ source=REFERENCE เท่านั้น');
  }

  const conditions = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };

  if (from) add('changed_at >= ?', from);
  if (to) add('changed_at <= ?', to);
  if (actorSub) add('actor_sub = ?', actorSub);
  if (tableName) add('table_name = ?', tableName);
  if (cursor) add('log_id < ?', cursor);
  if (source === 'PERSON') {
    if (personId) add('person_id = ?', personId);
    if (changedBy) add('changed_by = ?', changedBy);
  } else if (action) {
    add('action = ?', action);
  }
  params.push(limit + 1);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  let rows;
  if (source === 'PERSON') {
    // กรอง/จำกัดจำนวนในตารางหลักก่อน (subquery) แล้วค่อย JOIN field_policy เพื่อให้ใช้ index ของ data_change_log
    ({ rows } = await pool.query(
      `SELECT dcl.log_id, dcl.changed_at, dcl.person_id, dcl.table_name, dcl.field_name, dcl.old_value, dcl.new_value,
              dcl.changed_by, dcl.actor_sub, dcl.actor_client, dcl.sync_event_id, dcl.reason, fp.classification
       FROM (SELECT * FROM audit.data_change_log ${where} ORDER BY log_id DESC LIMIT $${params.length}) dcl
       LEFT JOIN mdm.field_policy fp ON fp.field_key = dcl.field_name
       ORDER BY dcl.log_id DESC`,
      params
    ));
  } else {
    ({ rows } = await pool.query(
      `SELECT log_id, changed_at, table_name, record_id, action, field_name, old_value, new_value, actor_sub, actor_client
       FROM audit.reference_change_log ${where} ORDER BY log_id DESC LIMIT $${params.length}`,
      params
    ));
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const data = page.map((r) =>
    source === 'PERSON'
      ? {
          source,
          logId: Number(r.log_id),
          changedAt: r.changed_at,
          personId: r.person_id,
          tableName: r.table_name,
          fieldKey: r.field_name,
          ...presentChangeValues(r.classification, r.old_value, r.new_value),
          changedBy: r.changed_by,
          actorSub: r.actor_sub,
          actorClient: r.actor_client,
          syncEventId: r.sync_event_id,
          reason: r.reason === null ? null : redactPidText(r.reason),
        }
      : {
          source,
          logId: Number(r.log_id),
          changedAt: r.changed_at,
          tableName: r.table_name,
          recordId: r.record_id,
          action: r.action,
          fieldKey: r.field_name,
          // master data หน่วยงาน/ตำแหน่ง ไม่ใช่ข้อมูลบุคคล - แสดงค่าได้ (ยังผ่าน redact กันพิมพ์เลขบัตรลงชื่อหน่วยงานเอง)
          oldValue: redactPidDeep(r.old_value ?? null),
          newValue: redactPidDeep(r.new_value ?? null),
          valuesHidden: false,
          actorSub: r.actor_sub,
          actorClient: r.actor_client,
        }
  );

  return { data, page: { nextCursor: hasMore ? page[page.length - 1].log_id : null, limit } };
}

// GET /audit/access-logs (DPO / auditor)
async function listAccessLogs(pool, { personId, clientId, from, to, pidAccessOnly, cursor, limit }) {
  const conditions = [];
  const params = [];

  if (personId) {
    params.push(personId);
    conditions.push(`subject_person_id = $${params.length}`);
  }
  if (clientId) {
    params.push(clientId);
    conditions.push(`keycloak_client_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`accessed_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`accessed_at <= $${params.length}`);
  }
  if (pidAccessOnly) {
    conditions.push(`(endpoint LIKE '%/pid%' OR endpoint LIKE '%/lookup%')`);
  }
  if (cursor) {
    params.push(cursor);
    conditions.push(`access_id > $${params.length}`);
  }
  params.push(limit + 1);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT access_id, accessed_at, subject_person_id, actor_type, actor_sub, keycloak_client_id,
            endpoint, http_method, fields_returned, purpose_code, justification, request_id, response_status
     FROM audit.access_log ${whereClause}
     ORDER BY access_id
     LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const data = page.map((r) => ({
    accessedAt: r.accessed_at,
    subjectPersonId: r.subject_person_id,
    actorType: r.actor_type,
    actorSub: r.actor_sub,
    clientId: r.keycloak_client_id,
    endpoint: r.endpoint,
    fieldsReturned: r.fields_returned || [],
    purposeCode: r.purpose_code,
    justification: r.justification,
    requestId: r.request_id,
    responseStatus: r.response_status,
  }));

  return { data, page: { nextCursor: hasMore ? page[page.length - 1].access_id : null, limit } };
}

module.exports = { getPersonChangeLog, listChangeLogs, listAccessLogs, presentChangeValues };
