import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDesktopSyncRuntime } from '../desktop/sync-runtime.js';
import { vaultSyncKey } from '../desktop/sync-config.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeTimers() {
  let id = 0;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeout(fn, ms) {
      const token = ++id;
      timeouts.set(token, { fn, ms });
      return token;
    },
    clearTimeout: (token) => timeouts.delete(token),
    setInterval(fn, ms) {
      const token = ++id;
      intervals.set(token, { fn, ms });
      return token;
    },
    clearInterval: (token) => intervals.delete(token),
    fireTimeout(ms) {
      const entry = [...timeouts].find(([, item]) => item.ms === ms);
      assert.ok(entry, `missing ${ms}ms timeout`);
      timeouts.delete(entry[0]);
      entry[1].fn();
    },
    fireInterval(ms) {
      const entry = [...intervals].find(([, item]) => item.ms === ms);
      assert.ok(entry, `missing ${ms}ms interval`);
      entry[1].fn();
    },
    timeoutCount: () => timeouts.size,
    intervalCount: () => intervals.size,
  };
}

function setup({ sync, now } = {}) {
  const timers = fakeTimers();
  const calls = [];
  let mutationObserver = null;
  let unregistered = 0;
  let observerRegistrations = 0;
  const engine = {
    sync: sync ?? (async () => {
      calls.push('sync');
      return {};
    }),
    close: () => calls.push('close'),
    getStatus: () => ({ state: 'synced', error: null }),
  };
  const factoryArgs = [];
  const runtime = createDesktopSyncRuntime({
    stateRoot: '/state',
    createEngine: (args) => {
      factoryArgs.push(args);
      return engine;
    },
    createRemote: (config) => ({
      config,
      namespaceId: `remote:${config.endpoint || 'aws'}:${config.region}:${config.bucket}:${config.prefix}`,
    }),
    createStateStore: (args) => ({ args }),
    createLocal: () => ({ local: true }),
    setMutationObserver: (observer) => {
      observerRegistrations += 1;
      mutationObserver = observer;
      return () => {
        mutationObserver = null;
        unregistered += 1;
      };
    },
    timers,
    now,
  });
  return {
    runtime,
    timers,
    calls,
    factoryArgs,
    engine,
    mutate: () => mutationObserver?.({ type: 'write' }),
    observer: () => mutationObserver,
    unregistered: () => unregistered,
    observerRegistrations: () => observerRegistrations,
  };
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

function remoteStateKey(config) {
  const namespaceId = `remote:${config.endpoint || 'aws'}:${config.region}:${config.bucket}:${config.prefix}`;
  return createHash('sha256').update(namespaceId).digest('hex');
}

test('successful sync records injected updatedAt and later states preserve it', async () => {
  const timestamp = new Date('2026-07-20T08:00:00.000Z');
  let nowCalls = 0;
  const ctx = setup({ now: () => {
    nowCalls += 1;
    return timestamp;
  } });
  assert.deepEqual(ctx.runtime.getStatus(), {
    state: 'disabled',
    error: null,
    updatedAt: null,
  });
  await ctx.runtime.start({ vaultDir: '/vault', config: CONFIG });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ctx.runtime.getStatus(), {
    state: 'synced',
    error: null,
    updatedAt: timestamp.toISOString(),
  });
  assert.equal(nowCalls, 1);
  ctx.factoryArgs[0].onStatus({ state: 'synced', error: null });
  assert.equal(nowCalls, 1);
  ctx.factoryArgs[0].onStatus({ state: 'pending', error: null });
  assert.deepEqual(ctx.runtime.getStatus(), {
    state: 'pending',
    error: null,
    updatedAt: timestamp.toISOString(),
  });
  ctx.runtime.reportError(new Error('offline'));
  assert.deepEqual(ctx.runtime.getStatus(), {
    state: 'error',
    error: 'offline',
    updatedAt: timestamp.toISOString(),
  });
});

test('start wires isolated adapters, syncs immediately, and retries every 60 seconds', async () => {
  const ctx = setup();
  await ctx.runtime.start({ vaultDir: '/vault/a', config: CONFIG });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.calls.filter((item) => item === 'sync').length, 1);
  assert.equal(ctx.timers.intervalCount(), 1);
  assert.equal(ctx.factoryArgs[0].stateStore.args.stateDir, path.join(
    '/state',
    vaultSyncKey('/vault/a'),
    remoteStateKey(CONFIG),
  ));
  assert.equal(ctx.factoryArgs[0].password, '');
  assert.deepEqual(ctx.factoryArgs[0].remote.config.credentials, {
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  });

  ctx.timers.fireInterval(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.calls.filter((item) => item === 'sync').length, 2);
});

test('local mutations debounce for two seconds', async () => {
  const ctx = setup();
  await ctx.runtime.start({ vaultDir: '/vault', config: CONFIG });
  await new Promise((resolve) => setImmediate(resolve));
  ctx.mutate();
  ctx.mutate();
  assert.equal(ctx.timers.timeoutCount(), 1);
  ctx.timers.fireTimeout(2_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.calls.filter((item) => item === 'sync').length, 2);
});

