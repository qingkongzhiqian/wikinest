import path from 'node:path';
import { createHash } from 'node:crypto';
import { createS3Adapter } from '../src/core/sync/s3-client.js';
import {
  createJsonFileStateStore,
  createStoreLocalAdapter,
  createSyncEngine,
} from '../src/core/sync/engine.js';
import { vaultSyncKey } from './sync-config.js';

const INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 2_000;
const STOP_TIMEOUT_MS = 15_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createDesktopSyncRuntime({
  stateRoot,
  createRemote = createS3Adapter,
  createStateStore = createJsonFileStateStore,
  createLocal = createStoreLocalAdapter,
  createEngine = createSyncEngine,
  setMutationObserver: observeMutations,
  timers = globalThis,
  onStatus,
  now = () => new Date(),
} = {}) {
  if (typeof stateRoot !== 'string' || !stateRoot) throw new Error('stateRoot is required');

  let generation = null;
  let nextGeneration = 0;
  let interval = null;
  let debounce = null;
  let unregister = null;
  let registerMutationObserver = null;
  let updatedAt = null;
  let status = Object.freeze({ state: 'disabled', error: null, updatedAt });
  let lifecycle = Promise.resolve();

  function updateStatus(state, error = null) {
    if (state === 'synced' && status.state !== 'synced') updatedAt = now().toISOString();
    status = Object.freeze({
      state,
      error: error ? errorMessage(error) : null,
      updatedAt,
    });
    try {
      Promise.resolve(onStatus?.(status)).catch(() => {});
    } catch {
      // Status delivery must not affect synchronization.
    }
  }

  function runSync(active = generation) {
    if (!active || generation !== active) {
      return Promise.reject(new Error('sync runtime is not active'));
    }
    if (active.inFlight) return active.inFlight;
    updateStatus('syncing');
    const task = Promise.resolve()
      .then(() => active.engine.sync())
      .then((result) => {
        if (generation === active) updateStatus('synced');
        return result;
      })
      .catch((error) => {
        if (generation === active) updateStatus('error', error);
        throw error;
      })
      .finally(() => {
        if (active.inFlight === task) {
          active.inFlight = null;
          if (active.rerunRequested && generation === active) {
            active.rerunRequested = false;
            backgroundSync();
          }
        }
      });
    active.inFlight = task;
    return task;
  }

  function backgroundSync() {
    runSync().catch(() => {
      // Offline and transient failures stay visible in status; the interval retries.
    });
  }

  function registerTriggers(active) {
    if (generation !== active || unregister || interval !== null) return false;
    unregister = registerMutationObserver(() => {
      if (generation !== active) return;
      if (debounce !== null) timers.clearTimeout(debounce);
      debounce = timers.setTimeout(() => {
        debounce = null;
        if (generation !== active) return;
        if (active.inFlight) active.rerunRequested = true;
        else backgroundSync();
      }, DEBOUNCE_MS);
    });
    interval = timers.setInterval(backgroundSync, INTERVAL_MS);
    return true;
  }

  async function startNow({ vaultDir, config }) {
    if (generation) throw new Error('sync runtime is already started');
    if (!config?.enabled) {
      updateStatus('disabled');
      return;
    }
    const remote = createRemote({
      bucket: config.bucket,
      prefix: config.prefix,
      endpoint: config.endpoint || undefined,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    const stateStore = createStateStore({
      stateDir: path.join(
        stateRoot,
        vaultSyncKey(vaultDir),
        createHash('sha256').update(String(remote.namespaceId)).digest('hex'),
      ),
    });
    const active = {
      id: ++nextGeneration,
      engine: null,
      inFlight: null,
      rerunRequested: false,
      stopTimedOut: false,
    };
    active.engine = createEngine({
      password: config.password,
      remote,
      stateStore,
      local: createLocal(),
      onStatus: (next) => {
        if (generation === active) updateStatus(next.state, next.error);
      },
    });
    generation = active;
    registerMutationObserver = observeMutations
      ?? (await import('../src/core/store.js')).setMutationObserver;
    registerTriggers(active);
    backgroundSync();
  }

  async function resumeNow() {
    if (!generation?.stopTimedOut || !registerMutationObserver) {
      throw new Error('sync runtime is not resumable');
    }
    const active = generation;
    active.stopTimedOut = false;
    registerTriggers(active);
    return true;
  }

  async function stopNow() {
    if (interval !== null) {
      timers.clearInterval(interval);
      interval = null;
    }
    if (debounce !== null) {
      timers.clearTimeout(debounce);
      debounce = null;
    }
    unregister?.();
    unregister = null;
    if (!generation) {
      updateStatus('disabled');
      return true;
    }

    const active = generation;
    active.rerunRequested = false;
    if (active.stopTimedOut && active.inFlight) return false;
    active.stopTimedOut = false;
    let didTimeOut = false;
    const finish = (async () => {
      if (active.inFlight) {
        try {
          await active.inFlight;
        } catch {
          // A final attempt below may recover from a transient failure.
        }
      }
      if (!didTimeOut && generation === active) {
        try {
          await runSync(active);
        } catch {
          // Preserve the error status while still allowing shutdown.
        }
      }
    })();
    let timeout;
    const timedOut = new Promise((resolve) => {
      timeout = timers.setTimeout(() => {
        didTimeOut = true;
        active.stopTimedOut = true;
        resolve(false);
      }, STOP_TIMEOUT_MS);
    });
    const completed = finish.then(() => true);
    const clean = await Promise.race([completed, timedOut]);
    if (clean) timers.clearTimeout(timeout);
    if (clean) {
      active.engine.close?.();
      if (generation === active) generation = null;
      if (status.state !== 'error') updateStatus('stopped');
    }
    return clean;
  }

  function serialize(operation) {
    const result = lifecycle.then(operation, operation);
    lifecycle = result.catch(() => {});
    return result;
  }

  return {
    start(options) {
      return serialize(() => startNow(options));
    },
    syncNow() {
      return runSync();
    },
    reconfigure(options) {
      return serialize(async () => {
        const stopped = await stopNow();
        if (!stopped) throw new Error('previous sync engine is still stopping after timeout');
        await startNow(options);
      });
    },
    stop() {
      return serialize(stopNow);
    },
    resume() {
      return serialize(resumeNow);
    },
    getStatus() {
      return status;
    },
    reportError(error) {
      updateStatus('error', error);
    },
  };
}
