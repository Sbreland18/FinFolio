'use strict';
/**
 * Encryption helpers for FinFolio.
 *
 * Format: AES-256-GCM with a scrypt-derived key. The envelope is plain JSON so
 * that a file can always be identified (and its parameters read) without
 * knowing the password.
 *
 *   { "__finfolio_enc": 1, "kdf": "scrypt", "N": 65536, "r": 8, "p": 1,
 *     "salt": base64, "iv": base64, "tag": base64, "ct": base64 }
 *
 * A wrong password fails GCM tag verification, so no separate verifier is
 * stored. There is deliberately no recovery path: the password never leaves
 * this machine and is never written to disk.
 */

const crypto = require('node:crypto');

const KDF = { N: 65536, r: 8, p: 1, keylen: 32, maxmem: 160 * 1024 * 1024 };
const MAGIC = '__finfolio_enc';

function deriveKey(password, salt, params = KDF) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(password), 'utf8'),
      salt,
      params.keylen || 32,
      { N: params.N, r: params.r, p: params.p, maxmem: KDF.maxmem },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

/** Encrypt a JS object into the envelope described above. */
async function encryptJSON(obj, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  return {
    [MAGIC]: 1,
    kdf: 'scrypt',
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** Decrypt an envelope. Throws `BAD_PASSWORD` when the tag does not verify. */
async function decryptJSON(env, password) {
  if (!isEncrypted(env)) throw new Error('NOT_ENCRYPTED');
  const salt = Buffer.from(env.salt, 'base64');
  const iv = Buffer.from(env.iv, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  const ct = Buffer.from(env.ct, 'base64');
  const key = await deriveKey(password, salt, {
    N: env.N || KDF.N,
    r: env.r || KDF.r,
    p: env.p || KDF.p,
    keylen: 32,
  });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('BAD_PASSWORD');
  } finally {
    key.fill(0);
  }
  try {
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Error('CORRUPT');
  }
}

function isEncrypted(obj) {
  return !!(obj && typeof obj === 'object' && obj[MAGIC] === 1 && obj.ct);
}

/** Rough password strength score 0..4 with a human-readable label. */
function scorePassword(pw) {
  const s = String(pw || '');
  if (!s) return { score: 0, label: 'Empty' };
  let bits = 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  bits = s.length * (classes >= 4 ? 5 : classes === 3 ? 4 : classes === 2 ? 3.2 : 2.5);
  if (/^(.)\1+$/.test(s)) bits = 8;
  const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 90 ? 3 : 4;
  return { score, label: ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'][score] };
}

module.exports = { encryptJSON, decryptJSON, isEncrypted, scorePassword, MAGIC };
