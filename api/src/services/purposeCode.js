// §2.2: "เขียน access_log พร้อม fields_returned ที่ส่งจริง และ purpose_code จาก consumer_system ของ azp"
async function resolvePurposeCode(pool, azp) {
  if (!azp) return null;
  const { rows } = await pool.query(`SELECT purpose_code FROM mdm.consumer_system WHERE keycloak_client_id = $1`, [
    azp,
  ]);
  return rows[0]?.purpose_code || null;
}

module.exports = { resolvePurposeCode };