test('慢同步期间写入在 debounce 后只补跑一次且无需等待 interval', async () => {
  const first = deferred();
  let attempts = 0;
  const ctx = setup({
    sync: () => {
      attempts += 1;
      return attempts === 1 ? first.promise : Promise.resolve({});
    },
  });
  await ctx.runtime.start({ vaultDir: '/vault', config: CONFIG });
  ctx.mutate();
  ctx.mutate();
  ctx.timers.fireTimeout(2_000);
  assert.equal(attempts, 1);

  first.resolve({});
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 2);
});

test('all triggers share one in-flight sync and a later interval retries after failure', async () => {
  const first = deferred();
  let attempts = 0;
  const ctx = setup({
    sync: () => {
      attempts += 1;
      if (attempts === 1) return first.promise;
      if (attempts === 2) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true });
    },
  });
  await ctx.runtime.start({ vaultDir: '/vault', config: CONFIG });
  const manual = ctx.runtime.syncNow();
  ctx.timers.fireInterval(60_000);
  assert.equal(attempts, 1);
  first.resolve({});
  await manual;

  ctx.timers.fireInterval(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.runtime.getStatus().state, 'error');
  assert.match(ctx.runtime.getStatus().error, /offline/);
  ctx.timers.fireInterval(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 3);
  assert.equal(ctx.runtime.getStatus().state, 'synced');
});

test('syncNow waits for reconfigure and runs on the replacement engine', async () => {
  const oldFinalEntered = deferred();
  const releaseOldFinal = deferred();
  let engineCount = 0;
  let firstAttempts = 0;
  const runtime = createDesktopSyncRuntime({
    stateRoot: '/state',
    createRemote: (config) => ({ namespaceId: config.prefix }),
    createStateStore: () => ({}),
    createLocal: () => ({}),
    setMutationObserver: () => () => {},
    createEngine: () => {
      engineCount += 1;
      const engineId = engineCount;
      return {
        async sync() {
          if (engineId === 1) {
            firstAttempts += 1;
            if (firstAttempts === 2) {
              oldFinalEntered.resolve();
              await releaseOldFinal.promise;
            }
          }
          return { engineId };
        },
        close: () => {},
      };
    },
  });
  await runtime.start({ vaultDir: '/vault', config: CONFIG });
  await new Promise((resolve) => setImmediate(resolve));

  const reconfiguring = runtime.reconfigure({
    vaultDir: '/vault',
    config: { ...CONFIG, prefix: 'replacement/' },
  });
  await oldFinalEntered.promise;
  const manual = runtime.syncNow();
  releaseOldFinal.resolve();

  await reconfiguring;
  const result = await manual;
  await runtime.stop();
  assert.deepEqual(result, { engineId: 2 });
});

test('stop clears scheduling and observer, waits for final sync, and closes engine', async () => {
  const last = deferred();
  let attempts = 0;
  const ctx = setup({
    sync: () => {
      attempts += 1;
      return attempts === 1 ? Promise.resolve({}) : last.promise;
    },
  });
  await ctx.runtime.start({ vaultDir: '/vault', config: CONFIG });
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = ctx.runtime.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.timers.intervalCount(), 0);
  assert.equal(ctx.observer(), null);
  assert.equal(ctx.unregistered(), 1);
  assert.equal(attempts, 2);
  last.resolve({});
  assert.equal(await stopping, true);
  assert.ok(ctx.calls.includes('close'));
});

test('stop returns false after 15 seconds instead of blocking forever', async () => {
  const never = deferred();
  const ctx = setup({ sync: () => never.promise });
  await ctx.runtime.start({ vaultDir: '/vault', config: CONFIG });
  const stopping = ctx.runtime.stop();
  await Promise.resolve();
  ctx.timers.fireTimeout(15_000);
  assert.equal(await stopping, false);
  assert.equal(ctx.timers.intervalCount(), 0);
  assert.equal(ctx.observer(), null);
});

test('forceStop closes a timed-out engine before shutdown may continue', async () => {
  const never = deferred();
  const ctx = setup({ sync: () => never.promise });
  await ctx.runtime.start({ vaultDir: '/vault', config: CONFIG });
  const stopping = ctx.runtime.stop();
  await Promise.resolve();
  ctx.timers.fireTimeout(15_000);
  assert.equal(await stopping, false);

  assert.equal(await ctx.runtime.forceStop(), true);
  assert.ok(ctx.calls.includes('close'));
  assert.equal(ctx.runtime.getStatus().state, 'stopped');
  await assert.rejects(ctx.runtime.syncNow(), /not active/i);
});

