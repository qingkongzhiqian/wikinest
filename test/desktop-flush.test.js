import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createEditorFlushHandshake,
  createDesktopShutdownController,
  installDesktopCloseGuards,
} from '../desktop/lifecycle.js';

function fakeIpcMain() {
  const events = new EventEmitter();
  return {
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    emit: events.emit.bind(events),
    listenerCount: events.listenerCount.bind(events),
  };
}

test('flush handshake settles once for a trusted matching success reply', async () => {
  const ipcMain = fakeIpcMain();
  const sent = [];
  const webContents = { send: (...args) => sent.push(args), isDestroyed: () => false };
  const handshake = createEditorFlushHandshake({
    ipcMain,
    assertTrustedSender: () => {},
    getMainWindow: () => ({ webContents, isDestroyed: () => false }),
    createRequestId: () => 'unpredictable-id',
    setTimer: () => 1,
    clearTimer: () => {},
  });

  const result = handshake.requestFlush();
  assert.deepEqual(sent, [['editor:flush-request', { requestId: 'unpredictable-id' }]]);
  ipcMain.emit('editor:flush-result', { sender: webContents, senderFrame: { url: 'http://trusted/' } }, {
    requestId: 'unpredictable-id',
    ok: true,
  });
  assert.deepEqual(await result, { ok: true, code: 'OK' });
  assert.equal(ipcMain.listenerCount('editor:flush-result'), 0);
});

test('flush handshake rejects untrusted, mismatched, and payload-bearing replies until timeout', async () => {
  const ipcMain = fakeIpcMain();
  let timeout;
  const webContents = { send: () => {}, isDestroyed: () => false };
  const handshake = createEditorFlushHandshake({
    ipcMain,
    assertTrustedSender: (event) => {
      if (event.senderFrame.url !== 'http://trusted/') throw new Error('untrusted IPC sender');
    },
    getMainWindow: () => ({ webContents, isDestroyed: () => false }),
    createRequestId: () => 'request-id',
    setTimer: (callback) => {
      timeout = callback;
      return 1;
    },
    clearTimer: () => {},
  });

  const result = handshake.requestFlush();
  ipcMain.emit('editor:flush-result', { sender: webContents, senderFrame: { url: 'https://evil/' } }, {
    requestId: 'request-id', ok: true,
  });
  ipcMain.emit('editor:flush-result', { sender: webContents, senderFrame: { url: 'http://trusted/' } }, {
    requestId: 'wrong-id', ok: true,
  });
  ipcMain.emit('editor:flush-result', { sender: webContents, senderFrame: { url: 'http://trusted/' } }, {
    requestId: 'request-id', ok: true, markdown: 'exfiltrate',
  });
  timeout();
  assert.deepEqual(await result, { ok: false, code: 'EDITOR_FLUSH_TIMEOUT' });
  assert.equal(ipcMain.listenerCount('editor:flush-result'), 0);

  ipcMain.emit('editor:flush-result', { sender: webContents, senderFrame: { url: 'http://trusted/' } }, {
    requestId: 'request-id', ok: true,
  });
});

