class MdmApiError extends Error {
  constructor(status, problem) {
    super(problem?.title || `MDM API error (${status})`);
    this.status = status;
    this.problem = problem;
  }
}

// เรียก MDM API ด้วย access token ของผู้ใช้ dpo/auditor ที่ล็อกอินอยู่ตรง ๆ (ไม่ต้องมี X-Acting-Person
// เหมือน Portal เพราะ scope audit:read ไม่ใช่ user context personnel:self - แนวทางเดียวกับ hr-console)
function createMdmClient({ baseUrl }) {
  async function call(method, path, accessToken) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) {
      throw new MdmApiError(res.status, data);
    }
    return data;
  }

  function listAccessLogs(accessToken, { personId, clientId, from, to, pidAccessOnly, cursor, limit } = {}) {
    const qs = new URLSearchParams();
    if (personId) qs.set('personId', personId);
    if (clientId) qs.set('clientId', clientId);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (pidAccessOnly) qs.set('pidAccessOnly', 'true');
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    const query = qs.toString();
    return call('GET', `/api/v1/audit/access-logs${query ? `?${query}` : ''}`, accessToken);
  }

  function getPersonChangeLog(accessToken, personId, { since, cursor, limit } = {}) {
    const qs = new URLSearchParams();
    if (since) qs.set('since', since);
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    const query = qs.toString();
    return call('GET', `/api/v1/persons/${encodeURIComponent(personId)}/change-log${query ? `?${query}` : ''}`, accessToken);
  }

  return { listAccessLogs, getPersonChangeLog };
}

module.exports = { createMdmClient, MdmApiError };
