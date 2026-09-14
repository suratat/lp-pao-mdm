// ขอ client-credentials token จาก Keycloak (client mdm-portal, scope personnel:self ตาม
// infra/keycloak/realm-export.json) แล้ว cache ไว้จนใกล้หมดอายุ ตามแนวทางเดียวกับที่ §0.5 ข้อ 2 กำหนดให้
// check.lp-pao.go.th ทำกับ client check-broker
function createKeycloakServiceTokenProvider({ tokenUrl, clientId, clientSecret, scope }) {
  let cached = null; // { token, expiresAt }

  return async function getServiceToken() {
    const now = Date.now();
    if (cached && cached.expiresAt - 5000 > now) return cached.token;

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (scope) params.set('scope', scope);

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    if (!res.ok) {
      // ห้าม log body/secret (rule 7) - log แค่ status
      throw new Error(`ขอ token จาก Keycloak ไม่สำเร็จ (status ${res.status})`);
    }
    const data = await res.json();
    cached = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
    return cached.token;
  };
}

module.exports = { createKeycloakServiceTokenProvider };
