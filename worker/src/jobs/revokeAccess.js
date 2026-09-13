const { withTransaction } = require('../db/transaction');

// §3.4 deactivate -> revoke: ตัด session ที่ check.lp-pao.go.th และปิดบัญชี Keycloak (ถ้ามี) ทุกครั้งที่
// เกิด PERSON_DEACTIVATED - แยกจาก outboxDispatch (T4) ซึ่งดูแลเฉพาะ fan-out ไป webhook_delivery
// (เป้าหมายคนละกลุ่ม: consumer_system ภายนอก vs ระบบยืนยันตัวตนภายในของ อบจ. เอง)
async function runRevokeAccess({ pool, checkClient, keycloakClient, batchSize = 200 }) {
  const { rows: candidates } = await pool.query(
    `SELECT event_id, person_id FROM integration.outbox_event
     WHERE event_type = 'PERSON_DEACTIVATED' AND revoke_processed_at IS NULL
     ORDER BY sequence
     LIMIT $1`,
    [batchSize]
  );

  let processed = 0;

  for (const { event_id: eventId, person_id: personId } of candidates) {
    const claimed = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT event_id FROM integration.outbox_event
         WHERE event_id = $1 AND revoke_processed_at IS NULL
         FOR UPDATE SKIP LOCKED`,
        [eventId]
      );
      if (rows.length === 0) return false;

      await client.query(`UPDATE integration.outbox_event SET revoke_processed_at = now() WHERE event_id = $1`, [
        eventId,
      ]);
      return true;
    });

    if (!claimed) continue;
    processed += 1;

    try {
      await checkClient.revokeSessions(personId);
    } catch {
      // best-effort (ดูเหตุผลเดียวกับ reverifyScan.js) - ไม่ retry ในเวอร์ชันนี้
    }

    try {
      const { rows: keycloakIds } = await pool.query(
        `SELECT external_value FROM mdm.external_identifier WHERE person_id = $1 AND system_code = 'KEYCLOAK'`,
        [personId]
      );
      // บุคลากรส่วนใหญ่ไม่มีบัญชี Keycloak (มีเฉพาะผู้ใช้ HR/DPO console ตามภาคผนวก ก) - ข้ามถ้าไม่พบ
      if (keycloakIds.length > 0) {
        await keycloakClient.disableAndLogout(keycloakIds[0].external_value);
      }
    } catch {
      // best-effort เช่นกัน
    }
  }

  return { processed };
}

module.exports = { runRevokeAccess };
