import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSyncMeta } from '../src/core/sync/crypto.js';
import { createSyncIpcHandlers, validateRemoteSyncConfig } from '../desktop/sync-ipc.js';

const MAIN_SOURCE = readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
const PRELOAD_SOURCE = readFileSync(new URL('../desktop/settings-preload.cjs', import.meta.url), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const CONFIG = {
  enabled: true,
  bucket: 'bucket',
  prefix: 'sync/',
  endpoint: '',
  region: 'auto',
  forcePathStyle: false,
  accessKeyId: 'access',
  secretAccessKey: 'secret',
  password: '',
};

test('remote validation probes S3, accepts missing meta, and never initializes it', async () => {
  const calls = [];
  const remote = {
    testConnection: async () => calls.push('probe'),
    get: async (key) => {
      calls.push(`get:${key}`);
      throw Object.assign(new Error('missing'), { code: 'NoSuchKey' });
    },
    put: async () => calls.push('put'),
  };
  assert.deepEqual(await validateRemoteSyncConfig(CONFIG, { createRemote: () => remote }), {
    ok: true,
    mode: 'uninitialized',
  });
  assert.deepEqual(calls, ['probe', 'get:v1/meta.json']);
});

test('remote validation enforces existing plaintext/encrypted mode and password', async () => {
  const plaintext = await createSyncMeta({ vaultId: 'vault', password: '' });
  const encrypted = await createSyncMeta({ vaultId: 'vault', password: 'correct' });
  const withMeta = (meta) => ({
    testConnection: async () => true,
    get: async () => Buffer.from(JSON.stringify(meta)),
  });
  await assert.rejects(
    validateRemoteSyncConfig({ ...CONFIG, password: 'new' }, {
      createRemote: () => withMeta(plaintext),
    }),
    /plaintext|password/i,
  );
  await assert.rejects(
    validateRemoteSyncConfig({ ...CONFIG, password: '' }, {
      createRemote: () => withMeta(encrypted),
    }),
    /password/i,
  );
  await assert.rejects(
    validateRemoteSyncConfig({ ...CONFIG, password: 'wrong' }, {
      createRemote: () => withMeta(encrypted),
    }),
    /password|tampered/i,
  );
  assert.equal((await validateRemoteSyncConfig({ ...CONFIG, password: 'correct' }, {
    createRemote: () => withMeta(encrypted),
  })).mode, 'encrypted');
});

test('IPC get is masked and save validates before persistence and hot reconfigure', async () => {
  const order = [];
  const handlers = new Map();
  const repository = {
    readForRenderer: () => ({
      enabled: true,
      hasSecretAccessKey: true,
      hasPassword: true,
      mode: 'encrypted',
    }),
    read: () => CONFIG,
    preview: (_vault, data) => {
      order.push('preview');
      return CONFIG;
    },
    save: () => {
      order.push('save');
      return CONFIG;
    },
    delete: () => order.push('delete'),
  };
  const runtime = {
    getStatus: () => ({ state: 'synced', error: null }),
    reconfigure: async () => order.push('reconfigure'),
    syncNow: async () => ({ uploadedSegments: 1 }),
  };
  createSyncIpcHandlers({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    getVaultDir: () => '/vault',
    repository,
    runtime,
    validate: async () => order.push('validate'),
  });
  assert.deepEqual([...handlers.keys()].sort(), ['sync:get', 'sync:now', 'sync:save', 'sync:test']);
  const getResult = await handlers.get('sync:get')();
  assert.equal(getResult.hasSecretAccessKey, true);
  assert.equal(getResult.secretAccessKey, undefined);
  assert.deepEqual(getResult.status, { state: 'synced', error: null });
  await handlers.get('sync:save')(null, { enabled: true });
  assert.deepEqual(order, ['preview', 'validate', 'save', 'reconfigure']);
});

test('failed validation leaves persisted config and runtime untouched', async () => {
  const calls = [];
  const handlers = new Map();
  createSyncIpcHandlers({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    getVaultDir: () => '/vault',
    repository: {
      preview: () => CONFIG,
      save: () => calls.push('save'),
      read: () => CONFIG,
      readForRenderer: () => ({}),
    },
    runtime: {
      getStatus: () => ({ state: 'disabled', error: null }),
      reconfigure: () => calls.push('reconfigure'),
      syncNow: async () => {},
    },
    validate: async () => {
      throw new Error('wrong password');
    },
  });
  await assert.rejects(handlers.get('sync:save')(null, CONFIG), /wrong password/);
  assert.deepEqual(calls, []);
});

test('IPC rejects unknown fields and non-boolean clear flags', async () => {
  const handlers = new Map();
  createSyncIpcHandlers({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    getVaultDir: () => '/vault',
    repository: {
      read: () => CONFIG,
      preview: () => CONFIG,
      readForRenderer: () => ({}),
    },
    runtime: {
      getStatus: () => ({}),
      reconfigure: async () => {},
      syncNow: async () => {},
    },
  });
  await assert.rejects(
    Promise.resolve().then(() => handlers.get('sync:save')({}, { enabled: true, stateDir: '/evil' })),
    /invalid field|unknown field/i,
  );
  await assert.rejects(
    Promise.resolve().then(() => handlers.get('sync:test')({}, { clearPassword: 'true' })),
    /boolean/i,
  );
});

test('untrusted sender is rejected before repository or runtime side effects', async () => {
  const handlers = new Map();
  const calls = [];
  createSyncIpcHandlers({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    getVaultDir: () => {
      calls.push('vault');
      return '/vault';
    },
    repository: {
      readForRenderer: () => calls.push('read'),
      preview: () => calls.push('preview'),
    },
    runtime: {
      getStatus: () => calls.push('status'),
      syncNow: () => calls.push('sync'),
    },
    assertTrustedSender: () => {
      throw new Error('untrusted sync IPC sender');
    },
  });
  for (const channel of ['sync:get', 'sync:save', 'sync:test', 'sync:now']) {
    await assert.rejects(Promise.resolve().then(() => handlers.get(channel)({ senderFrame: {} }, {})), /untrusted/i);
  }
  assert.deepEqual(calls, []);
});

test('concurrent sync saves execute as serialized transactions', async () => {
  const handlers = new Map();
  const firstValidation = deferred();
  const order = [];
  let validations = 0;
  createSyncIpcHandlers({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    getVaultDir: () => '/vault',
    repository: {
      read: () => CONFIG,
      preview: (_vault, payload) => {
        order.push(`preview:${payload.bucket}`);
        return { ...CONFIG, bucket: payload.bucket };
      },
      save: (_vault, payload) => order.push(`save:${payload.bucket}`),
      readForRenderer: () => ({}),
    },
    runtime: {
      getStatus: () => ({}),
      reconfigure: async ({ config }) => order.push(`runtime:${config.bucket}`),
      syncNow: async () => {},
    },
    validate: async () => {
      validations += 1;
      if (validations === 1) await firstValidation.promise;
    },
  });
  const first = handlers.get('sync:save')({}, { enabled: true, bucket: 'first' });
  const second = handlers.get('sync:save')({}, { enabled: true, bucket: 'second' });
  await Promise.resolve();
  assert.deepEqual(order, ['preview:first']);
  firstValidation.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    'preview:first', 'save:first', 'runtime:first',
    'preview:second', 'save:second', 'runtime:second',
  ]);
});

