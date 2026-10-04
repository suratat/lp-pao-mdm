const { redactPidText } = require('../security/redact');

// ทางเดียวที่อนุญาตให้เขียน audit.data_change_log (มี test ยามเฝ้าว่าไม่มีไฟล์อื่น INSERT ตารางนี้ตรงๆ)
// ทำสามอย่างที่โค้ดเดิมกระจายอยู่ 12 จุดและทำไม่ครบ:
//  1) บันทึก actor_sub + actor_client ทุกแถว (actor บังคับ - ลืมส่งแล้ว throw ดีกว่าเขียนแถวที่ไม่รู้ว่าใครทำ)
//  2) เคารพ mdm.field_policy.log_values_in_audit = false (เขียน old/new เป็น NULL เหลือแค่ชื่อฟิลด์) เช่น employment.employee_no (= pid)
//  3) ปกปิดเลข 13 หลักใน reason (ข้อความอิสระที่ผู้ใช้พิมพ์เอง)

// ค่าคงที่ระบุว่าเป็นระบบ (ไม่มีผู้ใช้คนเดียวที่รับผิดชอบแถวนั้น)
const SYSTEM_ACTORS = {
  THAID_SYNC: 'system:thaid-sync',
  HR_IMPORT: 'system:hr-import',
  WORKER: 'system:worker',
};

// token ของผู้ใช้/service ที่เรียก API ตรงๆ (req.auth) - HR/DPO ล็อกอินผ่าน hr-console ได้ sub ของผู้ใช้จริง
function actorFromAuth(auth) {
  if (!auth?.sub) throw new Error('ไม่พบ sub ของผู้เรียกใน token สำหรับบันทึก audit');
  return { sub: auth.sub, client: auth.azp ?? null };
}

// เจ้าของข้อมูลแก้ของตัวเองผ่าน portal: sub ใน Bearer token คือ service account ของ portal คนที่ทำจริงคือ person_id ใน acting assertion
function actorFromSelf(auth) {
  if (!auth?.personId) throw new Error('ไม่พบ personId ของเจ้าของข้อมูลสำหรับบันทึก audit');
  return { sub: auth.personId, client: auth.azp ?? null };
}

function systemActor(sub, client = null) {
  return { sub, client };
}

function toJsonb(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

async function shouldLogValues(client, fieldName) {
  const { rows } = await client.query(`SELECT log_values_in_audit FROM mdm.field_policy WHERE field_key = $1`, [fieldName]);
  // ฟิลด์ที่ไม่อยู่ใน field_policy (เช่น status, pid_hash ของ person) คงพฤติกรรมเดิม = บันทึกค่า
  return rows.length === 0 ? true : rows[0].log_values_in_audit !== false;
}

async function writeChangeLog(
  client,
  { personId, tableName, fieldName, oldValue = null, newValue = null, changedBy, actor, reason = null, syncEventId = null }
) {
  if (!actor?.sub) throw new Error('writeChangeLog ต้องมี actor.sub');

  const logValues = await shouldLogValues(client, fieldName);
  await client.query(
    `INSERT INTO audit.data_change_log
       (person_id, sync_event_id, table_name, field_name, old_value, new_value, changed_by, actor_sub, actor_client, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      personId,
      syncEventId,
      tableName,
      fieldName,
      logValues ? toJsonb(oldValue) : null,
      logValues ? toJsonb(newValue) : null,
      changedBy,
      actor.sub,
      actor.client ?? null,
      reason === null || reason === undefined ? null : redactPidText(reason),
    ]
  );
}

// changes = [{ fieldKey, oldValue, newValue }] จาก diffEmploymentFields / diff ของ sync
async function writeChangeLogs(client, { personId, tableName, changes, changedBy, actor, reason = null, syncEventId = null }) {
  for (const change of changes) {
    // eslint-disable-next-line no-await-in-loop
    await writeChangeLog(client, {
      personId,
      tableName,
      fieldName: change.fieldKey,
      oldValue: change.oldValue,
      newValue: change.newValue,
      changedBy,
      actor,
      reason,
      syncEventId,
    });
  }
}

module.exports = { writeChangeLog, writeChangeLogs, SYSTEM_ACTORS, actorFromAuth, actorFromSelf, systemActor };
