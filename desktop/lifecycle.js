const FLUSH_CHANNEL = 'editor:flush-result';
const FLUSH_TIMEOUT_MS = 15_000;

function validResult(payload, requestId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.some((key) => !['requestId', 'ok', 'code'].includes(key))) return null;
  if (payload.requestId !== requestId || typeof payload.ok !== 'boolean') return null;
  if (payload.ok && payload.code !== undefined) return null;
  if (!payload.ok && (typeof payload.code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(payload.code))) {
    return null;
  }
  return { ok: payload.ok, code: payload.ok ? 'OK' : payload.code };
}

export function createEditorFlushHandshake({
  ipcMain,
  assertTrustedSender,
  getMainWindow,
  createRequestId = () => crypto.randomUUID(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  timeoutMs = FLUSH_TIMEOUT_MS,
  maxRequestIdAttempts = 4,
} = {}) {
  if (!ipcMain?.on || !ipcMain?.removeListener) throw new TypeError('ipcMain is required');
  if (typeof assertTrustedSender !== 'function') throw new TypeError('assertTrustedSender is required');
  if (typeof getMainWindow !== 'function') throw new TypeError('getMainWindow is required');

  const pending = new Map();
  const settle = (requestId, result) => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimer(entry.timer);
    ipcMain.removeListener(FLUSH_CHANNEL, entry.listener);
    for (const event of ['destroyed', 'render-process-gone', 'crashed']) {
      entry.webContents.removeListener?.(event, entry.destroyListener);
    }
    entry.resolve(result);
    return true;
  };

  return Object.freeze({
    requestFlush() {
      const win = getMainWindow();
      const webContents = win?.webContents;
      if (!win || win.isDestroyed?.() || !webContents || webContents.isDestroyed?.()) {
        return Promise.resolve({ ok: true, code: 'OK' });
      }
      let requestId;
      for (let attempt = 0; attempt < maxRequestIdAttempts; attempt += 1) {
        const candidate = createRequestId();
        if (typeof candidate !== 'string' || candidate.length < 8) {
          throw new Error('flush request ID must be unpredictable');
        }
        if (!pending.has(candidate)) {
          requestId = candidate;
          break;
        }
      }
      if (!requestId) throw new Error('flush request ID collision');
      return new Promise((resolve) => {
        const listener = (event, payload) => {
          try {
            assertTrustedSender(event);
          } catch {
            return;
          }
          if (event?.sender !== webContents) return;
          const result = validResult(payload, requestId);
          if (result) settle(requestId, result);
        };
        const timer = setTimer(() => {
          settle(requestId, { ok: false, code: 'EDITOR_FLUSH_TIMEOUT' });
        }, timeoutMs);
        const destroyListener = () => {
          settle(requestId, { ok: false, code: 'EDITOR_FLUSH_UNAVAILABLE' });
        };
        pending.set(requestId, {
          resolve, listener, timer, webContents, destroyListener,
        });
        ipcMain.on(FLUSH_CHANNEL, listener);
        for (const event of ['destroyed', 'render-process-gone', 'crashed']) {
          webContents.once?.(event, destroyListener);
        }
        try {
          webContents.send('editor:flush-request', { requestId });
        } catch {
          settle(requestId, { ok: false, code: 'EDITOR_FLUSH_UNAVAILABLE' });
        }
      });
    },
    pendingCount() {
      return pending.size;
    },
  });
}

export function createDesktopShutdownController({
  flushEditor,
  stopSync,
  confirmContinue,
  quit,
  relaunch,
  persistVault,
  onDecision = () => {},
  resumeSync = async () => true,
  onResumeFailure = async () => {},
  canShowConfirmation = () => true,
} = {}) {
  for (const [name, value] of Object.entries({
    flushEditor, stopSync, confirmContinue, quit, relaunch, persistVault, resumeSync, onResumeFailure,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  }
  let active = null;
  const confirm = async (detail) => (canShowConfirmation() ? confirmContinue(detail) : true);

  const run = (kind, vaultDir) => {
    if (active) return active;
    active = (async () => {
      const flush = await flushEditor();
      if (!flush?.ok && !(await confirm({ kind, code: flush?.code || 'EDITOR_FLUSH_FAILED' }))) {
        return false;
      }
      const stopped = await stopSync();
      if (!stopped && !(await confirm({ kind, code: 'SYNC_STOP_TIMEOUT' }))) {
        try {
          if (await resumeSync()) return false;
        } catch {
          // The error is reported below as a recoverability failure.
        }
        await onResumeFailure({ kind, code: 'SYNC_RESUME_FAILED' });
        return false;
      }
      onDecision({ kind, vaultDir });
      if (kind === 'vault') {
        persistVault(vaultDir);
        relaunch();
      }
      quit();
      return true;
    })().finally(() => { active = null; });
    return active;
  };

  return Object.freeze({
    quit: () => run('quit'),
    switchVault: (vaultDir) => run('vault', vaultDir),
    isActive: () => Boolean(active),
  });
}

export function installDesktopCloseGuards({
  app,
  getController,
  getAllowQuit,
} = {}) {
  if (!app?.on) throw new TypeError('app is required');
  if (typeof getController !== 'function') throw new TypeError('getController is required');
  if (typeof getAllowQuit !== 'function') throw new TypeError('getAllowQuit is required');

  const requestShutdown = () => {
    void getController()?.quit();
  };
  const beforeQuit = (event) => {
    if (getAllowQuit()) return;
    event.preventDefault();
    requestShutdown();
  };
  app.on('before-quit', beforeQuit);

  return Object.freeze({
    bindWindow(win) {
      if (!win?.on) throw new TypeError('window is required');
      const close = (event) => {
        if (getAllowQuit()) return;
        event.preventDefault();
        requestShutdown();
      };
      win.on('close', close);
      return () => win.removeListener?.('close', close);
    },
    dispose() {
      app.removeListener?.('before-quit', beforeQuit);
    },
  });
}