test('rollback failure preserves primary and rollback errors in AggregateError', async () => {
  const handlers = new Map();
  let saves = 0;
  createSyncIpcHandlers({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    getVaultDir: () => '/vault',
    repository: {
      read: () => CONFIG,
      preview: () => ({ ...CONFIG, bucket: 'new' }),
      save: () => {
        saves += 1;
        if (saves === 2) throw new Error('rollback persist failed');
      },
      readForRenderer: () => ({}),
    },
    runtime: {
      getStatus: () => ({}),
      reconfigure: async () => {
        throw new Error('new runtime failed');
      },
      syncNow: async () => {},
    },
    validate: async () => {},
  });
  await assert.rejects(
    handlers.get('sync:save')({}, CONFIG),
    (error) => error instanceof AggregateError
      && error.errors.some((item) => /new runtime failed/.test(item.message))
      && error.errors.some((item) => /rollback persist failed/.test(item.message)),
  );
});

test('main starts sync after backend, broadcasts status, and flushes before quit or vault switch', () => {
  assert.match(MAIN_SOURCE, /new Store\(\{\s*name:\s*['"]vaultSync['"]/);
  assert.ok(
    MAIN_SOURCE.indexOf('await bootBackend') < MAIN_SOURCE.indexOf('syncRuntime.start'),
    'runtime must start after backend',
  );
  assert.match(MAIN_SOURCE, /webContents\.send\(['"]sync-status['"]/);
  assert.match(MAIN_SOURCE, /installDesktopCloseGuards/);
  assert.match(MAIN_SOURCE, /closeGuards\?\.bindWindow\(win\)/);
  assert.match(MAIN_SOURCE, /await syncRuntime\.stop\(\)/);
  assert.doesNotMatch(MAIN_SOURCE, /app\.exit\(/);
});

test('main contains startup recovery, trusted sender checks, navigation guards, and one-time init', () => {
  assert.match(MAIN_SOURCE, /syncConfig\.read\(vaultDir\)/);
  assert.match(MAIN_SOURCE, /syncRuntime\.reportError\(/);
  assert.match(MAIN_SOURCE, /assertTrustedSender/);
  assert.match(MAIN_SOURCE, /installPreloadNavigationGuards/);
  assert.match(MAIN_SOURCE, /createSettingsIpcHandlers/);
  assert.doesNotMatch(MAIN_SOURCE, /ipcMain\.handle\(['"]settings:/);
  assert.match(MAIN_SOURCE, /initializationPromise/);
  assert.match(MAIN_SOURCE, /windowCreationPromise/);
  assert.match(MAIN_SOURCE, /app\.on\(['"]activate['"][\s\S]*if \(!mainWin \|\| mainWin\.isDestroyed\(\)\) createWindow\(\)/);
  assert.match(MAIN_SOURCE, /\.finally\(\(\)\s*=>\s*\{[\s\S]*allowQuit\s*=\s*true[\s\S]*app\.quit\(\)/);
});

test('preload exposes only named sync methods and validates status callbacks', () => {
  for (const contract of ['syncGet', 'syncSave', 'syncTest', 'syncNow', 'onSyncStatus']) {
    assert.match(PRELOAD_SOURCE, new RegExp(`${contract}\\s*:`));
  }
  assert.match(PRELOAD_SOURCE, /typeof cb !== ['"]function['"]/);
  assert.match(PRELOAD_SOURCE, /ipcRenderer\.on\(['"]sync-status['"]/);
  assert.match(PRELOAD_SOURCE, /return \(\) => ipcRenderer\.removeListener\(['"]sync-status['"], listener\)/);
  assert.doesNotMatch(PRELOAD_SOURCE, /exposeInMainWorld\([^)]*ipcRenderer/s);
});
