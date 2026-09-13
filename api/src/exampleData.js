// ข้อมูลตัวอย่างสำหรับ stub handler ของ T2 (API skeleton) - ใช้ยืนยัน response ตรงตาม schema ใน
// OpenAPI เท่านั้น ไม่ใช่ business logic จริง (ของจริงมาใน T3-T5 ตามลำดับงานใน CLAUDE.md)
const {
  FIXTURE_PERSON_ID,
  FIXTURE_ORG_UNIT_ID,
  FIXTURE_PARENT_ORG_UNIT_ID,
  FIXTURE_POSITION_ID,
} = require('./constants');

function exampleAddress() {
  return {
    houseNo: '99/1',
    moo: '4',
    soi: '',
    road: 'ถนนพหลโยธิน',
    subdistrict: { code: '520101', nameTh: 'เวียงเหนือ' },
    district: { code: '5201', nameTh: 'เมืองลำปาง' },
    province: { code: '52', nameTh: 'ลำปาง' },
    postcode: '52000',
    fullText: '99/1 หมู่ 4 ถนนพหลโยธิน ตำบลเวียงเหนือ อำเภอเมืองลำปาง จังหวัดลำปาง 52000',
  };
}

function exampleOrgUnitRef() {
  return {
    orgUnitId: FIXTURE_ORG_UNIT_ID,
    code: 'PERSONNEL-ADMIN',
    nameTh: 'ฝ่ายบริหารงานทั่วไป',
    parentNameTh: 'กองการเจ้าหน้าที่',
  };
}

function exampleEmployment() {
  const now = new Date().toISOString();
  return {
    employmentId: '22222222-2222-2222-2222-222222222222',
    employeeNo: 'EMP-0001',
    personnelType: 'CIVIL_SERVANT',
    position: {
      positionId: FIXTURE_POSITION_ID,
      positionNo: 'POS-0002',
      titleTh: 'นักทรัพยากรบุคคลชำนาญการ',
      lineOfWork: 'บริหารงานบุคคล',
      positionType: 'ACADEMIC',
      orgUnitId: FIXTURE_ORG_UNIT_ID,
      isActive: true,
    },
    orgUnit: exampleOrgUnitRef(),
    levelCode: 'ชำนาญการ',
    appointedDate: '2015-10-01',
    effectiveFrom: '2015-10-01',
    effectiveTo: null,
    isCurrent: true,
    employmentStatus: 'ACTIVE',
    separationDate: null,
    emailWork: 'test.system@lp-pao.go.th',
    hrSourceRef: null,
    updatedAt: now,
  };
}

function examplePerson(personId = FIXTURE_PERSON_ID) {
  const now = new Date().toISOString();
  return {
    personId,
    status: 'ACTIVE',
    version: 1,
    updatedAt: now,
    basic: {
      titleTh: 'นาย',
      firstNameTh: 'ทดสอบ',
      lastNameTh: 'ระบบ',
      titleEn: 'Mr.',
      firstNameEn: 'Test',
      lastNameEn: 'System',
      employeeNo: 'EMP-0001',
      personnelType: 'CIVIL_SERVANT',
      positionTitle: 'นักทรัพยากรบุคคลชำนาญการ',
      positionNo: 'POS-0002',
      levelCode: 'ชำนาญการ',
      orgUnit: exampleOrgUnitRef(),
      emailWork: 'test.system@lp-pao.go.th',
      photoUrl: `https://mdm.lp-pao.go.th/api/v1/persons/${personId}/photo`,
    },
    verification: {
      verificationStatus: 'VERIFIED',
      thaidVerifiedAt: now,
      claimedAt: now,
    },
    identity: {
      middleNameTh: null,
      birthDate: '1990-01-01',
      gender: 'M',
      registeredAddress: exampleAddress(),
      idCardIssueDate: '2020-01-01',
      idCardExpireDate: '2030-01-01',
      ial: '2.3',
      syncedAt: now,
    },
    contact: {
      mobilePhone: '0812345678',
      phoneAlt: null,
      emailPersonal: 'test.system@example.com',
      lineId: null,
      sameAsRegistered: true,
      currentAddress: exampleAddress(),
      updatedAt: now,
      updatedBy: 'SELF',
    },
    emergencyContacts: [{ fullName: 'นางสมมติ ระบบ', relationship: 'คู่สมรส', phone: '0898765432', priority: 1 }],
    employment: exampleEmployment(),
  };
}

function examplePageInfo() {
  return { nextCursor: null, limit: 50 };
}

