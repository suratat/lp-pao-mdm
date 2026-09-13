// ประกอบ object รูปร่างตาม schema Person ของ OpenAPI จากแถว DB (snake_case หลายตาราง) - ใช้ร่วมกันทุก
// endpoint ที่คืน Person (getPerson/getMe/provisionPerson/deactivate/reactivate/listStalePersons ฯลฯ)
// เพื่อไม่ให้ logic การประกอบ response กระจัดกระจาย/ไม่ตรงกันระหว่าง endpoint

const PHOTO_BASE_URL = process.env.PUBLIC_API_BASE_URL || 'https://mdm.lp-pao.go.th/api/v1';

async function loadPersonAggregate(pool, personId) {
  const { rows } = await pool.query(
    `SELECT
       p.person_id, p.status, p.version, p.updated_at, p.verification_status, p.thaid_verified_at, p.claimed_at,
       p.expected_first_name_th, p.expected_last_name_th, p.deleted_at,
       pi.title_th, pi.first_name_th, pi.middle_name_th, pi.last_name_th,
       pi.title_en, pi.first_name_en, pi.last_name_en,
       pi.birth_date, pi.gender,
       pi.reg_house_no, pi.reg_moo, pi.reg_soi, pi.reg_road,
       pi.reg_subdistrict_code, pi.reg_district_code, pi.reg_province_code, pi.reg_address_text,
       pi.id_card_issue_date, pi.id_card_expire_date, pi.ial, pi.synced_at,
       pc.mobile_phone, pc.phone_alt, pc.email_personal, pc.line_id, pc.same_as_registered,
       pc.cur_house_no, pc.cur_moo, pc.cur_soi, pc.cur_road,
       pc.cur_address_text, pc.cur_subdistrict_code, pc.cur_district_code, pc.cur_province_code, pc.cur_postcode,
       pc.updated_by AS contact_updated_by, pc.updated_at AS contact_updated_at
     FROM mdm.person p
     LEFT JOIN mdm.person_identity pi ON pi.person_id = p.person_id
     LEFT JOIN mdm.person_contact pc ON pc.person_id = p.person_id
     WHERE p.person_id = $1`,
    [personId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  const { rows: emergencyContacts } = await pool.query(
    `SELECT full_name, relationship, phone, priority FROM mdm.emergency_contact
     WHERE person_id = $1 ORDER BY priority`,
    [personId]
  );

  const { rows: employmentRows } = await pool.query(
    `SELECT
       e.employment_id, e.employee_no, e.personnel_type, e.level_code, e.appointed_date,
       e.effective_from, e.effective_to, e.is_current, e.employment_status, e.separation_date,
       e.email_work, e.hr_source_ref, e.updated_at,
       pos.position_id, pos.position_no, pos.title_th AS position_title_th, pos.line_of_work,
       pos.position_type, pos.is_active AS position_is_active,
       ou.org_unit_id, ou.code AS org_unit_code, ou.name_th AS org_unit_name_th,
       parent_ou.name_th AS org_unit_parent_name_th
     FROM mdm.employment e
     JOIN mdm.position pos ON pos.position_id = e.position_id
     JOIN mdm.org_unit ou ON ou.org_unit_id = e.org_unit_id
     LEFT JOIN mdm.org_unit parent_ou ON parent_ou.org_unit_id = ou.parent_id
     WHERE e.person_id = $1 AND e.is_current = true`,
    [personId]
  );

  return {
    person: row,
    identity: row.first_name_th != null || row.synced_at != null ? row : null,
    contact: row.contact_updated_at != null || row.mobile_phone != null ? row : null,
    emergencyContacts,
    employment: employmentRows[0] || null,
  };
}

function presentOrgUnitRef(row) {
  if (!row || !row.org_unit_id) return undefined;
  const ref = { orgUnitId: row.org_unit_id, code: row.org_unit_code, nameTh: row.org_unit_name_th };
  if (row.org_unit_parent_name_th) ref.parentNameTh = row.org_unit_parent_name_th;
  return ref;
}

function presentEmployment(employment) {
  if (!employment) return undefined;
  return {
    employmentId: employment.employment_id,
    employeeNo: employment.employee_no,
    personnelType: employment.personnel_type,
    position: {
      positionId: employment.position_id,
      positionNo: employment.position_no,
      titleTh: employment.position_title_th,
      lineOfWork: employment.line_of_work ?? undefined,
      positionType: employment.position_type,
      orgUnitId: employment.org_unit_id,
      isActive: employment.position_is_active,
    },
    orgUnit: presentOrgUnitRef(employment),
    levelCode: employment.level_code ?? undefined,
    appointedDate: employment.appointed_date ?? undefined,
    effectiveFrom: employment.effective_from,
    effectiveTo: employment.effective_to,
    isCurrent: employment.is_current,
    employmentStatus: employment.employment_status,
    separationDate: employment.separation_date,
    emailWork: employment.email_work,
    hrSourceRef: employment.hr_source_ref,
    updatedAt: employment.updated_at,
  };
}

function presentEmergencyContacts(rows) {
  return rows.map((r) => ({ fullName: r.full_name, relationship: r.relationship, phone: r.phone, priority: r.priority }));
}

function presentContact(contact) {
  if (!contact) return undefined;
  return {
    mobilePhone: contact.mobile_phone,
    phoneAlt: contact.phone_alt,
    emailPersonal: contact.email_personal,
    lineId: contact.line_id,
    sameAsRegistered: contact.same_as_registered,
    currentAddress: {
      // Address.houseNo/moo/soi/road/postcode/fullText เป็น {type: string} ไม่ nullable - ตัดออกเมื่อไม่มีค่า
      houseNo: contact.cur_house_no ?? undefined,
      moo: contact.cur_moo ?? undefined,
      soi: contact.cur_soi ?? undefined,
      road: contact.cur_road ?? undefined,
      subdistrict: contact.cur_subdistrict_code ? { code: contact.cur_subdistrict_code } : undefined,
      district: contact.cur_district_code ? { code: contact.cur_district_code } : undefined,
      province: contact.cur_province_code ? { code: contact.cur_province_code } : undefined,
      postcode: contact.cur_postcode ?? undefined,
      fullText: contact.cur_address_text ?? undefined,
    },
    updatedAt: contact.contact_updated_at,
    updatedBy: contact.contact_updated_by,
  };
}

function presentPerson(aggregate) {
  const { person, identity, contact, emergencyContacts, employment } = aggregate;

  // ฟิลด์ต่อไปนี้เป็น {type: string} เฉยๆ ใน OpenAPI (ไม่ nullable) และไม่ได้อยู่ใน required - ถ้าคอลัมน์
  // เป็น NULL จริง (เช่น ยังไม่กรอก titleEn, ยังไม่มี levelCode) ต้องตัดฟิลด์ออกทั้ง key (undefined) ไม่ใช่
  // ส่ง null ตรงๆ มิฉะนั้น response validation ของ express-openapi-validator จะปฏิเสธ (ตามหลักการเดียวกับ
  // hard rule ข้อ 5: "ตัดฟิลด์ที่ไม่มีค่าออก ไม่ใส่ null")
  const basic = {
    titleTh: identity?.title_th ?? undefined,
    firstNameTh: identity?.first_name_th ?? person.expected_first_name_th ?? undefined,
    lastNameTh: identity?.last_name_th ?? person.expected_last_name_th ?? undefined,
    titleEn: identity?.title_en ?? undefined,
    firstNameEn: identity?.first_name_en ?? undefined,
    lastNameEn: identity?.last_name_en ?? undefined,
    employeeNo: employment?.employee_no ?? undefined,
    personnelType: employment?.personnel_type ?? undefined,
    positionTitle: employment?.position_title_th ?? undefined,
    positionNo: employment?.position_no ?? undefined,
    levelCode: employment?.level_code ?? undefined,
    orgUnit: presentOrgUnitRef(employment),
    emailWork: employment?.email_work ?? undefined,
    photoUrl: `${PHOTO_BASE_URL}/persons/${person.person_id}/photo`,
  };

  const result = {
    personId: person.person_id,
    status: person.status,
    version: person.version,
    updatedAt: person.updated_at,
    basic,
    verification: {
      verificationStatus: person.verification_status,
      // thaidVerifiedAt/claimedAt เป็น {type: [string,'null'], format: date-time} (nullable แบบ JSON-Schema
      // array) - express-openapi-validator serialize Date->ISOString ให้อัตโนมัติเฉพาะ {type: string}
      // เดี่ยวๆ เท่านั้น (ดู schema.preprocessor.js: handleSerDes เช็ค schema.type === 'string' ตรงๆ) กรณี
      // nullable แบบนี้ต้องแปลงเป็น string เองก่อนส่ง มิฉะนั้น Date object ที่ pg driver คืนมาจะไม่ผ่าน
      // response validation (ต่างจาก updatedAt/syncedAt ด้านบนที่ไม่ nullable จึงได้รับการแปลงอัตโนมัติ)
      thaidVerifiedAt: person.thaid_verified_at ? person.thaid_verified_at.toISOString() : null,
      claimedAt: person.claimed_at ? person.claimed_at.toISOString() : null,
    },
  };

  if (identity) {
    result.identity = {
      middleNameTh: identity.middle_name_th,
      birthDate: identity.birth_date,
      gender: identity.gender,
      registeredAddress: {
        houseNo: identity.reg_house_no ?? undefined,
        moo: identity.reg_moo ?? undefined,
        soi: identity.reg_soi ?? undefined,
        road: identity.reg_road ?? undefined,
        subdistrict: identity.reg_subdistrict_code ? { code: identity.reg_subdistrict_code } : undefined,
        district: identity.reg_district_code ? { code: identity.reg_district_code } : undefined,
        province: identity.reg_province_code ? { code: identity.reg_province_code } : undefined,
        fullText: identity.reg_address_text ?? undefined,
      },
      idCardIssueDate: identity.id_card_issue_date,
      idCardExpireDate: identity.id_card_expire_date,
      ial: identity.ial,
      syncedAt: identity.synced_at,
    };
  }

  const presentedContact = presentContact(contact);
  if (presentedContact) result.contact = presentedContact;

  if (emergencyContacts.length > 0) result.emergencyContacts = presentEmergencyContacts(emergencyContacts);

  const presentedEmployment = presentEmployment(employment);
  if (presentedEmployment) result.employment = presentedEmployment;

  return result;
}

async function loadAndPresentPerson(pool, personId) {
  const aggregate = await loadPersonAggregate(pool, personId);
  if (!aggregate) return null;
  return presentPerson(aggregate);
}

module.exports = {
  loadPersonAggregate,
  presentPerson,
  presentEmergencyContacts,
  presentContact,
  presentEmployment,
  loadAndPresentPerson,
};
