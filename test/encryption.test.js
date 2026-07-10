/**
 * Encryption KDF-migration test suite (pure Node, no emulator).
 *
 * Verifies the switch from PBKDF2 to HKDF key derivation:
 *   - encrypt→decrypt roundtrip works with the new HKDF format
 *   - ciphertext written in the LEGACY PBKDF2 format still decrypts
 *     (backward compatibility — production credentials predate the switch)
 *   - a corrupted blob / wrong key fails closed (throws)
 *
 * Run:  npm run test:encryption
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// A fixed 32-byte (64 hex char) key so the legacy-format fixture is reproducible.
const TEST_KEY = 'a'.repeat(64);

let encrypt, decrypt;

before(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
  ({ encrypt, decrypt } = require('../utils/encryption'));
});

// Reproduce the OLD PBKDF2-based encrypt() exactly as it existed before the
// HKDF migration, so we can prove decrypt() still reads data written that way.
function legacyPbkdf2Encrypt(text) {
  const SALT_LENGTH = 64, IV_LENGTH = 16;
  const key = Buffer.from(TEST_KEY, 'hex');
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const derivedKey = crypto.pbkdf2Sync(key, salt, 100000, 32, 'sha512');
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

describe('encryption — HKDF format', () => {
  it('roundtrips a secret through encrypt→decrypt', () => {
    const secret = 'ya29.super-secret-oauth-access-token';
    const ct = encrypt(secret);
    assert.notStrictEqual(ct, secret);
    assert.strictEqual(decrypt(ct), secret);
  });

  it('produces different ciphertext each time (random salt+iv) but decrypts identically', () => {
    const secret = 'refresh-token-value';
    const a = encrypt(secret);
    const b = encrypt(secret);
    assert.notStrictEqual(a, b);
    assert.strictEqual(decrypt(a), secret);
    assert.strictEqual(decrypt(b), secret);
  });

  it('passes through falsy values unchanged', () => {
    assert.strictEqual(encrypt(''), '');
    assert.strictEqual(decrypt(''), '');
    assert.strictEqual(encrypt(undefined), undefined);
    assert.strictEqual(decrypt(null), null);
  });
});

describe('encryption — backward compatibility with legacy PBKDF2 ciphertext', () => {
  it('decrypts a blob written by the pre-migration PBKDF2 encrypt()', () => {
    const secret = 'legacy-notion-integration-token';
    const legacyCt = legacyPbkdf2Encrypt(secret);
    assert.strictEqual(decrypt(legacyCt), secret);
  });
});

describe('encryption — fails closed', () => {
  it('throws on a corrupted ciphertext', () => {
    const ct = encrypt('something');
    const corrupted = ct.slice(0, -4) + 'AAAA';
    assert.throws(() => decrypt(corrupted), /Decryption failed/);
  });

  it('throws when the key changed (neither HKDF nor PBKDF2 derivation matches)', () => {
    const ct = encrypt('token');
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    try {
      assert.throws(() => decrypt(ct), /Decryption failed/);
    } finally {
      process.env.ENCRYPTION_KEY = TEST_KEY;
    }
  });
});