test('resume restores one observer and interval after timed-out stop without rebuilding the engine', async () => {
  const first = deferred();
  let attempts = 0;
  const ctx = setup({
    sync: () => {
      attempts += 1;
      return attempts === 1 ? first.promise : Promise.resolve({});
    },
  });
  await ctx.runtime.start({ vaultDir: '/vault', config: CONFIG });
  const stopping = ctx.runtime.stop();
  await Promise.resolve();
  ctx.timers.fireTimeout(15_000);
  assert.equal(await stopping, false);
  assert.equal(ctx.observer(), null);

  assert.equal(await ctx.runtime.resume(), true);
  assert.equal(ctx.observerRegistrations(), 2);
  assert.equal(ctx.timers.intervalCount(), 1);
  assert.equal(ctx.factoryArgs.length, 1);
  ctx.mutate();
  ctx.timers.fireTimeout(2_000);
  first.resolve({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  ctx.timers.fireInterval(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 3);
  assert.equal(ctx.observerRegistrations(), 2);
});

test('resume rejects when runtime stopped cleanly or was never started', async () => {
  const inactive = setup();
  await assert.rejects(inactive.runtime.resume(), /not resumable/i);

  const ctx = setup();
  await ctx.runtime.start({ vaultDir: '/vault', config: CONFIG });
  await ctx.runtime.stop();
  await assert.rejects(ctx.runtime.resume(), /not resumable/i);
});

test('disabled start remains inert and reconfigure replaces an active engine', async () => {
  const ctx = setup();
  await ctx.runtime.start({ vaultDir: '/vault', config: { ...CONFIG, enabled: false } });
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.runtime.getStatus().state, 'disabled');
  await ctx.runtime.reconfigure({ vaultDir: '/vault', config: CONFIG });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.calls.filter((item) => item === 'sync').length, 1);
});

test('reconfigure 到新 prefix 使用独立 state，access key 轮换仍复用原 state', async () => {
  const ctx = setup();
  await ctx.runtime.start({ vaultDir: '/vault', config: CONFIG });
  await new Promise((resolve) => setImmediate(resolve));
  const firstDir = ctx.factoryArgs[0].stateStore.args.stateDir;

  await ctx.runtime.reconfigure({
    vaultDir: '/vault',
    config: { ...CONFIG, accessKeyId: 'rotated', secretAccessKey: 'rotated-secret' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.factoryArgs[1].stateStore.args.stateDir, firstDir);

  await ctx.runtime.reconfigure({
    vaultDir: '/vault',
    config: { ...CONFIG, prefix: 'new-empty-prefix/' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(ctx.factoryArgs[2].stateStore.args.stateDir, firstDir);
});

test('同一本地 vault 的两个 remote 使用彼此独立的 state 目录', async () => {
  const ctx = setup();
  await ctx.runtime.start({ vaultDir: '/vault', config: CONFIG });
  await new Promise((resolve) => setImmediate(resolve));
  const firstDir = ctx.factoryArgs[0].stateStore.args.stateDir;
  await ctx.runtime.reconfigure({
    vaultDir: '/vault',
    config: { ...CONFIG, endpoint: 'https://second.example.com' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(ctx.factoryArgs[1].stateStore.args.stateDir, firstDir);
});

test('reportError records a startup error without activating an engine', () => {
  const ctx = setup();
  ctx.runtime.reportError(new Error('secure storage unavailable'));
  assert.deepEqual(ctx.runtime.getStatus(), {
    state: 'error',
    error: 'secure storage unavailable',
    updatedAt: null,
  });
  assert.equal(ctx.calls.length, 0);
});

test('timed out stop retains its generation and blocks reconfigure until it finishes', async () => {
  const timers = fakeTimers();
  const blocked = deferred();
  let engineCount = 0;
  const runtime = createDesktopSyncRuntime({
    stateRoot: '/state',
    timers,
    createRemote: () => ({}),
    createStateStore: () => ({}),
    createLocal: () => ({}),
    setMutationObserver: () => () => {},
    createEngine: () => {
      engineCount += 1;
      return {
        sync: () => blocked.promise,
        close: () => {},
      };
    },
  });
  await runtime.start({ vaultDir: '/vault', config: CONFIG });
  const stopping = runtime.stop();
  await Promise.resolve();
  timers.fireTimeout(15_000);
  assert.equal(await stopping, false);
  assert.equal(engineCount, 1);
  await assert.rejects(
    runtime.reconfigure({ vaultDir: '/vault', config: CONFIG }),
    /still stopping|timed out|active/i,
  );
  assert.equal(engineCount, 1);

  blocked.resolve({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await runtime.stop(), true);
});

test('stale generation status callbacks cannot overwrite a newer engine status', async () => {
  const callbacks = [];
  const engines = [];
  const runtime = createDesktopSyncRuntime({
    stateRoot: '/state',
    createRemote: () => ({}),
    createStateStore: () => ({}),
    createLocal: () => ({}),
    setMutationObserver: () => () => {},
    createEngine: ({ onStatus }) => {
      callbacks.push(onStatus);
      const engine = { sync: async () => ({}), close: () => {} };
      engines.push(engine);
      return engine;
    },
  });
  await runtime.start({ vaultDir: '/vault', config: CONFIG });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await runtime.stop(), true);
  await runtime.start({ vaultDir: '/vault', config: CONFIG });
  await new Promise((resolve) => setImmediate(resolve));
  callbacks[0]({ state: 'error', error: new Error('old failure') });
  assert.notEqual(runtime.getStatus().error, 'old failure');
  assert.equal(engines.length, 2);
  await runtime.stop();
});
