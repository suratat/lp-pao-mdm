// job access-anomaly-scan (pg-boss, ทุก 5 นาที): ตรวจ audit.access_log ตามกฎแล้วเขียน audit.access_alert
//
// ทุก query มี predicate ช่วง accessed_at (partition pruning ของ access_log รายเดือน + ไม่สแกนทั้งตาราง) และกรองเฉพาะ client ใน
// ANOMALY_MONITORED_CLIENTS (คนล็อกอินผ่าน console เท่านั้น ไม่รวม token ของระบบ เช่น check-broker/migrate-tool)
// กันซ้ำด้วย dedupe_key (INSERT ... ON CONFLICT DO NOTHING) - รันซ้ำ/ช่วงซ้อนกันกี่ครั้งก็ได้ alert เดิมเพียงหนึ่งแถว และ "คืนเฉพาะแถวที่เพิ่งสร้างจริง"
// (RETURNING) ให้ส่ง Telegram เฉพาะ alert ใหม่ - ส่งไม่สำเร็จจะไม่ส่งซ้ำ (ยอมรับ at-most-once: ไม่ต้อง UPDATE ตารางใน schema audit)
//
// นิยามแถวที่นับ (ตรงกับที่ api/src/middleware/accessLog.js เขียน):
//  - BULK_VIEW  : เปิดดูบุคคลรายคน = endpoint มี /persons/<uuid> นับ DISTINCT subject_person_id ต่อ actor+client ในหน้าต่าง W นาที
//                 ไม่นับแถวของ searchPersons (endpoint /persons?... ไม่มี uuid - ผลค้นหา 1 หน้าเขียนได้ถึง 100 แถว) และไม่นับ response >= 400
//  - PID_REVEAL_FREQUENT: POST /persons/<uuid>/pid ที่สำเร็จ (200; แถวก่อน PR-B เป็น GET) นับจำนวนครั้งต่อ actor+client ในหน้าต่าง W นาที (นิยามเดียวกับ PID_REVEAL_SQL ใน
//                 auditService.js ของ API)
//  - OFF_HOURS  : ทุกแถวที่เกิดนอก [workStart, workEnd) จ.-ศ. เวลา Asia/Bangkok รวมเสาร์-อาทิตย์ทั้งวัน 1 alert ต่อ actor+client ต่อวัน (ตามเวลาไทย)
const OFF_HOURS_TZ = 'Asia/Bangkok';

const PERSON_DETAIL_RE = '/persons/[0-9a-fA-F-]{36}';
const PID_REVEAL_RE = '/persons/[0-9a-fA-F-]{36}/pid(\\?|$)';

// $1 = เวลาอ้างอิง (as_of), $2 = ขนาดหน้าต่าง (นาที), $3 = threshold, $4 = รายชื่อ client
const BULK_VIEW_SQL = `
  INSERT INTO audit.access_alert
    (rule_code, dedupe_key, severity, actor_sub, actor_client, window_start, window_end, metric_count, threshold, details)
  SELECT 'BULK_VIEW',
         'BULK_VIEW:' || h.client || ':' || h.actor || ':' || floor(extract(epoch FROM $1::timestamptz) / ($2::int * 60))::bigint,
         'HIGH', NULLIF(h.actor, '-'), h.client,
         $1::timestamptz - make_interval(mins => $2::int), $1::timestamptz,
         h.n, $3::int, jsonb_build_object('distinctPersons', h.n, 'windowMinutes', $2::int)
  FROM (
    SELECT al.keycloak_client_id AS client, COALESCE(al.actor_sub, '-') AS actor, count(DISTINCT al.subject_person_id)::int AS n
    FROM audit.access_log al
    WHERE al.accessed_at > $1::timestamptz - make_interval(mins => $2::int)
      AND al.accessed_at <= $1::timestamptz
      AND al.keycloak_client_id = ANY($4::text[])
      AND al.subject_person_id IS NOT NULL
      AND COALESCE(al.response_status, 200) < 400
      AND al.endpoint ~ '${PERSON_DETAIL_RE}'
    GROUP BY 1, 2
    HAVING count(DISTINCT al.subject_person_id) >= $3::int
  ) h
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING alert_id, rule_code, severity, actor_sub, actor_client, window_start, window_end, metric_count, threshold`;

const PID_REVEAL_SQL = `
  INSERT INTO audit.access_alert
    (rule_code, dedupe_key, severity, actor_sub, actor_client, window_start, window_end, metric_count, threshold, details)
  SELECT 'PID_REVEAL_FREQUENT',
         'PID_REVEAL_FREQUENT:' || h.client || ':' || h.actor || ':' || floor(extract(epoch FROM $1::timestamptz) / ($2::int * 60))::bigint,
         'HIGH', NULLIF(h.actor, '-'), h.client,
         $1::timestamptz - make_interval(mins => $2::int), $1::timestamptz,
         h.n, $3::int, jsonb_build_object('reveals', h.n, 'windowMinutes', $2::int)
  FROM (
    SELECT al.keycloak_client_id AS client, COALESCE(al.actor_sub, '-') AS actor, count(*)::int AS n
    FROM audit.access_log al
    WHERE al.accessed_at > $1::timestamptz - make_interval(mins => $2::int)
      AND al.accessed_at <= $1::timestamptz
      AND al.keycloak_client_id = ANY($4::text[])
      AND al.http_method IN ('GET', 'POST')
      AND al.response_status = 200
      AND al.endpoint ~ '${PID_REVEAL_RE}'
    GROUP BY 1, 2
    HAVING count(*) >= $3::int
  ) h
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING alert_id, rule_code, severity, actor_sub, actor_client, window_start, window_end, metric_count, threshold`;