test('flush handshake returns the renderer failure code and treats no window as clean', async () => {
  const ipcMain = fakeIpcMain();
  const webContents = { send: () => {}, isDestroyed: () => false };
  const handshake = createEditorFlushHandshake({
    ipcMain,
    assertTrustedSender: () => {},
    getMainWindow: () => ({ webContents, isDestroyed: () => false }),
    createRequestId: () => 'request-id',
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const result = handshake.requestFlush();
  ipcMain.emit('editor:flush-result', { sender: webContents, senderFrame: { url: 'http://trusted/' } }, {
    requestId: 'request-id', ok: false, code: 'NOTE_VERSION_CONFLICT',
  });
  assert.deepEqual(await result, { ok: false, code: 'NOTE_VERSION_CONFLICT' });

  const headless = createEditorFlushHandshake({
    ipcMain: fakeIpcMain(),
    assertTrustedSender: () => {},
    getMainWindow: () => null,
  });
  assert.deepEqual(await headless.requestFlush(), { ok: true, code: 'OK' });
});

test('flush handshake settles immediately when its renderer is destroyed and ignores a late reply', async () => {
  const ipcMain = fakeIpcMain();
  const events = new EventEmitter();
  let cleared = 0;
  const webContents = {
    send: () => {},
    isDestroyed: () => false,
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
  };
  const handshake = createEditorFlushHandshake({
    ipcMain,
    assertTrustedSender: () => {},
    getMainWindow: () => ({ webContents, isDestroyed: () => false }),
    createRequestId: () => 'request-id',
    setTimer: () => 1,
    clearTimer: () => { cleared += 1; },
  });
  const result = handshake.requestFlush();
  events.emit('destroyed');
  assert.deepEqual(await result, { ok: false, code: 'EDITOR_FLUSH_UNAVAILABLE' });
  assert.equal(cleared, 1);
  assert.equal(ipcMain.listenerCount('editor:flush-result'), 0);
  ipcMain.emit('editor:flush-result', { sender: webContents, senderFrame: { url: 'http://trusted/' } }, {
    requestId: 'request-id', ok: true,
  });
});

test('flush handshake rejects exhausted request ID collisions without leaking the first waiter', async () => {
  const ipcMain = fakeIpcMain();
  const webContents = { send: () => {}, isDestroyed: () => false };
  const handshake = createEditorFlushHandshake({
    ipcMain,
    assertTrustedSender: () => {},
    getMainWindow: () => ({ webContents, isDestroyed: () => false }),
    createRequestId: () => 'duplicate-id',
    maxRequestIdAttempts: 2,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const first = handshake.requestFlush();
  assert.throws(() => handshake.requestFlush(), /flush request ID collision/i);
  assert.equal(handshake.pendingCount(), 1);
  ipcMain.emit('editor:flush-result', { sender: webContents, senderFrame: { url: 'http://trusted/' } }, {
    requestId: 'duplicate-id', ok: true,
  });
  assert.deepEqual(await first, { ok: true, code: 'OK' });
  assert.equal(handshake.pendingCount(), 0);
});

test('quit flushes, then stops sync, then quits exactly once', async () => {
  const events = [];
  const controller = createDesktopShutdownController({
    flushEditor: async () => { events.push('flush'); return { ok: true, code: 'OK' }; },
    stopSync: async () => { events.push('stop'); return true; },
    confirmContinue: async () => { events.push('confirm'); return true; },
    quit: () => events.push('quit'),
    relaunch: () => events.push('relaunch'),
    persistVault: () => events.push('persist'),
  });

  await Promise.all([controller.quit(), controller.quit()]);
  assert.deepEqual(events, ['flush', 'stop', 'quit']);
});

test('continuing after a sync stop timeout force-closes sync before quitting', async () => {
  const events = [];
  const controller = createDesktopShutdownController({
    flushEditor: async () => { events.push('flush'); return { ok: true, code: 'OK' }; },
    stopSync: async () => { events.push('stop'); return false; },
    forceStopSync: async () => { events.push('force-stop'); return true; },
    confirmContinue: async () => { events.push('confirm'); return true; },
    quit: () => events.push('quit'),
    relaunch: () => events.push('relaunch'),
    persistVault: () => events.push('persist'),
  });

  assert.equal(await controller.quit(), true);
  assert.deepEqual(events, ['flush', 'stop', 'confirm', 'force-stop', 'quit']);
});

test('sync stop cancel waits for resume and reports a failed resume without exiting', async () => {
  const events = [];
  const controller = createDesktopShutdownController({
    flushEditor: async () => { events.push('flush'); return { ok: true, code: 'OK' }; },
    stopSync: async () => { events.push('stop'); return false; },
    resumeSync: async () => { events.push('resume'); return false; },
    onResumeFailure: async () => { events.push('resume-failed'); },
    confirmContinue: async () => { events.push('confirm'); return false; },
    quit: () => events.push('quit'),
    relaunch: () => events.push('relaunch'),
    persistVault: () => events.push('persist'),
  });
  assert.equal(await controller.switchVault('/other'), false);
  assert.deepEqual(events, ['flush', 'stop', 'confirm', 'resume', 'resume-failed']);
});

test('sync stop cancel resumes cleanly, releases the single-flight lock, and permits a later close', async () => {
  const events = [];
  let stopAttempts = 0;
  const controller = createDesktopShutdownController({
    flushEditor: async () => { events.push('flush'); return { ok: true, code: 'OK' }; },
    stopSync: async () => {
      stopAttempts += 1;
      events.push('stop');
      return stopAttempts > 1;
    },
    resumeSync: async () => { events.push('resume'); return true; },
    confirmContinue: async () => { events.push('confirm'); return false; },
    quit: () => events.push('quit'),
    relaunch: () => events.push('relaunch'),
    persistVault: () => events.push('persist'),
  });

  assert.equal(await controller.switchVault('/other'), false);
  assert.equal(controller.isActive(), false);
  assert.deepEqual(events, ['flush', 'stop', 'confirm', 'resume']);
  assert.equal(await controller.quit(), true);
  assert.deepEqual(events, ['flush', 'stop', 'confirm', 'resume', 'flush', 'stop', 'quit']);
});

test('installed close guards coordinate close and before-quit without recursive shutdown', async () => {
  const app = new EventEmitter();
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  let allowQuit = false;
  const events = [];
  const preventable = () => ({
    prevented: false,
    preventDefault() { this.prevented = true; },
  });
  app.quit = () => {
    events.push('app.quit');
    const event = preventable();
    app.emit('before-quit', event);
    events.push(`before-quit-prevented:${event.prevented}`);
  };
  const controller = createDesktopShutdownController({
    flushEditor: async () => { events.push('flush'); return { ok: true, code: 'OK' }; },
    stopSync: async () => { events.push('stop'); return true; },
    confirmContinue: async () => true,
    persistVault: () => events.push('persist'),
    relaunch: () => events.push('relaunch'),
    quit: () => {
      allowQuit = true;
      events.push('quit');
      app.quit();
    },
  });
  const guards = installDesktopCloseGuards({
    app,
    getController: () => controller,
    getAllowQuit: () => allowQuit,
  });
  guards.bindWindow(win);

  const close = preventable();
  win.emit('close', close);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(close.prevented, true);
  assert.deepEqual(events, ['flush', 'stop', 'quit', 'app.quit', 'before-quit-prevented:false']);

  const laterClose = preventable();
  win.emit('close', laterClose);
  assert.equal(laterClose.prevented, false);
});

test('vault switch cancel after flush failure has no sync or relaunch side effects', async () => {
  const events = [];
  const controller = createDesktopShutdownController({
    flushEditor: async () => { events.push('flush'); return { ok: false, code: 'EDITOR_FLUSH_TIMEOUT' }; },
    stopSync: async () => { events.push('stop'); return true; },
    confirmContinue: async (detail) => {
      events.push(`confirm:${detail.code}`);
      return false;
    },
    quit: () => events.push('quit'),
    relaunch: () => events.push('relaunch'),
    persistVault: () => events.push('persist'),
  });

  assert.equal(await controller.switchVault('/other'), false);
  assert.deepEqual(events, ['flush', 'confirm:EDITOR_FLUSH_TIMEOUT']);
});
