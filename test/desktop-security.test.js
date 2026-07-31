import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createTrustedSenderPolicy,
  installPreloadNavigationGuards,
} from '../desktop/ipc-security.js';
import { createSettingsIpcHandlers } from '../desktop/settings-ipc.js';

function fakeWebContents() {
  const events = new EventEmitter();
  let openHandler;
  return {
    on: events.on.bind(events),
    emit: events.emit.bind(events),
    setWindowOpenHandler(handler) {
      openHandler = handler;
    },
    open: () => openHandler?.({ url: 'https://evil.example' }),
  };
}

function navigationEvent(url) {
  let prevented = false;
  return {
    url,
    preventDefault: () => {
      prevented = true;
    },
    get prevented() {
      return prevented;
    },
  };
}

test('Electron 41 navigation details guard trusted targets and block navigation, redirects, and windows', () => {
  const webContents = fakeWebContents();
  installPreloadNavigationGuards(
    webContents,
    (targetUrl) => targetUrl.startsWith('http://127.0.0.1:4321/'),
  );

  for (const channel of ['will-navigate', 'will-redirect']) {
    const trusted = navigationEvent('http://127.0.0.1:4321/settings');
    webContents.emit(channel, trusted);
    assert.equal(trusted.prevented, false);

    const untrusted = navigationEvent('https://evil.example/phish');
    webContents.emit(channel, untrusted);
    assert.equal(untrusted.prevented, true);
  }
  assert.deepEqual(webContents.open(), { action: 'deny' });
});

test('navigation guards retain compatibility with the deprecated second URL argument', () => {
  const webContents = fakeWebContents();
  installPreloadNavigationGuards(
    webContents,
    (targetUrl) => targetUrl === 'file:///app/settings.html',
  );
  const trusted = navigationEvent();
  webContents.emit('will-navigate', trusted, 'file:///app/settings.html');
  assert.equal(trusted.prevented, false);
  const untrusted = navigationEvent();
  webContents.emit('will-redirect', untrusted, 'https://evil.example/');
  assert.equal(untrusted.prevented, true);
});

test('trusted sender policy accepts only the settings file and current app origin', () => {
  let appOrigin = 'http://127.0.0.1:4321';
  const policy = createTrustedSenderPolicy({
    settingsUrl: 'file:///app/settings.html',
    getAppOrigin: () => appOrigin,
  });
  for (const url of [
    'file:///app/settings.html',
    'http://127.0.0.1:4321/',
    'http://127.0.0.1:4321/note?id=1',
  ]) {
    assert.doesNotThrow(() => policy.assertTrustedSender({ senderFrame: { url } }));
  }
  for (const url of [
    'file:///app/settings.html?spoof=1',
    'https://evil.example/',
    'http://127.0.0.1:9999/',
    'not a url',
  ]) {
    assert.throws(
      () => policy.assertTrustedSender({ senderFrame: { url } }),
      /untrusted/i,
    );
  }
  appOrigin = '';
  assert.throws(
    () => policy.assertTrustedSender({
      senderFrame: { url: 'http://127.0.0.1:4321/' },
    }),
    /untrusted/i,
  );
});

test('all settings IPC handlers reject untrusted senders before side effects', async () => {
  const handlers = new Map();
  const sideEffects = [];
  createSettingsIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedSender: () => {
      throw new Error('untrusted IPC sender');
    },
    get: () => sideEffects.push('get'),
    info: () => sideEffects.push('info'),
    save: () => sideEffects.push('save'),
    close: () => sideEffects.push('close'),
    chooseVault: () => sideEffects.push('chooseVault'),
  });
  assert.deepEqual([...handlers.keys()].sort(), [
    'settings:chooseVault',
    'settings:close',
    'settings:get',
    'settings:info',
    'settings:save',
  ]);
  for (const handler of handlers.values()) {
    await assert.rejects(
      Promise.resolve().then(() => handler({ senderFrame: { url: 'https://evil.example' } }, {})),
      /untrusted/i,
    );
  }
  assert.deepEqual(sideEffects, []);
});

test('trusted settings IPC handlers preserve payload and results', async () => {
  const handlers = new Map();
  createSettingsIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedSender: () => {},
    get: () => ({ secret: 'main-process-only' }),
    info: () => ({ version: '1.0.0' }),
    save: (_event, payload) => ({ saved: payload.value }),
    close: () => ({ closed: true }),
    chooseVault: async () => ({ chosen: true }),
  });
  assert.deepEqual(await handlers.get('settings:get')({}), { secret: 'main-process-only' });
  assert.deepEqual(await handlers.get('settings:info')({}), { version: '1.0.0' });
  assert.deepEqual(await handlers.get('settings:save')({}, { value: 42 }), { saved: 42 });
  assert.deepEqual(await handlers.get('settings:close')({}), { closed: true });
  assert.deepEqual(await handlers.get('settings:chooseVault')({}), { chosen: true });
});