// $1 = as_of, $2 = ย้อนหลังกี่นาที (lookback), $3 = client[], $4 = เริ่มเวลาราชการ 'HH:MM', $5 = สิ้นสุดเวลาราชการ 'HH:MM'
// local = เวลาไทยของแถว; นอกเวลา = เสาร์/อาทิตย์ (isodow 6,7) หรือเวลา < workStart หรือ >= workEnd
const OFF_HOURS_SQL = `
  INSERT INTO audit.access_alert
    (rule_code, dedupe_key, severity, actor_sub, actor_client, window_start, window_end, metric_count, threshold, details)
  SELECT 'OFF_HOURS',
         'OFF_HOURS:' || h.client || ':' || h.actor || ':' || h.local_date,
         'MEDIUM', NULLIF(h.actor, '-'), h.client, h.first_at, h.last_at, h.n, 1,
         jsonb_build_object('offHoursAccesses', h.n, 'localDate', h.local_date, 'timezone', '${OFF_HOURS_TZ}', 'workStart', $4::text, 'workEnd', $5::text)
  FROM (
    SELECT al.keycloak_client_id AS client, COALESCE(al.actor_sub, '-') AS actor,
           to_char(al.accessed_at AT TIME ZONE '${OFF_HOURS_TZ}', 'YYYY-MM-DD') AS local_date,
           min(al.accessed_at) AS first_at, max(al.accessed_at) AS last_at, count(*)::int AS n
    FROM audit.access_log al
    WHERE al.accessed_at > $1::timestamptz - make_interval(mins => $2::int)
      AND al.accessed_at <= $1::timestamptz
      AND al.keycloak_client_id = ANY($3::text[])
      AND (
        extract(isodow FROM al.accessed_at AT TIME ZONE '${OFF_HOURS_TZ}') IN (6, 7)
        OR (al.accessed_at AT TIME ZONE '${OFF_HOURS_TZ}')::time < $4::text::time
        OR (al.accessed_at AT TIME ZONE '${OFF_HOURS_TZ}')::time >= $5::text::time
      )
    GROUP BY 1, 2, 3
  ) h
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING alert_id, rule_code, severity, actor_sub, actor_client, window_start, window_end, metric_count, threshold`;

const RULE_SQL = { BULK_VIEW_SQL, PID_REVEAL_SQL, OFF_HOURS_SQL };

// asOf: เวลาอ้างอิงแทนเวลาปัจจุบันของ DB (ใช้ในเทสต์) - null = now() ของ DB (ใช้นาฬิกาเดียวกับที่เขียน accessed_at)
async function runAccessAnomalyScan({ pool, config, notifier = null, asOf = null, logger = console }) {
  const asOfTs = asOf ?? (await pool.query('SELECT now() AS now')).rows[0].now;

  const created = [];
  const run = async (sql, params) => {
    const { rows } = await pool.query(sql, params);
    created.push(...rows);
  };

  await run(BULK_VIEW_SQL, [asOfTs, config.bulkView.windowMin, config.bulkView.threshold, config.monitoredClients]);
  await run(PID_REVEAL_SQL, [asOfTs, config.pidReveal.windowMin, config.pidReveal.threshold, config.monitoredClients]);
  await run(OFF_HOURS_SQL, [asOfTs, config.offHoursLookbackMin, config.monitoredClients, config.offHours.workStart, config.offHours.workEnd]);

  // ส่งเฉพาะ alert ที่เพิ่งสร้างในรอบนี้ (ON CONFLICT DO NOTHING ไม่คืนแถวที่มีอยู่แล้ว)
  if (notifier) {
    for (const alert of created) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await notifier.notify(alert);
      } catch {
        // notifier ที่ดี (telegramNotifier) ไม่ throw อยู่แล้ว - กันไว้อีกชั้นเพราะ alert ถูกบันทึกแล้วและการแจ้งเตือนล้มต้องไม่ทำให้ job ล้ม
        // (ไม่พิมพ์ error: อาจมี URL ที่มี token อยู่ในข้อความ)
        logger.error(`access-anomaly-scan: แจ้งเตือน alert ${alert.alert_id} ไม่สำเร็จ`);
      }
    }
  }

  const byRule = {};
  for (const alert of created) byRule[alert.rule_code] = (byRule[alert.rule_code] || 0) + 1;
  if (created.length > 0) logger.log(`access-anomaly-scan: สร้าง alert ใหม่ ${created.length} รายการ`, byRule);
  return { created: created.length, byRule, alerts: created };
}

module.exports = { runAccessAnomalyScan, RULE_SQL, OFF_HOURS_TZ };
