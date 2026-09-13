const crypto = require('node:crypto');

// สำเนาจาก api/src/security/vault.js โดยตั้งใจ (ไม่ใช้ shared package) เพื่อให้ api/ และ worker/
// เป็น service ที่ deploy แยกกันได้อิสระ (docker image คนละอิมเมจ ตามภาคผนวก ค) ไฟล์เล็กและไม่มี
// dependency นอกเหนือจาก node:crypto จึงคุ้มกว่าการทำ shared package/workspace ในตอนนี้
//
// Vault Transit client ตามภาคผนวก ข: POST /v1/transit/encrypt/<key>, context ผูก ciphertext กับ record
function createVaultHttpClient({ addr, token }) {
  async function vaultRequest(path, body) {
    const res = await fetch(`${addr}${path}`, {
      method: 'POST',
      headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Vault request failed: ${path} -> ${res.status}`);
    }
    return res.json();
  }

  return {
    async encrypt(keyName, plaintext, context) {
      const body = { plaintext: plaintext.toString('base64') };
      if (context) body.context = Buffer.from(context, 'utf8').toString('base64');
      const json = await vaultRequest(`/v1/transit/encrypt/${keyName}`, body);
      const ciphertext = json.data.ciphertext;
      const keyVersion = ciphertext.split(':')[1];
      return { ciphertext, keyId: `vault:transit:${keyName}:${keyVersion}` };
    },

    async decrypt(keyName, ciphertext, context) {
      const body = { ciphertext };
      if (context) body.context = Buffer.from(context, 'utf8').toString('base64');
      const json = await vaultRequest(`/v1/transit/decrypt/${keyName}`, body);
      return Buffer.from(json.data.plaintext, 'base64');
    },

    async getPepper() {
      const res = await fetch(`${addr}/v1/secret/data/mdm/pid-pepper`, {
        headers: { 'X-Vault-Token': token },
      });
      if (!res.ok) {
        throw new Error(`Vault request failed: /v1/secret/data/mdm/pid-pepper -> ${res.status}`);
      }
      const json = await res.json();
      return Buffer.from(json.data.data.pepper, 'base64');
    },
  };
}

// Fake client สำหรับ dev/test เท่านั้น (ดูรายละเอียดเหตุผลใน api/src/security/vault.js)
function createFakeVaultClient() {
  const localKey = crypto.randomBytes(32);
  const pepper = crypto.randomBytes(32);
  const keyVersions = new Map();

  function currentVersion(keyName) {
    if (!keyVersions.has(keyName)) keyVersions.set(keyName, 1);
    return keyVersions.get(keyName);
  }

  return {
    async encrypt(keyName, plaintext, context) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', localKey, iv);
      if (context) cipher.setAAD(Buffer.from(context, 'utf8'));
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const version = currentVersion(keyName);
      const payload = Buffer.concat([iv, authTag, encrypted]).toString('base64');
      return {
        ciphertext: `vault:v${version}:${payload}`,
        keyId: `vault:transit:${keyName}:v${version}`,
      };
    },

    async decrypt(keyName, ciphertext, context) {
      const [, , payloadB64] = ciphertext.split(':');
      const payload = Buffer.from(payloadB64, 'base64');
      const iv = payload.subarray(0, 12);
      const authTag = payload.subarray(12, 28);
      const encrypted = payload.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', localKey, iv);
      if (context) decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    },

    async getPepper() {
      return pepper;
    },
  };
}

module.exports = { createVaultHttpClient, createFakeVaultClient };
