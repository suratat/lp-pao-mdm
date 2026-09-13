const { HttpProblem } = require('../security/httpProblem');
const { resolvePurposeCode } = require('./purposeCode');

const PID_KEY_NAME = 'mdm-pid';

// ภาคผนวก ข: "การถอดรหัสทำในservice เดียว (PidService.reveal) ที่เขียน access_log ก่อนคืนค่า ไม่มี path อื่น"
async function reveal({ pool, vault }, { personId, actor, justification, requestMeta }) {
  const { rows } = await pool.query(`SELECT pid_enc FROM mdm.person WHERE person_id = $1`, [personId]);
  if (rows.length === 0 || !rows[0].pid_enc) {
    throw new HttpProblem(404, 'not-found', 'ไม่พบข้อมูล', 'ไม่พบบุคคลนี้ หรือยังไม่เคยเข้ารหัส pid');
  }

  const ciphertext = Buffer.from(rows[0].pid_enc).toString('utf8');
  const plaintext = await vault.decrypt(PID_KEY_NAME, ciphertext, personId);
  const pid = plaintext.toString('utf8');

  const purposeCode = await resolvePurposeCode(pool, actor.azp);
  await pool.query(
    `INSERT INTO audit.access_log
      (subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method,
       fields_returned, purpose_code, justification, request_id, client_ip, response_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      personId,
      actor.personId ? 'USER' : 'SERVICE',
      actor.sub || null,
      actor.azp || null,
      requestMeta.endpoint,
      requestMeta.httpMethod,
      JSON.stringify(['pid']),
      purposeCode,
      justification,
      requestMeta.requestId || null,
      requestMeta.clientIp || null,
      200,
    ]
  );

  return pid;
}

module.exports = { reveal };
