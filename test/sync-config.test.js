import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  createSyncConfigRepository,
  normalizeSyncConfig,
  vaultSyncKey,
} from '../desktop/sync-config.js';

function fakeStore() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, structuredClone(value)),
    delete: (key) => values.delete(key),
    values,
  };
}

function fakeSafeStorage(available = true, backend = 'keychain') {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`sealed:${value}`),
    decryptString: (value) => {
      const text = Buffer.from(value).toString();
      if (!text.startsWith('sealed:')) throw new Error('bad ciphertext');
      return text.slice(7);
    },
  };
}

test('vault key hashes the resolved NFC path', () => {
  const decomposed = path.join(process.cwd(), 'vault-e\u0301');
  const composed = path.join(process.cwd(), 'vault-é');
  assert.equal(vaultSyncKey(decomposed), vaultSyncKey(composed));
  assert.match(vaultSyncKey(decomposed), /^[a-f0-9]{64}$/);
});

test('config roundtrips per vault with one encrypted secret blob', () => {
  const store = fakeStore();
  const repo = createSyncConfigRepository({ store, safeStorage: fakeSafeStorage() });
  repo.save('/vault/a', {
    enabled: true,
    bucket: 'bucket-a',
    accessKeyId: 'access-a',
    secretAccessKey: 'secret-a',
    password: 'password-a',
  });
  repo.save('/vault/b', {
    enabled: true,
    bucket: 'bucket-b',
    accessKeyId: 'access-b',
    secretAccessKey: 'secret-b',
  });

  assert.deepEqual(repo.read('/vault/a'), {
    enabled: true,
    bucket: 'bucket-a',
    prefix: 'wikinest-sync/',
    endpoint: '',
    region: 'auto',
    forcePathStyle: false,
    accessKeyId: 'access-a',
    secretAccessKey: 'secret-a',
    password: 'password-a',
  });
  assert.equal(repo.read('/vault/b').bucket, 'bucket-b');
  const persisted = store.get(vaultSyncKey('/vault/a'));
  assert.equal(typeof persisted.secretBlob, 'string');
  assert.doesNotMatch(JSON.stringify(persisted), /secret-a|password-a/);
});

test('renderer view is masked and empty secret input preserves existing values', () => {
  const repo = createSyncConfigRepository({ store: fakeStore(), safeStorage: fakeSafeStorage() });
  repo.save('/vault', {
    enabled: true,
    bucket: 'bucket',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
    password: 'password',
  });
  repo.save('/vault', {
    enabled: true,
    bucket: 'changed',
    accessKeyId: 'access',
    secretAccessKey: '',
    password: '',
  });
  assert.equal(repo.read('/vault').secretAccessKey, 'secret');
  assert.equal(repo.read('/vault').password, 'password');
  assert.deepEqual(repo.readForRenderer('/vault'), {
    enabled: true,
    bucket: 'changed',
    prefix: 'wikinest-sync/',
    endpoint: '',
    region: 'auto',
    forcePathStyle: false,
    accessKeyId: 'access',
    hasSecretAccessKey: true,
    hasPassword: true,
    mode: 'encrypted',
  });
  const serialized = JSON.stringify(repo.readForRenderer('/vault'));
  assert.doesNotMatch(serialized, /"secret"|"password"/i);
});

test('explicit clear removes secrets and delete removes the vault entry', () => {
  const store = fakeStore();
  const repo = createSyncConfigRepository({ store, safeStorage: fakeSafeStorage() });
  repo.save('/vault', {
    bucket: 'bucket',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
    password: 'password',
  });
  repo.save('/vault', {
    bucket: 'bucket',
    accessKeyId: 'access',
    clearSecretAccessKey: true,
    clearPassword: true,
  });
  assert.equal(repo.read('/vault').secretAccessKey, '');
  assert.equal(repo.read('/vault').password, '');
  assert.equal(store.get(vaultSyncKey('/vault')).secretBlob, undefined);
  repo.delete('/vault');
  assert.equal(store.get(vaultSyncKey('/vault')), undefined);
});

