const { isValidPid, pidHash } = require('../security/pid');

const PID_KEY_NAME = 'mdm-pid';

function serviceError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ต้องมี pid, personId, หรือ externalId อย่างใดอย่างหนึ่ง (ตามคำอธิบาย EmploymentImportRow ใน OpenAPI)
// createIfMissing = true เท่านั้นที่สร้างคนใหม่ได้ และสร้างได้ผ่าน pid เท่านั้น (ตาม §5.4: "จับคู่ด้วย
// pid_hash เท่านั้น; ห้ามจับคู่ด้วยชื่อโดยอัตโนมัติ") - pid_enc เข้ารหัสตอน provision เลยตาม §3.4
// ("PENDING_CLAIM มี pid_hash/pid_enc") ไม่รอถึงตอน claim เหมือนที่ T3 ทำ (T3 เป็นเพียงเส้นทางเดียวที่
// เคยมีมาก่อนเพราะยังไม่มี provisioning endpoint จริง)
async function resolvePerson(client, vault, pepper, row, createIfMissing) {
  if (row.pid) {
    if (!isValidPid(row.pid)) {
      throw serviceError('PID_CHECKSUM_INVALID', 'pid ไม่ผ่านการตรวจ checksum (mod 11)');
    }
    const hash = pidHash(row.pid, pepper);
    const { rows } = await client.query(`SELECT person_id FROM mdm.person WHERE pid_hash = $1`, [hash]);
    if (rows.length > 0) return { personId: rows[0].person_id, isNew: false };

    if (!createIfMissing) {
      throw serviceError('PERSON_NOT_FOUND', 'ไม่พบบุคคลที่ตรงกับ pid นี้ (createIfMissing=false)');
    }

    const { rows: inserted } = await client.query(
      `INSERT INTO mdm.person (pid_hash, status, verification_status, expected_first_name_th, expected_last_name_th)
       VALUES ($1, 'PENDING_CLAIM', 'UNVERIFIED', $2, $3)
       RETURNING person_id`,
      [hash, row.expectedFirstNameTh ?? null, row.expectedLastNameTh ?? null]
    );
    const personId = inserted[0].person_id;

    const { ciphertext, keyId } = await vault.encrypt(PID_KEY_NAME, Buffer.from(row.pid, 'utf8'), personId);
    await client.query(`UPDATE mdm.person SET pid_enc = $2, key_id = $3 WHERE person_id = $1`, [
      personId,
      Buffer.from(ciphertext, 'utf8'),
      keyId,
    ]);

    return { personId, isNew: true };
  }

  if (row.personId) {
    const { rows } = await client.query(`SELECT person_id FROM mdm.person WHERE person_id = $1`, [row.personId]);
    if (rows.length === 0) throw serviceError('PERSON_NOT_FOUND', 'ไม่พบบุคคลตาม personId ที่ระบุ');
    return { personId: rows[0].person_id, isNew: false };
  }

  if (row.externalId) {
    const { rows } = await client.query(
      `SELECT person_id FROM mdm.external_identifier WHERE system_code = $1 AND external_value = $2`,
      [row.externalId.systemCode, row.externalId.value]
    );
    if (rows.length === 0) throw serviceError('PERSON_NOT_FOUND', 'ไม่พบบุคคลตาม externalId ที่ระบุ');
    return { personId: rows[0].person_id, isNew: false };
  }

  throw serviceError('MISSING_IDENTIFIER', 'ต้องมี pid, personId, หรือ externalId อย่างใดอย่างหนึ่ง');
}

