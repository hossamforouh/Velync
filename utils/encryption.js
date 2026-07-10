const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const TAG_POSITION = SALT_LENGTH + IV_LENGTH;
const ENCRYPTED_POSITION = TAG_POSITION + TAG_LENGTH;

// Legacy KDF parameters — PBKDF2-SHA512 ×100k. Historically used to derive the
// per-record key. Retained ONLY for decrypting data written before the switch
// to HKDF (see below); nothing new is encrypted with it.
const PBKDF2_ITERATIONS = 100000;

// HKDF context string — binds derived keys to this application/purpose.
const HKDF_INFO = Buffer.from('velync:credential-encryption:v2');

// Retrieve the master encryption key from environment variables.
function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  return Buffer.from(key, 'hex');
}

// HKDF-SHA512 key derivation. The master key is already a 256-bit random value,
// so an expensive password-stretching KDF (PBKDF2 ×100k) bought no real
// security — its iteration count exists to slow brute-forcing of LOW-entropy
// passwords, which this key is not. HKDF is the correct primitive for
// deriving keys from high-entropy input and is effectively free by comparison,
// removing ~tens of ms of CPU from every encrypt/decrypt on the credential
// hot path (every sync run resolves tokens).
function deriveKeyHKDF(masterKey, salt) {
  return Buffer.from(crypto.hkdfSync('sha512', masterKey, salt, HKDF_INFO, 32));
}

// Legacy PBKDF2 derivation — used as a decryption fallback only.
function deriveKeyPBKDF2(masterKey, salt) {
  return crypto.pbkdf2Sync(masterKey, salt, PBKDF2_ITERATIONS, 32, 'sha512');
}

/**
 * Encrypts a plaintext string using AES-256-GCM with an HKDF-derived per-record
 * key. Payload layout is unchanged from the legacy format
 * (salt | iv | tag | ciphertext), so only the key-derivation step differs —
 * legacy ciphertexts remain decryptable (see `decrypt`).
 * @param {string} text - The plaintext to encrypt.
 * @returns {string} Base64-encoded ciphertext payload.
 */
function encrypt(text) {
  if (!text) return text;

  const key = getKey();
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  const derivedKey = deriveKeyHKDF(key, salt);
  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  const payload = Buffer.concat([salt, iv, tag, encrypted]);
  return payload.toString('base64');
}

/**
 * Decrypts a ciphertext produced by `encrypt` (current HKDF format) OR by the
 * historical PBKDF2 format. AES-GCM authenticates the ciphertext, so a
 * wrong-key derivation makes `decipher.final()` throw — we exploit that to try
 * HKDF first and transparently fall back to the legacy PBKDF2 derivation,
 * migrating old records forward on their next re-encryption (e.g. token
 * refresh / connection update) with no separate migration pass.
 * @param {string} ciphertext - Base64-encoded ciphertext payload.
 * @returns {string} The decrypted plaintext.
 */
function decrypt(ciphertext) {
  if (!ciphertext) return ciphertext;

  const key = getKey();
  let iv, tag, encrypted, salt;
  try {
    const payload = Buffer.from(ciphertext, 'base64');
    salt = payload.subarray(0, SALT_LENGTH);
    iv = payload.subarray(SALT_LENGTH, TAG_POSITION);
    tag = payload.subarray(TAG_POSITION, ENCRYPTED_POSITION);
    encrypted = payload.subarray(ENCRYPTED_POSITION);
  } catch (err) {
    throw new Error('Decryption failed. The token is corrupted or the ENCRYPTION_KEY changed.');
  }

  const tryDecrypt = (derivedKey) => {
    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  };

  try {
    // Current format.
    return tryDecrypt(deriveKeyHKDF(key, salt));
  } catch (hkdfErr) {
    try {
      // Legacy PBKDF2 records — decrypt forward; they migrate to HKDF on their
      // next re-encryption.
      return tryDecrypt(deriveKeyPBKDF2(key, salt));
    } catch (pbkdf2Err) {
      throw new Error('Decryption failed. The token is corrupted or the ENCRYPTION_KEY changed.');
    }
  }
}

module.exports = {
  encrypt,
  decrypt,
};
