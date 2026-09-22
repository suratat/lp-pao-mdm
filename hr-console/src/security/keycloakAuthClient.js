const crypto = require('node:crypto');

function randomState() {
  return crypto.randomBytes(24).toString('base64url');
}

// คุยกับ Keycloak (realm lp-pao) ตาม authorization code flow มาตรฐาน - client hr-console เป็น
// confidential client (มี client secret) และ standardFlowEnabled=true (ต่างจาก mdm-portal/mdm-worker
// ที่เป็น service account ล้วน) เพราะ HR ต้องล็อกอินเป็นผู้ใช้จริงเพื่อให้ตรวจ realm role hr_officer ได้
function createKeycloakAuthClient({ authorizationUrl, tokenUrl, logoutUrl, clientId, clientSecret, redirectUri, scope }) {
  function buildLoginUrl(state) {
    const url = new URL(authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async function postToken(params) {
    let res;
    try {
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
    } catch {
      // ห้าม log error object ตรง ๆ (rule 7) - อาจมี body/secret ปนอยู่ใน error message ของบาง runtime
      return { ok: false, status: 502, reason: 'upstream_unreachable' };
    }

    if (!res.ok) {
      // ห้าม log response body (อาจมี error_description หลุดรายละเอียด client secret/token) - เก็บแค่ status
      return { ok: false, status: res.status, reason: 'token_endpoint_error' };
    }
    const tokens = await res.json();
    return { ok: true, tokens };
  }

  function exchangeCode(code) {
    return postToken(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      })
    );
  }

  function refreshTokens(refreshToken) {
    return postToken(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      })
    );
  }

  function buildLogoutUrl(idTokenHint, postLogoutRedirectUri) {
    if (!logoutUrl) return null;
    const url = new URL(logoutUrl);
    if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
    if (postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    return url.toString();
  }

  return { buildLoginUrl, exchangeCode, refreshTokens, buildLogoutUrl };
}

module.exports = { createKeycloakAuthClient, randomState };