function mapConstraintError(err) {
  if (err.code === '23503') {
    // foreign_key_violation
    if (err.constraint?.includes('position')) return serviceError('POSITION_NOT_FOUND', 'ไม่พบตำแหน่งที่ระบุ');
    if (err.constraint?.includes('org_unit')) return serviceError('ORG_UNIT_NOT_FOUND', 'ไม่พบสังกัดที่ระบุ');
    if (err.constraint?.includes('personnel_type')) {
      return serviceError('PERSONNEL_TYPE_INVALID', 'ประเภทบุคลากรไม่ถูกต้อง');
    }
  }
  if (err.code === '23P01') {
    // exclusion_violation
    return serviceError('DUPLICATE_POSITION', 'ตำแหน่งนี้มีผู้ครองอยู่แล้วในช่วงเวลาที่ระบุ');
  }
  if (err.code === '23505') {
    // unique_violation
    return serviceError('DUPLICATE_EMPLOYEE_NO', 'เลขประจำตัวนี้ถูกใช้กับบุคลากรอื่นที่เป็น current อยู่แล้ว');
  }
  return err;
}

// เทียบ current employment เดิมกับที่ import มา - เปลี่ยนแปลงจริงหรือไม่ (เพื่อนับ updated/unchanged)
function employmentChanged(current, incoming) {
  if (!current) return true;
  return (
    current.employee_no !== incoming.employeeNo ||
    current.personnel_type !== incoming.personnelType ||
    current.position_id !== incoming.positionId ||
    current.org_unit_id !== incoming.orgUnitId ||
    (current.level_code ?? null) !== (incoming.levelCode ?? null)
  );
}

// ปิด record เดิม (effectiveTo) เปิดใหม่ (เก็บประวัติ) เหมือน PUT /persons/{id}/employment ตาม §2.1
async function upsertEmployment(client, personId, employment) {
  const { rows } = await client.query(`SELECT * FROM mdm.employment WHERE person_id = $1 AND is_current = true`, [
    personId,
  ]);
  const current = rows[0] || null;

  if (!employmentChanged(current, employment)) return false;

  try {
    if (current) {
      await client.query(`UPDATE mdm.employment SET is_current = false, effective_to = $2 WHERE employment_id = $1`, [
        current.employment_id,
        employment.effectiveFrom,
      ]);
    }

    await client.query(
      `INSERT INTO mdm.employment
        (person_id, employee_no, personnel_type, position_id, org_unit_id, level_code, appointed_date,
         effective_from, is_current, employment_status, email_work, hr_source_ref, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, 'ACTIVE', $9, $10, 'HR_IMPORT')`,
      [
        personId,
        employment.employeeNo,
        employment.personnelType,
        employment.positionId,
        employment.orgUnitId,
        employment.levelCode ?? null,
        employment.appointedDate ?? null,
        employment.effectiveFrom,
        employment.emailWork ?? null,
        null,
      ]
    );
  } catch (err) {
    throw mapConstraintError(err);
  }

  return true;
}

// ประมวลผลแถวเดียวในธุรกรรมของตัวเอง (แถวอื่นบันทึกได้ตามปกติแม้แถวนี้ผิดพลาด ตามคำอธิบาย operation นี้)
// DRY_RUN รันจริงผ่าน SQL เดียวกันทั้งหมดแล้ว ROLLBACK แทน COMMIT - ตรวจ FK/EXCLUDE/UNIQUE ได้แม่นยำ
// เหมือนของจริงโดยไม่มีผลข้างเคียง
async function processRow({ pool, vault, pepper, mode, createIfMissing }, row) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const person = await resolvePerson(client, vault, pepper, row, createIfMissing);
    const changed = row.employment ? await upsertEmployment(client, person.personId, row.employment) : false;

    await client.query(mode === 'DRY_RUN' ? 'ROLLBACK' : 'COMMIT');

    if (person.isNew) return 'created';
    return changed ? 'updated' : 'unchanged';
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function importEmploymentBatch({ pool, vault, pepper }, { mode, createIfMissing = false, rows }) {
  const result = { mode, total: rows.length, created: 0, updated: 0, unchanged: 0, errors: [] };

  for (const row of rows) {
    try {
      const outcome = await processRow({ pool, vault, pepper, mode, createIfMissing }, row);
      result[outcome] += 1;
    } catch (err) {
      result.errors.push({
        rowRef: row.rowRef,
        code: err.code || 'UNKNOWN_ERROR',
        message: err.message,
      });
    }
  }

  return result;
}

module.exports = { importEmploymentBatch };
