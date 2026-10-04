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
  async function call(method, path, accessToken, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) {
      throw new MdmApiError(res.status, data);
    }
    return data;
  }

  function listAccessLogs(accessToken, { personId, clientId, from, to, pidAccessOnly, reviewStatus, cursor, limit } = {}) {
    const qs = new URLSearchParams();
    if (personId) qs.set('personId', personId);
    if (clientId) qs.set('clientId', clientId);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (pidAccessOnly) qs.set('pidAccessOnly', 'true');
    if (reviewStatus) qs.set('reviewStatus', reviewStatus);
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

  // GET /audit/change-logs - source=PERSON|REFERENCE (ตัวกรองที่ไม่เกี่ยวกับ source นั้นต้องไม่ส่ง ไม่งั้น API ตอบ 400)
  function listChangeLogs(accessToken, { source, from, to, actorSub, tableName, personId, changedBy, action, cursor, limit } = {}) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries({ source, from, to, actorSub, tableName, personId, changedBy, action, cursor })) {
      if (value) qs.set(key, value);
    }
    if (limit) qs.set('limit', String(limit));
    const query = qs.toString();
    return call('GET', `/api/v1/audit/change-logs${query ? `?${query}` : ''}`, accessToken);
  }

  // POST /audit/access-logs/{accessId}/review (scope audit:review + role dpo) - accessedAt คู่กับ accessId ระบุแถวของ access_log
  function reviewPidAccess(accessToken, accessId, { accessedAt, status, note }) {
    return call('POST', `/api/v1/audit/access-logs/${encodeURIComponent(accessId)}/review`, accessToken, {
      accessedAt,
      status,
      ...(note ? { note } : {}),
    });
  }

  // GET /audit/alerts (audit:read)
  function listAlerts(accessToken, { status, ruleCode, from, to, actorSub, cursor, limit } = {}) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries({ status, ruleCode, from, to, actorSub, cursor })) {
      if (value) qs.set(key, value);
    }
    if (limit) qs.set('limit', String(limit));
    const query = qs.toString();
    return call('GET', `/api/v1/audit/alerts${query ? `?${query}` : ''}`, accessToken);
  }

  // POST /audit/alerts/{alertId}/ack | /close (scope audit:review + role dpo)
  function ackAlert(accessToken, alertId, { note } = {}) {
    return call('POST', `/api/v1/audit/alerts/${encodeURIComponent(alertId)}/ack`, accessToken, note ? { note } : {});
  }

  function closeAlert(accessToken, alertId, { note }) {
    return call('POST', `/api/v1/audit/alerts/${encodeURIComponent(alertId)}/close`, accessToken, { note });
  }

  return { listAccessLogs, getPersonChangeLog, listChangeLogs, reviewPidAccess, listAlerts, ackAlert, closeAlert };
}

module.exports = { createMdmClient, MdmApiError };
