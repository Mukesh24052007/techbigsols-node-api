const crypto = require('crypto');

const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;
const DIM = 128;
const BYTES_PER_FLOAT = 4;
const IV_LEN = 12;
const TAG_LEN = 16;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Load FACE_ENC_KEY only when encrypt/decrypt is called (never at boot).
 * @returns {Buffer} 32 bytes
 */
function getFaceKey() {
  const hex = process.env.FACE_ENC_KEY;
  if (!hex || !KEY_HEX_RE.test(String(hex).trim())) {
    throw httpError(
      500,
      'FACE_ENC_KEY is missing or invalid. Set a 32-byte key as 64 hex characters (openssl rand -hex 32).'
    );
  }
  return Buffer.from(String(hex).trim(), 'hex');
}

function floatsToBuffer(descriptor) {
  const buf = Buffer.alloc(DIM * BYTES_PER_FLOAT);
  for (let i = 0; i < DIM; i += 1) {
    buf.writeFloatLE(descriptor[i], i * BYTES_PER_FLOAT);
  }
  return buf;
}

function bufferToFloats(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== DIM * BYTES_PER_FLOAT) {
    throw httpError(500, 'Stored face template is corrupt.');
  }
  const out = new Array(DIM);
  for (let i = 0; i < DIM; i += 1) {
    out[i] = buf.readFloatLE(i * BYTES_PER_FLOAT);
  }
  return out;
}

/**
 * AES-256-GCM encrypt a 128-d embedding. Returns iv || tag || ciphertext.
 * @param {number[]} descriptor
 * @returns {Buffer}
 */
function encryptEmbedding(descriptor) {
  const key = getFaceKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const pt = floatsToBuffer(descriptor);
  const ciphertext = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/**
 * Decrypt a stored template to a 128-d number array.
 * @param {Buffer} payload
 * @returns {number[]}
 */
function decryptEmbedding(payload) {
  const key = getFaceKey();
  if (!Buffer.isBuffer(payload) || payload.length < IV_LEN + TAG_LEN + 1) {
    throw httpError(500, 'Stored face template is corrupt.');
  }
  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = payload.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return bufferToFloats(pt);
}

module.exports = {
  encryptEmbedding,
  decryptEmbedding,
  getFaceKey,
};
