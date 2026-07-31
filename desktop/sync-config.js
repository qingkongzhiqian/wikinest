import { createHash } from 'node:crypto';
import path from 'node:path';

const PUBLIC_FIELDS = Object.freeze([
  'enabled',
  'bucket',
  'prefix',
  'endpoint',
  'region',
  'forcePathStyle',
  'accessKeyId',
]);
const INPUT_FIELDS = new Set([
  ...PUBLIC_FIELDS,
  'secretAccessKey',
  'password',
  'clearSecretAccessKey',
  'clearPassword',
]);
const DEFAULTS = Object.freeze({
  enabled: false,
  bucket: '',
  prefix: 'wikinest-sync/',
  endpoint: '',
  region: 'auto',
  forcePathStyle: false,
  accessKeyId: '',
  secretAccessKey: '',
  password: '',
});

function string(value, field) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  return value.trim();
}

function normalizePrefix(value) {
  const prefix = string(value, 'prefix') || DEFAULTS.prefix;
  if (
    prefix.startsWith('/')
    || prefix.includes('\\')
    || prefix.includes('//')
  ) {
    throw new Error('prefix must be a safe relative prefix');
  }
  const parts = prefix.replace(/\/$/u, '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('prefix must be a safe relative prefix');
  }
  return `${parts.join('/')}/`;
}

function normalizeEndpoint(value) {
  const endpoint = string(value, 'endpoint');
  if (!endpoint) return '';
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('endpoint must be a valid HTTPS URL');
  }
  if (url.username || url.password) throw new Error('endpoint must not contain credentials');
  if (url.search || url.hash) throw new Error('endpoint must not contain query or fragment');
  if (url.protocol === 'https:') return endpoint;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'http:' || !loopback) {
    throw new Error('endpoint must use HTTPS except for localhost');
  }
  return endpoint;
}

function assertKnownFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('sync config must be an object');
  }
  const unknown = Object.keys(input).filter((field) => !INPUT_FIELDS.has(field));
  if (unknown.length) throw new Error(`sync config has invalid field: ${unknown[0]}`);
  for (const field of ['clearSecretAccessKey', 'clearPassword']) {
    if (field in input && typeof input[field] !== 'boolean') {
      throw new TypeError(`${field} must be a boolean`);
    }
  }
}

export function vaultSyncKey(vaultDir) {
  if (typeof vaultDir !== 'string' || !vaultDir) throw new Error('vaultDir is required');
  const identity = path.resolve(vaultDir).normalize('NFC');
  return createHash('sha256').update(identity).digest('hex');
}

export function normalizeSyncConfig(input = {}) {
  assertKnownFields(input);
  const enabled = input.enabled ?? DEFAULTS.enabled;
  const forcePathStyle = input.forcePathStyle ?? DEFAULTS.forcePathStyle;
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (typeof forcePathStyle !== 'boolean') {
    throw new TypeError('forcePathStyle must be a boolean');
  }
  const config = {
    enabled,
    bucket: string(input.bucket, 'bucket'),
    prefix: normalizePrefix(input.prefix),
    endpoint: normalizeEndpoint(input.endpoint),
    region: string(input.region, 'region') || DEFAULTS.region,
    forcePathStyle,
    accessKeyId: string(input.accessKeyId, 'accessKeyId'),
    secretAccessKey: string(input.secretAccessKey, 'secretAccessKey'),
    password: string(input.password, 'password'),
  };
  if (enabled) {
    for (const field of ['bucket', 'accessKeyId', 'secretAccessKey']) {
      if (!config[field]) throw new Error(`${field} is required when sync is enabled`);
    }
  }
  return config;
}

function publicConfig(saved = {}) {
  return {
    enabled: saved.enabled ?? DEFAULTS.enabled,
    bucket: saved.bucket ?? DEFAULTS.bucket,
    prefix: saved.prefix ?? DEFAULTS.prefix,
    endpoint: saved.endpoint ?? DEFAULTS.endpoint,
    region: saved.region ?? DEFAULTS.region,
    forcePathStyle: saved.forcePathStyle ?? DEFAULTS.forcePathStyle,
    accessKeyId: saved.accessKeyId ?? DEFAULTS.accessKeyId,
  };
}

function secureStorageAvailable(safeStorage) {
  if (!safeStorage?.isEncryptionAvailable?.()) return false;
  return safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
}

