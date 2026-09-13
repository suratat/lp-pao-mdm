const { HttpProblem } = require('../security/httpProblem');

// แสดงเฉพาะวัตถุประสงค์ที่ requires_consent=true (ฐาน CONSENT) - อื่นๆ ใช้ฐานหน้าที่ตามกฎหมาย/ภารกิจ
// สาธารณะ ไม่ต้องขอและถอนไม่ได้ตามคำอธิบายของ setMyConsent
async function listMyConsents(pool, personId) {
  const { rows } = await pool.query(
    `SELECT pp.purpose_code, pp.name_th, pp.legal_basis, pp.requires_consent,
            cr.status, cr.policy_version, cr.granted_at, cr.withdrawn_at
     FROM mdm.processing_purpose pp
     LEFT JOIN LATERAL (
       SELECT status, policy_version, granted_at, withdrawn_at FROM mdm.consent_record
       WHERE person_id = $1 AND purpose_code = pp.purpose_code
       ORDER BY COALESCE(granted_at, withdrawn_at) DESC LIMIT 1
     ) cr ON true
     WHERE pp.requires_consent = true AND pp.is_active = true
     ORDER BY pp.purpose_code`,
    [personId]
  );

  return rows.map((r) => ({
    purposeCode: r.purpose_code,
    purposeNameTh: r.name_th,
    legalBasis: r.legal_basis,
    requiresConsent: r.requires_consent,
    status: r.status ?? null,
    policyVersion: r.policy_version ?? null,
    // grantedAt/withdrawnAt เป็น {type: [string,'null'], format: date-time} (nullable แบบ array) - ต้อง
    // แปลง Date เป็น ISO string เอง (ดูคอมเมนต์เดียวกันใน personPresenter.js/provisioningService.js)
    grantedAt: r.granted_at ? r.granted_at.toISOString() : null,
    withdrawnAt: r.withdrawn_at ? r.withdrawn_at.toISOString() : null,
  }));
}

async function setMyConsent(pool, personId, purposeCode, { status, policyVersion }) {
  const { rows: purposeRows } = await pool.query(`SELECT * FROM mdm.processing_purpose WHERE purpose_code = $1`, [
    purposeCode,
  ]);
  if (purposeRows.length === 0) {
    throw new HttpProblem(400, 'bad-request', 'ไม่พบวัตถุประสงค์นี้', undefined);
  }
  if (purposeRows[0].legal_basis !== 'CONSENT') {
    throw new HttpProblem(
      400,
      'not-consent-based',
      'วัตถุประสงค์นี้ไม่ใช้ฐาน consent',
      'ใช้ฐานหน้าที่ตามกฎหมาย/ภารกิจสาธารณะ ไม่ต้องขอและถอนไม่ได้'
    );
  }

  const now = new Date();
  await pool.query(
    `INSERT INTO mdm.consent_record (person_id, purpose_code, policy_version, status, granted_at, withdrawn_at, channel)
     VALUES ($1, $2, $3, $4, $5, $6, 'SELF_SERVICE_PORTAL')`,
    [
      personId,
      purposeCode,
      policyVersion,
      status,
      status === 'GRANTED' ? now : null,
      status === 'WITHDRAWN' ? now : null,
    ]
  );

  return {
    purposeCode,
    purposeNameTh: purposeRows[0].name_th,
    legalBasis: purposeRows[0].legal_basis,
    requiresConsent: purposeRows[0].requires_consent,
    status,
    policyVersion,
    grantedAt: status === 'GRANTED' ? now.toISOString() : null,
    withdrawnAt: status === 'WITHDRAWN' ? now.toISOString() : null,
  };
}

module.exports = { listMyConsents, setMyConsent };
