// GET /events - pull feed แบบ cursor (§2.3: "GET /events?after=<sequence> เรียงตาม sequence")
// payload ที่ส่งออกต้องไม่มีค่าข้อมูลส่วนบุคคล มีเฉพาะ status/verificationStatus/mergedIntoPersonId
async function listEvents({ pool }, { after = 0, eventTypes, limit = 50 }) {
  const conditions = ['sequence > $1'];
  const params = [after];

  if (eventTypes && eventTypes.length > 0) {
    params.push(eventTypes);
    conditions.push(`event_type = ANY($${params.length}::text[])`);
  }

  params.push(limit + 1); // ขอเกินมา 1 แถวเพื่อรู้ว่ามี hasMore หรือไม่ โดยไม่ต้องนับแยก
  const limitParamIndex = params.length;

  const { rows } = await pool.query(
    `SELECT event_id, sequence, event_type, person_id, occurred_at, version, changed_fields, payload
     FROM integration.outbox_event
     WHERE ${conditions.join(' AND ')}
     ORDER BY sequence
     LIMIT $${limitParamIndex}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const data = page.map((row) => ({
    eventId: row.event_id,
    sequence: Number(row.sequence),
    eventType: row.event_type,
    personId: row.person_id,
    occurredAt: row.occurred_at,
    version: row.version,
    changedFields: row.changed_fields || [],
    data: {
      status: row.payload?.status ?? null,
      verificationStatus: row.payload?.verificationStatus ?? null,
      mergedIntoPersonId: row.payload?.mergedIntoPersonId ?? null,
    },
  }));

  const lastSequence = data.length > 0 ? data[data.length - 1].sequence : after;

  return { data, lastSequence, hasMore };
}

module.exports = { listEvents };
