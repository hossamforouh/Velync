const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const TAG_POSITION = SALT_LENGTH + IV_LENGTH;
const ENCRYPTED_POSITION = TAG_POSITION + TAG_LENGTH;

// Retrieve the encryption key from environment variables
function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  return Buffer.from(key, 'hex');
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * @param {string} text - The plaintext to encrypt.
 * @returns {string} The base64 encoded ciphertext including salt, iv, and auth tag.
 */
function encrypt(text) {
  if (!text) return text;
  
  const key = getKey();
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  
  // We use pbkdf2 to derive a key from the master key + salt for each encryption operation.
  // This provides an extra layer of security.
  const derivedKey = crypto.pbkdf2Sync(key, salt, 100000, 32, 'sha512');
  
  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final()
  ]);
  
  const tag = cipher.getAuthTag();
  
  // Pack everything into a single buffer
  const payload = Buffer.concat([salt, iv, tag, encrypted]);
  return payload.toString('base64');
}

/**
 * Decrypts a ciphertext string that was encrypted with the `encrypt` function.
 * @param {string} ciphertext - The base64 encoded ciphertext payload.
 * @returns {string} The decrypted plaintext.
 */
function decrypt(ciphertext) {
  if (!ciphertext) return ciphertext;
  
  try {
    const payload = Buffer.from(ciphertext, 'base64');
    
    // Extract parts
    const salt = payload.subarray(0, SALT_LENGTH);
    const iv = payload.subarray(SALT_LENGTH, TAG_POSITION);
    const tag = payload.subarray(TAG_POSITION, ENCRYPTED_POSITION);
    const encrypted = payload.subarray(ENCRYPTED_POSITION);
    
    const key = getKey();
    const derivedKey = crypto.pbkdf2Sync(key, salt, 100000, 32, 'sha512');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(tag);
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error('Decryption failed. The token is corrupted or the ENCRYPTION_KEY changed.');
  }
}

module.exports = {
  encrypt,
  decrypt
};