function exampleOrgUnit() {
  return {
    orgUnitId: FIXTURE_ORG_UNIT_ID,
    parentId: FIXTURE_PARENT_ORG_UNIT_ID,
    code: 'PERSONNEL-ADMIN',
    nameTh: 'ฝ่ายบริหารงานทั่วไป',
    nameEn: 'General Administration Division',
    unitLevel: 'SECTION',
    isActive: true,
  };
}

function examplePosition() {
  return {
    positionId: FIXTURE_POSITION_ID,
    positionNo: 'POS-0002',
    titleTh: 'นักทรัพยากรบุคคลชำนาญการ',
    lineOfWork: 'บริหารงานบุคคล',
    positionType: 'ACADEMIC',
    orgUnitId: FIXTURE_ORG_UNIT_ID,
    isActive: true,
  };
}

function exampleClaimRequest() {
  const now = new Date().toISOString();
  return {
    claimRequestId: '33333333-3333-3333-3333-333333333333',
    displayName: 'นายทดสอบ ไม่พบระเบียน',
    status: 'PENDING_HR',
    attemptCount: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    resolvedPersonId: null,
    resolvedBy: null,
    resolvedAt: null,
  };
}

function exampleConsent() {
  return {
    purposeCode: 'DIRECTORY_PUBLISH',
    purposeNameTh: 'เผยแพร่ทำเนียบบุคลากรสาธารณะ',
    legalBasis: 'CONSENT',
    requiresConsent: true,
    status: null,
    policyVersion: null,
    grantedAt: null,
    withdrawnAt: null,
  };
}

function exampleChangeLogEntry() {
  return {
    logId: 1,
    changedAt: new Date().toISOString(),
    fieldKey: 'identity.reg_address_text',
    oldValue: null,
    newValue: 'ตัวอย่างค่าใหม่',
    changedBy: 'THAID_SYNC',
    actorSub: null,
    syncEventId: null,
    reason: null,
  };
}

function examplePersonnelEvent() {
  return {
    eventId: '44444444-4444-4444-4444-444444444444',
    sequence: 1,
    eventType: 'IDENTITY_UPDATED',
    personId: FIXTURE_PERSON_ID,
    occurredAt: new Date().toISOString(),
    version: 1,
    changedFields: ['identity.last_name_th'],
    data: { status: 'ACTIVE', verificationStatus: 'VERIFIED', mergedIntoPersonId: null },
  };
}

function exampleWebhookSubscription() {
  return {
    subscriptionId: '55555555-5555-5555-5555-555555555555',
    url: 'https://eoffice.lp-pao.go.th/hooks/mdm',
    eventTypes: ['PERSON_DEACTIVATED', 'EMPLOYMENT_UPDATED'],
    isActive: true,
    createdAt: new Date().toISOString(),
  };
}

function exampleWebhookDelivery() {
  return {
    deliveryId: '66666666-6666-6666-6666-666666666666',
    subscriptionId: '55555555-5555-5555-5555-555555555555',
    eventId: '44444444-4444-4444-4444-444444444444',
    status: 'DELIVERED',
    attemptCount: 1,
    nextAttemptAt: null,
    lastResponseCode: 200,
    lastError: null,
    deliveredAt: new Date().toISOString(),
  };
}

function exampleAccessLogEntry() {
  return {
    accessedAt: new Date().toISOString(),
    subjectPersonId: FIXTURE_PERSON_ID,
    actorType: 'SERVICE',
    actorSub: 'eoffice-backend',
    clientId: 'eoffice',
    endpoint: `/persons/${FIXTURE_PERSON_ID}`,
    fieldsReturned: ['personId', 'status', 'basic.firstNameTh'],
    purposeCode: 'HR_ADMIN',
    justification: null,
    requestId: '77777777-7777-7777-7777-777777777777',
    responseStatus: 200,
  };
}

function exampleImportResult() {
  return { mode: 'DRY_RUN', total: 0, created: 0, updated: 0, unchanged: 0, errors: [] };
}

module.exports = {
  exampleAddress,
  exampleOrgUnitRef,
  exampleEmployment,
  examplePerson,
  examplePageInfo,
  exampleOrgUnit,
  examplePosition,
  exampleClaimRequest,
  exampleConsent,
  exampleChangeLogEntry,
  examplePersonnelEvent,
  exampleWebhookSubscription,
  exampleWebhookDelivery,
  exampleAccessLogEntry,
  exampleImportResult,
};
