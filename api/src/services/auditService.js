const { HttpProblem } = require('../security/httpProblem');
const { redactPidText, redactPidDeep, containsPidLike } = require('../security/redact');

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

// แถว access_log ที่เป็น "การเปิดเลขบัตร" (POST /persons/{uuid}/pid ที่สำเร็จ; แถวก่อน PR-B เป็น GET) - นิยามเดียวใช้ทั้งตอนแสดงสถานะรีวิว, กรอง reviewStatus และตรวจก่อนรีวิว
// endpoint รุ่นก่อน #73 มี ?justification=... ต่อท้าย จึงยอมให้ตามหลัง /pid ด้วย ? หรือจบสตริง
const PID_REVEAL_SQL = `(al.http_method IN ('GET', 'POST') AND al.response_status = 200
  AND al.endpoint ~ '/persons/[0-9a-fA-F-]{36}/pid(\\?|$)')`;

const REVIEW_STATUSES = ['PENDING', 'REVIEWED', 'NEEDS_EXPLANATION'];

// GET /audit/access-logs (DPO / auditor)
// reviewStatus: เฉพาะการเปิดเลขบัตร (PID_REVEAL_SQL) ที่สถานะรีวิวล่าสุดตรงค่า (PENDING = ยังไม่มีแถวรีวิว)
async function listAccessLogs(pool, { personId, clientId, from, to, pidAccessOnly, reviewStatus, cursor, limit }) {
  const conditions = [];
  const params = [];

  if (personId) {
    params.push(personId);
    conditions.push(`al.subject_person_id = $${params.length}`);
  }
  if (clientId) {
    params.push(clientId);
    conditions.push(`al.keycloak_client_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`al.accessed_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`al.accessed_at <= $${params.length}`);
  }
  if (pidAccessOnly) {
    conditions.push(`(al.endpoint LIKE '%/pid%' OR al.endpoint LIKE '%/lookup%')`);
  }
  if (reviewStatus) {
    conditions.push(PID_REVEAL_SQL);
    params.push(reviewStatus);
    conditions.push(`COALESCE(rv.status, 'PENDING') = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor);
    conditions.push(`al.access_id > $${params.length}`);
  }
  params.push(limit + 1);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT al.access_id, al.accessed_at, al.subject_person_id, al.actor_type, al.actor_sub, al.keycloak_client_id,
            al.endpoint, al.http_method, al.fields_returned, al.purpose_code, al.justification, al.request_id, al.response_status,
            CASE WHEN ${PID_REVEAL_SQL} THEN COALESCE(rv.status, 'PENDING') END AS review_status,
            rv.reviewed_at, rv.reviewer_sub, rv.note AS review_note
     FROM audit.access_log al
     LEFT JOIN LATERAL (
       SELECT r.status, r.reviewed_at, r.reviewer_sub, r.note
       FROM audit.pid_access_review r
       WHERE r.access_id = al.access_id AND r.accessed_at = al.accessed_at
       ORDER BY r.review_id DESC LIMIT 1
     ) rv ON true
     ${whereClause}
     ORDER BY al.access_id
     LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const data = page.map((r) => ({
    accessId: Number(r.access_id),
    accessedAt: r.accessed_at,
    subjectPersonId: r.subject_person_id,
    actorType: r.actor_type,
    actorSub: r.actor_sub,
    clientId: r.keycloak_client_id,
    endpoint: r.endpoint,
    fieldsReturned: r.fields_returned || [],
    purposeCode: r.purpose_code,
    // ข้อความอิสระ: แถวเก่าอาจมีเลข 13 หลักหลุดมา (ก่อนมีการปฏิเสธตอนรับ) - ปกปิดตอนแสดงเสมอ
    justification: r.justification === null ? null : redactPidText(r.justification),
    requestId: r.request_id,
    responseStatus: r.response_status,
    reviewStatus: r.review_status ?? null,
    // nullable แบบ array ([string, 'null']) ต้องแปลง Date เป็น ISO string เอง (validator แปลงให้เฉพาะ type: string เดี่ยวๆ)
    reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    reviewerSub: r.reviewer_sub ?? null,
    reviewNote: r.review_note === null || r.review_note === undefined ? null : redactPidText(r.review_note),
  }));

  return { data, page: { nextCursor: hasMore ? page[page.length - 1].access_id : null, limit } };
}

// POST /audit/access-logs/{accessId}/review - เขียนแถวรีวิวใหม่ (append-only; รีวิวซ้ำได้ แถวล่าสุดชนะ)
// accessedAt จาก API มีความละเอียดระดับ ms (JS Date) แต่ timestamptz ใน DB ละเอียดถึง µs จึงจับคู่แบบช่วง 1 ms แล้วบันทึกค่าจริงจากแถว access_log
// (INSERT ... SELECT) ไม่ใช่ค่าที่ผู้เรียกส่งมา - ตรวจในคำสั่งเดียวว่ารายการมีจริง เป็นการเปิด pid และไม่ใช่ของผู้รีวิวเอง
async function reviewPidAccess(pool, { accessId, accessedAt, status, note }, reviewer) {
  const cleanNote = typeof note === 'string' ? note.trim() : '';
  if (status === 'NEEDS_EXPLANATION' && cleanNote.length === 0) {
    throw new HttpProblem(422, 'note-required', 'ต้องระบุหมายเหตุ', 'การขอคำชี้แจง (NEEDS_EXPLANATION) ต้องระบุว่าต้องการให้ชี้แจงเรื่องใด');
  }
  if (containsPidLike(cleanNote)) {
    throw new HttpProblem(422, 'note-contains-pid', 'หมายเหตุมีเลขบัตรประชาชน', 'note ห้ามมีเลข 13 หลัก');
  }

  const { rows } = await pool.query(
    `INSERT INTO audit.pid_access_review (access_id, accessed_at, status, note, reviewer_sub, reviewer_client)
     SELECT al.access_id, al.accessed_at, $3::varchar, $4::text, $5::varchar, $6::varchar
     FROM audit.access_log al
     WHERE al.access_id = $1
       AND al.accessed_at >= $2::timestamptz AND al.accessed_at < $2::timestamptz + interval '1 millisecond'
       AND ${PID_REVEAL_SQL}
       AND al.actor_sub IS DISTINCT FROM $5::varchar
     RETURNING review_id, access_id, accessed_at, status, note, reviewer_sub, reviewed_at`,
    [accessId, accessedAt, status, cleanNote || null, reviewer.sub, reviewer.azp ?? null]
  );
  if (rows.length > 0) {
    const r = rows[0];
    return {
      reviewId: Number(r.review_id),
      accessId: Number(r.access_id),
      accessedAt: r.accessed_at,
      status: r.status,
      note: r.note,
      reviewerSub: r.reviewer_sub,
      reviewedAt: r.reviewed_at,
    };
  }

  // INSERT ไม่ได้แถว: แยกสาเหตุเพื่อตอบ 404 หรือ 403 ให้ถูก (ไม่เปิดเผยรายละเอียดของแถวที่ผู้รีวิวไม่มีสิทธิ์รีวิว)
  const { rows: target } = await pool.query(
    `SELECT al.actor_sub FROM audit.access_log al
     WHERE al.access_id = $1 AND al.accessed_at >= $2::timestamptz AND al.accessed_at < $2::timestamptz + interval '1 millisecond'
       AND ${PID_REVEAL_SQL}`,
    [accessId, accessedAt]
  );
  if (target.length === 0) {
    throw new HttpProblem(404, 'not-found', 'ไม่พบรายการ', 'ไม่พบรายการเปิดเลขบัตรตาม accessId/accessedAt ที่ระบุ');
  }
  throw new HttpProblem(403, 'self-review-forbidden', 'รีวิวรายการของตนเองไม่ได้', 'ผู้ที่เปิดเลขบัตรรีวิวรายการของตนเองไม่ได้ ต้องให้ผู้อื่นที่เป็นอิสระรีวิว');
}

module.exports = { getPersonChangeLog, listChangeLogs, listAccessLogs, reviewPidAccess, presentChangeValues, REVIEW_STATUSES };
