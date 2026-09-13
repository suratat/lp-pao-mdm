const crypto = require('node:crypto');

// Vault Transit client ตามภาคผนวก ข: POST /v1/transit/encrypt/<key>, context = person_id (derived key)
// ผูก ciphertext กับ record ไม่ใช้ library เพิ่ม (ไม่มีใน stack ที่ตกลงไว้) เรียก HTTP ตรงด้วย fetch
// (Node 22 มี fetch ในตัว) - VAULT_ADDR/VAULT_TOKEN มาจาก env เท่านั้นตามกฎข้อ 7 ของ CLAUDE.md
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
      const ciphertext = json.data.ciphertext; // รูปแบบ 'vault:v1:...'
      const keyVersion = ciphertext.split(':')[1]; // 'v1'
      return { ciphertext, keyId: `vault:transit:${keyName}:${keyVersion}` };
    },

    async decrypt(keyName, ciphertext, context) {
      const body = { ciphertext };
      if (context) body.context = Buffer.from(context, 'utf8').toString('base64');
      const json = await vaultRequest(`/v1/transit/decrypt/${keyName}`, body);
      return Buffer.from(json.data.plaintext, 'base64');
    },

    // pepper สำหรับ HMAC pid_hash: Vault KV v2 ที่ secret/mdm/pid-pepper อ่านครั้งเดียวตอน boot
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

// Fake client สำหรับ dev/test เท่านั้น: ใช้ AES-256-GCM จริง (ไม่ใช่แค่ base64/XOR) โดยผูก context
// เข้ากับ AAD เหมือนคุณสมบัติ derived key ของ Vault จริง - ถอดรหัสด้วย context ผิดต้อง throw เสมอ
// เพื่อให้ test ยืนยันได้ว่า ciphertext ผูกกับ record จริงตามภาคผนวก ข ไม่ใช่แค่ mock เฉยๆ
function createFakeVaultClient() {
  const localKey = crypto.randomBytes(32); // อยู่ใน memory ของ process ทดสอบเท่านั้น ไม่ใช่ secret จริง
  const pepper = crypto.randomBytes(32);
  const keyVersions = new Map(); // keyName -> version (จำลอง rotation แบบง่าย)

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
