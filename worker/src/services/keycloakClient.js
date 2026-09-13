// Keycloak Admin REST API client: disable บัญชี + ตัด session ทั้งหมด (§3.4: "worker ปิดบัญชี Keycloak
// ทันที (disable + logout ทุก session + revoke offline token)") ใช้เฉพาะกับบุคลากรที่มีบัญชี Keycloak
// จริง (ส่วนใหญ่ไม่มี - เฉพาะผู้ใช้ HR/DPO console ตามภาคผนวก ก) เรียกก็ต่อเมื่อพบ
// mdm.external_identifier(system_code='KEYCLOAK') ของบุคคลนั้น
function createKeycloakHttpClient({ baseUrl, realm, clientId, clientSecret }) {
  async function getAdminToken() {
    const res = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Keycloak admin token request failed: ${res.status}`);
    const json = await res.json();
    return json.access_token;
  }

  return {
    async disableAndLogout(keycloakUserId) {
      const token = await getAdminToken();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const disableRes = await fetch(`${baseUrl}/admin/realms/${realm}/users/${keycloakUserId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      if (!disableRes.ok) throw new Error(`Keycloak disable user failed: ${disableRes.status}`);

      const logoutRes = await fetch(`${baseUrl}/admin/realms/${realm}/users/${keycloakUserId}/logout`, {
        method: 'POST',
        headers,
      });
      if (!logoutRes.ok) throw new Error(`Keycloak logout user failed: ${logoutRes.status}`);
    },
  };
}

// สำหรับ dev/test: ยังไม่มี Keycloak realm/client จริงในสภาพแวดล้อมนี้ (เตรียมใน T6)
function createFakeKeycloakClient() {
  const calls = [];
  return {
    calls,
    async disableAndLogout(keycloakUserId) {
      calls.push({ keycloakUserId, at: new Date() });
    },
  };
}

module.exports = { createKeycloakHttpClient, createFakeKeycloakClient };
