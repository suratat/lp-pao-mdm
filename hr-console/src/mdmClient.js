class MdmApiError extends Error {
  constructor(status, problem) {
    super(problem?.title || `MDM API error (${status})`);
    this.status = status;
    this.problem = problem;
  }
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
    const data = text ? JSON.parse(text) : null;

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
    if (activeOnly) qs.set('activeOnly', 'true');
    const query = qs.toString();
    return call('GET', `/api/v1/positions${query ? `?${query}` : ''}`, accessToken);
  }

  function listPositionTypes(accessToken) {
    return call('GET', '/api/v1/position-types', accessToken);
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

  return {
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

module.exports = { createMdmClient, MdmApiError };
