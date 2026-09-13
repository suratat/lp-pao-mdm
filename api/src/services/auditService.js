// GET /persons/{id}/change-log - ค่าของฟิลด์ที่ field_policy จัดเป็น RESTRICTED ต้องถูก mask (§2.1)
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
            dcl.actor_sub, dcl.sync_event_id, dcl.reason, fp.classification
     FROM audit.data_change_log dcl
     LEFT JOIN mdm.field_policy fp ON fp.field_key = dcl.field_name
     WHERE ${conditions.join(' AND ')}
     ORDER BY dcl.log_id
     LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const data = page.map((r) => {
    const restricted = r.classification === 'RESTRICTED';
    return {
      logId: Number(r.log_id),
      changedAt: r.changed_at,
      fieldKey: r.field_name,
      oldValue: restricted ? null : r.old_value,
      newValue: restricted ? null : r.new_value,
      changedBy: r.changed_by,
      actorSub: r.actor_sub,
      syncEventId: r.sync_event_id,
      reason: r.reason,
    };
  });

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

module.exports = { getPersonChangeLog, listAccessLogs };
