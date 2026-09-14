const { signActingPersonAssertion } = require('./security/actingAssertion');

class MdmApiError extends Error {
  constructor(status, problem) {
    super(problem?.title || `MDM API error (${status})`);
    this.status = status;
    this.problem = problem;
  }
}

// ห่อการเรียก MDM API สำหรับ self-service (scope personnel:self) เท่านั้น - แนบทั้ง Bearer (client
// credentials ของ mdm-portal) และ X-Acting-Person (ผู้ใช้ที่ล็อกอินอยู่ใน Portal ตอนนี้)
function createMdmClient({ baseUrl, getServiceToken, actingAssertionSecret, portalClientId = 'mdm-portal' }) {
  async function callSelf(method, path, personId, body) {
    const [token, assertion] = await Promise.all([
      getServiceToken(),
      signActingPersonAssertion({ personId, secret: actingAssertionSecret, issuer: portalClientId }),
    ]);

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Acting-Person': assertion,
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

  return {
    getMe: (personId) => callSelf('GET', '/api/v1/me', personId),
    updateContact: (personId, body) => callSelf('PUT', '/api/v1/me/contact', personId, body),
    replaceEmergencyContacts: (personId, body) => callSelf('PUT', '/api/v1/me/emergency-contacts', personId, body),
    reportIdentityIssue: (personId, body) => callSelf('POST', '/api/v1/me/report-identity-issue', personId, body),
    listConsents: (personId) => callSelf('GET', '/api/v1/me/consents', personId),
    setConsent: (personId, purposeCode, body) =>
      callSelf('PUT', `/api/v1/me/consents/${encodeURIComponent(purposeCode)}`, personId, body),
  };
}

module.exports = { createMdmClient, MdmApiError };
