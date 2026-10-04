const { withTransaction } = require('../db/transaction');
const { HttpProblem } = require('../security/httpProblem');
const { redactPidText, containsPidLike } = require('../security/redact');

// แจ้งเตือนพฤติกรรมการเข้าถึงข้อมูลผิดปกติ (worker job access-anomaly-scan เขียน audit.access_alert; ที่นี่อ่านและบันทึกการรับทราบ/ปิดเรื่อง)
// ตารางเป็น append-only: สถานะคำนวณจาก action ล่าสุดของ alert (ไม่มี = OPEN, ACK = ACK, CLOSE = CLOSED)
const ALERT_STATUSES = ['OPEN', 'ACK', 'CLOSED'];
const NOTE_MAX = 1000;

const LAST_ACTION_JOIN = `
  LEFT JOIN LATERAL (
    SELECT x.action, x.note, x.actor_sub, x.created_at
    FROM audit.access_alert_action x
    WHERE x.alert_id = a.alert_id
    ORDER BY x.action_id DESC LIMIT 1
  ) la ON true`;
const STATUS_SQL = `(CASE la.action WHEN 'CLOSE' THEN 'CLOSED' WHEN 'ACK' THEN 'ACK' ELSE 'OPEN' END)`;

function statusOf(lastAction) {
  if (lastAction === 'CLOSE') return 'CLOSED';
  return lastAction === 'ACK' ? 'ACK' : 'OPEN';
}

// GET /audit/alerts - เรียงใหม่ -> เก่า
async function listAlerts(pool, { status, ruleCode, from, to, actorSub, cursor, limit }) {
  const conditions = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (status) add(`${STATUS_SQL} = ?`, status);
  if (ruleCode) add('a.rule_code = ?', ruleCode);
  if (from) add('a.detected_at >= ?', from);
  if (to) add('a.detected_at <= ?', to);
  if (actorSub) add('a.actor_sub = ?', actorSub);
  if (cursor) add('a.alert_id < ?', cursor);
  params.push(limit + 1);

  const { rows } = await pool.query(
    `SELECT a.alert_id, a.rule_code, a.severity, a.actor_sub, a.actor_client, a.window_start, a.window_end,
            a.metric_count, a.threshold, a.details, a.detected_at,
            ${STATUS_SQL} AS status, la.actor_sub AS last_action_by, la.created_at AS last_action_at, la.note AS last_action_note
     FROM audit.access_alert a
     ${LAST_ACTION_JOIN}
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY a.alert_id DESC
     LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const data = page.map((r) => ({
    alertId: Number(r.alert_id),
    ruleCode: r.rule_code,
    severity: r.severity,
    status: r.status,
    actorSub: r.actor_sub,
    actorClient: r.actor_client,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    metricCount: r.metric_count,
    threshold: r.threshold,
    details: r.details,
    detectedAt: r.detected_at,
    lastActionBy: r.last_action_by ?? null,
    // nullable แบบ array ([string, 'null']) ต้องแปลง Date เป็น ISO string เอง (validator แปลงให้เฉพาะ type: string เดี่ยวๆ)
    lastActionAt: r.last_action_at ? r.last_action_at.toISOString() : null,
    lastActionNote: r.last_action_note === null || r.last_action_note === undefined ? null : redactPidText(r.last_action_note),
  }));
  return { data, page: { nextCursor: hasMore ? String(page[page.length - 1].alert_id) : null, limit } };
}

// POST /audit/alerts/{alertId}/ack | /close
//  - ACK ได้เฉพาะ alert ที่ยัง OPEN; CLOSE ได้จาก OPEN หรือ ACK; CLOSED แล้วทำอะไรต่อไม่ได้ (409) ไม่มีการเปิดใหม่ (alert ใหม่จะเกิดเองเมื่อพฤติกรรมเกิดซ้ำ
//    ใน bucket ถัดไป)
//  - CLOSE ต้องมี note; note ห้ามมีเลข 13 หลัก
//  - ห้ามรับทราบ/ปิด alert ที่ตนเองเป็นผู้ถูกแจ้งเตือน (actor_sub ตรงกัน): ผู้ตรวจต้องเป็นอิสระจากผู้ถูกตรวจ (หลักเดียวกับการรีวิวการเปิด pid)
async function actOnAlert(pool, alertId, { action, note }, reviewer) {
  const cleanNote = typeof note === 'string' ? note.trim() : '';
  if (action === 'CLOSE' && cleanNote.length === 0) {
    throw new HttpProblem(422, 'note-required', 'ต้องระบุหมายเหตุ', 'การปิดเรื่องต้องระบุเหตุผล/ผลการตรวจสอบ');
  }
  if (cleanNote.length > NOTE_MAX) {
    throw new HttpProblem(422, 'note-too-long', 'หมายเหตุยาวเกินไป', `note ยาวได้ไม่เกิน ${NOTE_MAX} ตัวอักษร`);
  }
  if (containsPidLike(cleanNote)) {
    throw new HttpProblem(422, 'note-contains-pid', 'หมายเหตุมีเลขบัตรประชาชน', 'note ห้ามมีเลข 13 หลัก');
  }

  return withTransaction(pool, async (client) => {
    // serialize การกระทำต่อ alert เดียวกัน (mdm_app ไม่มีสิทธิ์ UPDATE จึงใช้ SELECT ... FOR UPDATE ล็อกแถว alert ไม่ได้)
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`access_alert:${alertId}`]);

    const { rows } = await client.query(
      `SELECT a.actor_sub, la.action AS last_action
       FROM audit.access_alert a
       ${LAST_ACTION_JOIN}
       WHERE a.alert_id = $1`,
      [alertId]
    );
    if (rows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบการแจ้งเตือน', 'ไม่พบ alert ตาม alertId ที่ระบุ');

    if (rows[0].actor_sub && rows[0].actor_sub === reviewer.sub) {
      throw new HttpProblem(403, 'self-alert-forbidden', 'ดำเนินการกับ alert ของตนเองไม่ได้', 'alert นี้เกิดจากการเข้าถึงของบัญชีคุณเอง ต้องให้ผู้อื่นที่เป็นอิสระรับทราบ/ปิดเรื่อง');
    }
    const current = statusOf(rows[0].last_action);
    if (current === 'CLOSED') throw new HttpProblem(409, 'already-closed', 'alert ถูกปิดไปแล้ว', 'alert ที่ปิดแล้วดำเนินการต่อไม่ได้');
    if (action === 'ACK' && current === 'ACK') throw new HttpProblem(409, 'already-acknowledged', 'alert ถูกรับทราบไปแล้ว', 'ปิดเรื่องได้เลยโดยไม่ต้องรับทราบซ้ำ');

    const { rows: inserted } = await client.query(
      `INSERT INTO audit.access_alert_action (alert_id, action, note, actor_sub, actor_client)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING action_id, alert_id, action, note, actor_sub, created_at`,
      [alertId, action, cleanNote || null, reviewer.sub, reviewer.azp ?? null]
    );
    const r = inserted[0];
    return {
      actionId: Number(r.action_id),
      alertId: Number(r.alert_id),
      action: r.action,
      note: r.note,
      actorSub: r.actor_sub,
      createdAt: r.created_at,
      status: statusOf(r.action),
    };
  });
}

module.exports = { listAlerts, actOnAlert, ALERT_STATUSES };
