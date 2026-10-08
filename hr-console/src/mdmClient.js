class MdmApiError extends Error {
  constructor(status, problem) {
    super(problem?.title || `MDM API error (${status})`);
    this.status = status;
    this.problem = problem;
  }
}

// ชั้นป้องกันที่สอง: ลบ key employeeNo (เลขบัตรประชาชนเต็ม) ออกจากทุก response ที่ไม่ใช่ revealPid ก่อนคืนให้ caller
// ชั้นแรกคือ ?pidFormat=masked ที่ API ไม่ส่งเลขเต็มมาตั้งแต่ต้น - ถ้าหลุดมาก็ไม่ไปถึง view หรือ log (ลบแบบ recursive ทุกชั้น)
function stripEmployeeNo(value) {
  if (Array.isArray(value)) return value.map(stripEmployeeNo);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key !== 'employeeNo') out[key] = stripEmployeeNo(v);
    }
    return out;
  }
  return value;
}

// เรียก MDM API ด้วย access token ของผู้ใช้ hr_officer ที่ล็อกอินอยู่ตรง ๆ (ไม่ต้องมี X-Acting-Person
// เหมือน Portal เพราะ scope personnel:provision/personnel:write:employment ไม่ใช่ user context
// (personnel:self) - token ของ HR เองมี scope พวกนี้อยู่แล้วจาก client scope ของ hr-console ใน Keycloak)
function createMdmClient({ baseUrl }) {
  async function call(method, path, accessToken, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204 || res.status === 202) return null;

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // ตอบกลับที่ไม่ใช่ JSON (เช่น หน้า 502/504 ของ nginx ตอน API ล่ม): ถ้าไม่ ok ให้เป็น MdmApiError ธรรมดา (หน้าจอแสดงข้อความไทย) ไม่ใช่ SyntaxError -> 500
      if (res.ok) throw new Error('MDM API ตอบกลับที่ไม่ใช่ JSON');
    }

    if (!res.ok) {
      throw new MdmApiError(res.status, data);
    }
    return data;
  }

  function listClaimRequests(accessToken, { status, cursor, limit } = {}) {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    const query = qs.toString();
    return call('GET', `/api/v1/claim-requests${query ? `?${query}` : ''}`, accessToken);
  }

  function resolveClaimRequest(accessToken, claimRequestId, body) {
    return call('POST', `/api/v1/claim-requests/${encodeURIComponent(claimRequestId)}/resolve`, accessToken, body);
  }

  function listStalePersons(accessToken, { verificationStatus, orgUnitId, cursor, limit } = {}) {
    const qs = new URLSearchParams();
    if (verificationStatus && verificationStatus.length > 0) qs.set('verificationStatus', verificationStatus.join(','));
    if (orgUnitId) qs.set('orgUnitId', orgUnitId);
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    const query = qs.toString();
    return call('GET', `/api/v1/reverify/stale${query ? `?${query}` : ''}`, accessToken);
  }

  function requestReverify(accessToken, personId) {
    return call('POST', `/api/v1/persons/${encodeURIComponent(personId)}/reverify`, accessToken);
  }

  // T10: master data หน่วยงาน/ตำแหน่ง - อ่านใช้ personnel:read:basic, เขียนใช้ personnel:manage:reference + role
  // hr_master_data_admin (MDM API ตรวจทั้งคู่จาก access token ของผู้ใช้เอง)
  function listOrgUnits(accessToken, { activeOnly } = {}) {
    return call('GET', `/api/v1/org-units?activeOnly=${activeOnly ? 'true' : 'false'}`, accessToken);
  }

  function listPositions(accessToken, { orgUnitId, activeOnly } = {}) {
    const qs = new URLSearchParams();
    if (orgUnitId) qs.set('orgUnitId', orgUnitId);
    if (activeOnly !== undefined) qs.set('activeOnly', activeOnly ? 'true' : 'false');
    const query = qs.toString();
    return call('GET', `/api/v1/positions${query ? `?${query}` : ''}`, accessToken);
  }

  function listPositionTypes(accessToken, { activeOnly } = {}) {
    const query = activeOnly === undefined ? '' : `?activeOnly=${activeOnly ? 'true' : 'false'}`;
    return call('GET', `/api/v1/position-types${query}`, accessToken);
  }

  function createOrgUnit(accessToken, body) {
    return call('POST', '/api/v1/org-units', accessToken, body);
  }

  function updateOrgUnit(accessToken, orgUnitId, body) {
    return call('PUT', `/api/v1/org-units/${encodeURIComponent(orgUnitId)}`, accessToken, body);
  }

  function createPosition(accessToken, body) {
    return call('POST', '/api/v1/positions', accessToken, body);
  }

  function updatePosition(accessToken, positionId, body) {
    return call('PUT', `/api/v1/positions/${encodeURIComponent(positionId)}`, accessToken, body);
  }

  // งานดูข้อมูลบุคคล (อ่านอย่างเดียว): ฝัง pidFormat=masked ไว้ในฟังก์ชัน caller เลือกเองไม่ได้ และผ่าน stripEmployeeNo เสมอ
  // person_id ผ่าน encodeURIComponent; query string มีแค่ filter/q/cursor (ไม่มี pid)
  async function searchPersons(accessToken, { q, status, orgUnitId, personnelType, cursor, limit } = {}) {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (status && status.length > 0) qs.set('status', status.join(','));
    if (orgUnitId) {
      qs.set('orgUnitId', orgUnitId);
      qs.set('includeChildUnits', 'true');
    }
    if (personnelType) qs.set('personnelType', personnelType);
    if (cursor) qs.set('cursor', cursor);
    qs.set('limit', String(limit || 50));
    qs.set('pidFormat', 'masked');
    // URLSearchParams เข้ารหัสช่องว่างเป็น '+' แต่ validator ของ MDM API ปฏิเสธ '+' ใน q (400) - ใช้ %20 ให้ค้น "ชื่อ นามสกุล" ได้
    const query = qs.toString().replace(/\+/g, '%20');
    return stripEmployeeNo(await call('GET', `/api/v1/persons?${query}`, accessToken));
  }

  async function getPerson(accessToken, personId) {
    return stripEmployeeNo(await call('GET', `/api/v1/persons/${encodeURIComponent(personId)}?pidFormat=masked`, accessToken));
  }

  async function getEmployment(accessToken, personId) {
    return stripEmployeeNo(await call('GET', `/api/v1/persons/${encodeURIComponent(personId)}/employment?pidFormat=masked`, accessToken));
  }

  // เฉพาะฟังก์ชันนี้ที่คืนเลขเต็ม (GET /persons/{id}/pid - API บันทึกเหตุผลและผู้กดลง access_log) คืนแค่สตริงเลข ไม่คืน object
  // ที่มีเหตุผล ห้าม caller เก็บค่านี้ลง session/log - justification ส่งเป็น query ตามสัญญา API (server-to-server) ไม่ผ่านเบราว์เซอร์
  async function revealPid(accessToken, personId, justification) {
    const data = await call(
      'GET',
      `/api/v1/persons/${encodeURIComponent(personId)}/pid?justification=${encodeURIComponent(justification)}`,
      accessToken
    );
    return data.pid;
  }

  // PR-D3: เขียนข้อมูลบุคคลด้วยมือ (ต้อง role hr_master_data_admin - MDM API ตรวจ) เลขบัตรอยู่ใน body ของ POST /persons เท่านั้น (ไม่ผ่าน URL)
  // ผลลัพธ์ผ่าน stripEmployeeNo เหมือนทุกฟังก์ชันอ่านข้อมูลบุคคล
  async function createPerson(accessToken, body) {
    return stripEmployeeNo(await call('POST', '/api/v1/persons', accessToken, body));
  }

  async function updateEmployment(accessToken, personId, body) {
    return stripEmployeeNo(await call('PUT', `/api/v1/persons/${encodeURIComponent(personId)}/employment`, accessToken, body));
  }

  async function deactivatePerson(accessToken, personId, body) {
    return stripEmployeeNo(await call('POST', `/api/v1/persons/${encodeURIComponent(personId)}/deactivate`, accessToken, body));
  }

  async function reactivatePerson(accessToken, personId, body) {
    return stripEmployeeNo(await call('POST', `/api/v1/persons/${encodeURIComponent(personId)}/reactivate`, accessToken, body));
  }

  // ประวัติการเปลี่ยนแปลงของบุคคล (scope personnel:manage:person + role hr_master_data_admin) เรียงใหม่ -> เก่า
  function getPersonHistory(accessToken, personId, { cursor, limit } = {}) {
    const qs = new URLSearchParams();
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    const query = qs.toString();
    return call('GET', `/api/v1/persons/${encodeURIComponent(personId)}/history${query ? `?${query}` : ''}`, accessToken);
  }

  // PR-D4: หน้าแก้ข้อมูลส่วนบุคคล (scope personnel:manage:person + role hr_master_data_admin - MDM API ตรวจ) ผลลัพธ์คือ ManageProfile ล่าสุด
  // ข้อมูลติดต่อ/ผู้ติดต่อฉุกเฉินอยู่ใน body เท่านั้น ไม่เข้า URL; ห้าม caller เก็บผลลง log
  function getManageProfile(accessToken, personId) {
    return call('GET', `/api/v1/persons/${encodeURIComponent(personId)}/manage-profile`, accessToken);
  }

  function patchContact(accessToken, personId, body) {
    return call('PATCH', `/api/v1/persons/${encodeURIComponent(personId)}/contact`, accessToken, body);
  }

  function replaceEmergencyContacts(accessToken, personId, body) {
    return call('PUT', `/api/v1/persons/${encodeURIComponent(personId)}/emergency-contacts`, accessToken, body);
  }

  function patchExpectedIdentity(accessToken, personId, body) {
    return call('PATCH', `/api/v1/persons/${encodeURIComponent(personId)}/expected-identity`, accessToken, body);
  }

  return {
    getManageProfile,
    patchContact,
    replaceEmergencyContacts,
    patchExpectedIdentity,
    createPerson,
    updateEmployment,
    deactivatePerson,
    reactivatePerson,
    getPersonHistory,
    searchPersons,
    getPerson,
    getEmployment,
    revealPid,
    listClaimRequests,
    resolveClaimRequest,
    listStalePersons,
    requestReverify,
    listOrgUnits,
    listPositions,
    listPositionTypes,
    createOrgUnit,
    updateOrgUnit,
    createPosition,
    updatePosition,
  };
}

module.exports = { createMdmClient, MdmApiError, stripEmployeeNo };
