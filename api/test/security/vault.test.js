const { createFakeVaultClient } = require('../../src/security/vault');

describe('fake Vault Transit client (ภาคผนวก ข)', () => {
  test('encrypt -> decrypt กลับมาเป็นค่าเดิม (context เดียวกัน)', async () => {
    const vault = createFakeVaultClient();
    const plaintext = Buffer.from('example-plaintext-bytes', 'utf8');

    const { ciphertext, keyId } = await vault.encrypt('mdm-pid', plaintext, 'person-a');

    expect(ciphertext).toMatch(/^vault:v\d+:/);
    expect(keyId).toBe('vault:transit:mdm-pid:v1');

    const decrypted = await vault.decrypt('mdm-pid', ciphertext, 'person-a');
    expect(decrypted.toString('utf8')).toBe('example-plaintext-bytes');
  });

  test('ciphertext ผูกกับ context (person_id) - ถอดรหัสด้วย context อื่นต้อง throw', async () => {
    const vault = createFakeVaultClient();
    const { ciphertext } = await vault.encrypt('mdm-pid', Buffer.from('example-plaintext-bytes'), 'person-a');

    await expect(vault.decrypt('mdm-pid', ciphertext, 'person-b')).rejects.toThrow();
  });

  test('ciphertext ต่างกันทุกครั้งแม้ plaintext/context เดิม (random IV)', async () => {
    const vault = createFakeVaultClient();
    const a = await vault.encrypt('mdm-pid', Buffer.from('example-plaintext-bytes'), 'person-a');
    const b = await vault.encrypt('mdm-pid', Buffer.from('example-plaintext-bytes'), 'person-a');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test('getPepper คืนค่า Buffer 32 ไบต์เดิมทุกครั้งภายใน client เดียวกัน', async () => {
    const vault = createFakeVaultClient();
    const a = await vault.getPepper();
    const b = await vault.getPepper();
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
  });

  test('vault คนละ instance ได้ pepper คนละค่า', async () => {
    const vaultA = createFakeVaultClient();
    const vaultB = createFakeVaultClient();
    const a = await vaultA.getPepper();
    const b = await vaultB.getPepper();
    expect(a.equals(b)).toBe(false);
  });
});
