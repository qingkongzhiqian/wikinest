import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PRODUCT = 'Wikinest Sync';
const VERSION = 1;
const KDF = Object.freeze({ N: 131_072, r: 8, p: 1 });
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const VERIFIER = Buffer.from('Wikinest Sync v1 verifier');

function exactFields(value, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has invalid fields`);
  }
}

function validString(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`);
}

function validId(value, label) {
  if (
    typeof value !== 'string'
    || !value
    || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`${label} must contain no whitespace or control characters`);
  }
}

function validTimestamp(value, label) {
  validString(value, label);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an ISO instant`);
  }
}

function aad({ vaultId, type }) {
  validId(vaultId, 'vaultId');
  validString(type, 'object type');
  return Buffer.from(`${PRODUCT}\0v${VERSION}\0${vaultId}\0${type}`);
}

function decodeBase64(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value)) {
    throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string`);
  }
  const decoded = Buffer.from(value, 'base64');
  if ((!allowEmpty && !decoded.length) || decoded.toString('base64') !== value) {
    throw new Error(`${label} must be canonical base64`);
  }
  return decoded;
}

function validateEnvelope(envelope) {
  exactFields(envelope, ['nonce', 'ciphertext', 'tag'], 'envelope');
  const nonce = decodeBase64(envelope.nonce, 'nonce');
  const ciphertext = decodeBase64(envelope.ciphertext, 'ciphertext', { allowEmpty: true });
  const tag = decodeBase64(envelope.tag, 'tag');
  if (nonce.length !== 12) throw new Error('nonce must be 12 bytes');
  if (tag.length !== 16) throw new Error('tag must be 16 bytes');
  return { nonce, ciphertext, tag };
}

async function deriveKey(password, kdf) {
  if (typeof password !== 'string' || !password) throw new Error('password is required');
  exactFields(kdf, ['salt', 'N', 'r', 'p'], 'kdf');
  if (kdf.N !== KDF.N || kdf.r !== KDF.r || kdf.p !== KDF.p) {
    throw new Error('unsupported scrypt parameters');
  }
  const salt = decodeBase64(kdf.salt, 'salt');
  if (salt.length !== 16) throw new Error('salt must be 16 bytes');
  return scrypt(password, salt, 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

export function seal(value, key, context) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('key must be 32 bytes');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(value)), cipher.final()]);
  return {
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function open(envelope, key, context) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('key must be 32 bytes');
  const { nonce, ciphertext, tag } = validateEnvelope(envelope);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export async function createSyncMeta({
  vaultId,
  password = '',
  createdAt = new Date().toISOString(),
  salt,
}) {
  validId(vaultId, 'vaultId');
  validTimestamp(createdAt, 'createdAt');
  if (typeof password !== 'string') throw new Error('password must be a string');
  const base = { product: PRODUCT, version: VERSION, vaultId, createdAt, encrypted: Boolean(password) };
  if (!password) return base;

  const saltBytes = salt === undefined ? randomBytes(16) : Buffer.from(salt);
  if (saltBytes.length !== 16) throw new Error('salt must be 16 bytes');
  const kdf = { salt: saltBytes.toString('base64'), ...KDF };
  const key = await deriveKey(password, kdf);
  return {
    ...base,
    kdf,
    verifier: seal(VERIFIER, key, { vaultId, type: 'verifier' }),
  };
}

export async function openSyncMeta(meta, password = '') {
  const fields = meta?.encrypted
    ? ['product', 'version', 'vaultId', 'createdAt', 'encrypted', 'kdf', 'verifier']
    : ['product', 'version', 'vaultId', 'createdAt', 'encrypted'];
  exactFields(meta, fields, 'meta');
  if (meta.product !== PRODUCT) throw new Error('unsupported product');
  if (meta.version !== VERSION) throw new Error('unsupported protocol version');
  validId(meta.vaultId, 'vaultId');
  validTimestamp(meta.createdAt, 'createdAt');
  if (typeof meta.encrypted !== 'boolean') throw new Error('encrypted must be boolean');
  if (!meta.encrypted) {
    if (password) throw new Error('plaintext vault does not use a password');
    return { meta, key: null };
  }

  try {
    const key = await deriveKey(password, meta.kdf);
    const verifier = open(meta.verifier, key, { vaultId: meta.vaultId, type: 'verifier' });
    if (!verifier.equals(VERIFIER)) throw new Error('invalid verifier');
    return { meta, key };
  } catch {
    throw new Error('wrong password or tampered metadata');
  }
}

export function encodeBlob(value, { key = null, vaultId }) {
  const source = Buffer.from(value);
  const body = key
    ? Buffer.from(JSON.stringify({
      version: VERSION,
      encrypted: true,
      ...seal(source, key, { vaultId, type: 'blob' }),
    }))
    : source;
  return {
    body,
    hash: createHash('sha256').update(body).digest('hex'),
  };
}

export function decodeBlob(body, { key = null, vaultId }) {
  const stored = Buffer.from(body);
  if (!key) return stored;
  let envelope;
  try {
    envelope = JSON.parse(stored.toString('utf8'));
  } catch {
    throw new Error('invalid encrypted blob');
  }
  exactFields(envelope, ['version', 'encrypted', 'nonce', 'ciphertext', 'tag'], 'blob');
  if (envelope.version !== VERSION || envelope.encrypted !== true) {
    throw new Error('unsupported encrypted blob');
  }
  return open({
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    tag: envelope.tag,
  }, key, { vaultId, type: 'blob' });
}
