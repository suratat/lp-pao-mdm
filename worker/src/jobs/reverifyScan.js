const { withTransaction } = require('../db/transaction');

// นโยบาย re-verify ตามค่าเริ่มต้นที่แนะนำใน §3.2 - เอกสารพูดถึง "ตั้งค่าได้ใน mdm_setting" แต่ไม่มี
// ตารางนี้อยู่ใน ER/migration ใดๆ ของ T1 เลย จึงตั้งเป็นค่าคงที่ปรับผ่าน env แทนสำหรับตอนนี้
// (การสร้างระบบตั้งค่าเต็มรูปแบบไม่อยู่ในขอบเขตงานที่ระบุของ T4)
const DEFAULTS = {
  reverifyMaxAgeDays: Number(process.env.REVERIFY_MAX_AGE_DAYS) || 180,
  reverifyOnCardExpiryDays: Number(process.env.REVERIFY_ON_CARD_EXPIRY_DAYS) || 60,
  graceDays: Number(process.env.GRACE_DAYS) || 30,
};

// Phase A ของ seq-02: หา record ที่ครบกำหนด -> STALE + ตัด session ที่ check -> outbox VERIFICATION_STALE
// แต่ละคนอยู่ในธุรกรรมสั้นของตัวเอง (claim ด้วย FOR UPDATE SKIP LOCKED กันหลาย worker ชนกัน) แล้วค่อยเรียก
// check.lp-pao.go.th "หลัง" commit เพื่อไม่ให้ external call ที่ล้มเหลวทำให้ทั้ง batch rollback
async function runReverifyScan({ pool, checkClient, now = () => new Date(), config = DEFAULTS, batchSize = 500 }) {
  const nowDate = now();

  const { rows: candidates } = await pool.query(
    `SELECT p.person_id
     FROM mdm.person p
     JOIN mdm.person_identity pi ON pi.person_id = p.person_id
     WHERE p.status = 'ACTIVE' AND p.verification_status = 'VERIFIED'
       AND (
         p.thaid_verified_at < $1::timestamptz - ($2 || ' days')::interval
         OR pi.id_card_expire_date < ($1::date + ($3 || ' days')::interval)
         OR p.reverify_requested_at IS NOT NULL
       )
     ORDER BY p.person_id
     LIMIT $4`,
    [nowDate, config.reverifyMaxAgeDays, config.reverifyOnCardExpiryDays, batchSize]
  );

  let staleCount = 0;

  for (const { person_id: personId } of candidates) {
    const claimed = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT version, status FROM mdm.person
         WHERE person_id = $1 AND status = 'ACTIVE' AND verification_status = 'VERIFIED'
         FOR UPDATE SKIP LOCKED`,
        [personId]
      );
      if (rows.length === 0) return false; // คนอื่นหยิบไปแล้ว หรือสถานะเปลี่ยนไปแล้วตั้งแต่ SELECT รอบแรก

      await client.query(
        `UPDATE mdm.person
         SET verification_status = 'STALE', reverify_due_at = $2::timestamptz + ($3 || ' days')::interval
         WHERE person_id = $1`,
        [personId, nowDate, config.graceDays]
      );

      await client.query(
        `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
         VALUES ($1, 'VERIFICATION_STALE', '[]'::jsonb, $2, $3)`,
        [
          personId,
          JSON.stringify({ personId, version: rows[0].version, status: rows[0].status, verificationStatus: 'STALE' }),
          rows[0].version,
        ]
      );

      return true;
    });

    if (!claimed) continue;
    staleCount++;

    try {
      await checkClient.revokeSessions(personId);
    } catch {
      // best-effort: ไม่ทำให้การเปลี่ยนสถานะเป็น STALE ย้อนกลับ - ยังไม่ implement retry ของขั้นตอนนี้
      // (Keycloak logout และการแจ้งเตือนอีเมล/LINE ก็ยังไม่ implement เช่นกัน ดูสรุปงาน T4)
    }
  }

  return { staleCount };
}

module.exports = { runReverifyScan, DEFAULTS };