function decryptSecrets(saved, safeStorage) {
  if (!saved?.secretBlob) return { secretAccessKey: '', password: '' };
  if (!secureStorageAvailable(safeStorage)) {
    throw new Error('Electron secure storage is unavailable');
  }
  let secrets;
  try {
    const plaintext = safeStorage.decryptString(Buffer.from(saved.secretBlob, 'base64'));
    secrets = JSON.parse(plaintext);
  } catch (error) {
    throw new Error('failed to read secrets from secure storage', { cause: error });
  }
  if (
    !secrets
    || typeof secrets !== 'object'
    || typeof secrets.secretAccessKey !== 'string'
    || typeof secrets.password !== 'string'
  ) {
    throw new Error('secure storage contains invalid sync secrets');
  }
  return secrets;
}

export function createSyncConfigRepository({ store, safeStorage } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('vaultSync store is required');
  }

  function read(vaultDir) {
    const saved = store.get(vaultSyncKey(vaultDir)) ?? {};
    const publicFields = publicConfig(saved);
    const secrets = publicFields.enabled
      ? decryptSecrets(saved, safeStorage)
      : { secretAccessKey: '', password: '' };
    return normalizeSyncConfig({ ...publicFields, ...secrets });
  }

  function readForRenderer(vaultDir) {
    const saved = store.get(vaultSyncKey(vaultDir)) ?? {};
    const config = publicConfig(saved);
    return {
      ...config,
      hasSecretAccessKey: Boolean(saved.hasSecretAccessKey),
      hasPassword: Boolean(saved.hasPassword),
      mode: saved.hasPassword ? 'encrypted' : 'plaintext',
    };
  }

  function prepare(vaultDir, input) {
    assertKnownFields(input);
    const key = vaultSyncKey(vaultDir);
    const previous = store.get(key) ?? {};
    const suppliedSecret = string(input.secretAccessKey, 'secretAccessKey');
    const suppliedPassword = string(input.password, 'password');
    const nextPublic = {
      ...publicConfig(previous),
      ...Object.fromEntries(PUBLIC_FIELDS.filter((field) => field in input).map((field) => [field, input[field]])),
    };
    const needsSecrets = nextPublic.enabled
      || Boolean(suppliedSecret)
      || Boolean(suppliedPassword)
      || input.clearSecretAccessKey === true
      || input.clearPassword === true;
    if (!needsSecrets) {
      return {
        key,
        config: normalizeSyncConfig({
          ...nextPublic,
          secretAccessKey: '',
          password: '',
        }),
        secrets: null,
        previous,
      };
    }
    const oldSecrets = previous.secretBlob
      ? decryptSecrets(previous, safeStorage)
      : { secretAccessKey: '', password: '' };
    const secrets = {
      secretAccessKey: input.clearSecretAccessKey ? '' : suppliedSecret || oldSecrets.secretAccessKey,
      password: input.clearPassword ? '' : suppliedPassword || oldSecrets.password,
    };
    const config = normalizeSyncConfig({
      ...nextPublic,
      ...secrets,
    });
    return { key, config, secrets, previous };
  }

  function preview(vaultDir, input) {
    return prepare(vaultDir, input).config;
  }

  function save(vaultDir, input) {
    const { key, config, secrets, previous } = prepare(vaultDir, input);
    const persisted = Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, config[field]]));
    if (secrets === null && previous.secretBlob) {
      persisted.secretBlob = previous.secretBlob;
      persisted.hasSecretAccessKey = Boolean(previous.hasSecretAccessKey);
      persisted.hasPassword = Boolean(previous.hasPassword);
    } else if (secrets?.secretAccessKey || secrets?.password) {
      if (!secureStorageAvailable(safeStorage)) {
        throw new Error('Electron secure storage is unavailable');
      }
      persisted.secretBlob = safeStorage.encryptString(JSON.stringify(secrets)).toString('base64');
      persisted.hasSecretAccessKey = Boolean(secrets.secretAccessKey);
      persisted.hasPassword = Boolean(secrets.password);
    }
    store.set(key, persisted);
    return config;
  }

  function remove(vaultDir) {
    const key = vaultSyncKey(vaultDir);
    if (typeof store.delete === 'function') store.delete(key);
    else store.set(key, undefined);
  }

  return { read, readForRenderer, preview, save, delete: remove };
}