test('unavailable safe storage rejects adding and reading secrets but masked flags remain readable', () => {
  const store = fakeStore();
  const availableRepo = createSyncConfigRepository({ store, safeStorage: fakeSafeStorage() });
  availableRepo.save('/vault', {
    enabled: true,
    bucket: 'bucket',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  });
  const unavailableRepo = createSyncConfigRepository({ store, safeStorage: fakeSafeStorage(false) });
  assert.throws(() => unavailableRepo.read('/vault'), /secure storage|安全存储/i);
  assert.equal(unavailableRepo.readForRenderer('/vault').hasSecretAccessKey, true);
  assert.throws(
    () => unavailableRepo.save('/other', { secretAccessKey: 'new-secret' }),
    /secure storage|安全存储/i,
  );
});

test('disabled config does not decrypt a leftover secret blob', () => {
  const store = fakeStore();
  const availableRepo = createSyncConfigRepository({ store, safeStorage: fakeSafeStorage() });
  availableRepo.save('/vault', {
    bucket: 'bucket',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  });
  const key = vaultSyncKey('/vault');
  store.set(key, { ...store.get(key), enabled: false });
  const unavailableRepo = createSyncConfigRepository({ store, safeStorage: fakeSafeStorage(false) });
  assert.deepEqual(unavailableRepo.read('/vault'), {
    enabled: false,
    bucket: 'bucket',
    prefix: 'wikinest-sync/',
    endpoint: '',
    region: 'auto',
    forcePathStyle: false,
    accessKeyId: 'access',
    secretAccessKey: '',
    password: '',
  });
});

test('basic_text safe storage backend is rejected for secrets', () => {
  const store = fakeStore();
  const repo = createSyncConfigRepository({
    store,
    safeStorage: fakeSafeStorage(true, 'basic_text'),
  });
  assert.throws(
    () => repo.save('/vault', { secretAccessKey: 'secret' }),
    /secure storage|安全存储/i,
  );
});

test('preview validates a merged update without persisting it', () => {
  const store = fakeStore();
  const repo = createSyncConfigRepository({ store, safeStorage: fakeSafeStorage() });
  repo.save('/vault', {
    enabled: true,
    bucket: 'old',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  });
  const candidate = repo.preview('/vault', {
    enabled: true,
    bucket: 'new',
    accessKeyId: 'access',
    secretAccessKey: '',
  });
  assert.equal(candidate.bucket, 'new');
  assert.equal(candidate.secretAccessKey, 'secret');
  assert.equal(repo.read('/vault').bucket, 'old');
});

test('strict validation applies defaults and rejects unsafe endpoint, prefix, types and missing fields', () => {
  assert.deepEqual(normalizeSyncConfig({}), {
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
  for (const endpoint of ['http://example.com', 'ftp://localhost/x', 'https://']) {
    assert.throws(() => normalizeSyncConfig({ endpoint }), /endpoint|HTTPS/i);
  }
  for (const endpoint of ['https://s3.example.com?x=1', 'https://s3.example.com/#fragment']) {
    assert.throws(() => normalizeSyncConfig({ endpoint }), /endpoint|query|fragment/i);
  }
  for (const endpoint of ['http://localhost:9000', 'http://127.0.0.1:9000', 'http://[::1]:9000']) {
    assert.equal(normalizeSyncConfig({ endpoint }).endpoint, endpoint);
  }
  for (const prefix of ['/root', '../escape', 'a\\b', 'a//b', './a']) {
    assert.throws(() => normalizeSyncConfig({ prefix }), /prefix/i);
  }
  assert.throws(() => normalizeSyncConfig({ forcePathStyle: 'true' }), /boolean/i);
  assert.throws(() => normalizeSyncConfig({ enabled: 1 }), /boolean/i);
  for (const field of ['bucket', 'prefix', 'endpoint', 'region', 'accessKeyId', 'secretAccessKey', 'password']) {
    assert.throws(() => normalizeSyncConfig({ [field]: 1 }), new RegExp(field, 'i'));
  }
  for (const field of ['clearSecretAccessKey', 'clearPassword']) {
    assert.throws(
      () => createSyncConfigRepository({ store: fakeStore(), safeStorage: fakeSafeStorage() })
        .preview('/vault', { [field]: 'true' }),
      /boolean/i,
    );
  }
  assert.throws(
    () => normalizeSyncConfig({ enabled: true, bucket: 'b', accessKeyId: 'a' }),
    /secretAccessKey/i,
  );
  assert.throws(() => normalizeSyncConfig({ unknown: true }), /field/i);
});
