// Preload for both the standalone settings window and the main app window.
// CommonJS so it loads under the default sandbox; exposes a tiny, audited IPC
// surface. In the main window the in-page settings modal (see src/web/page.js)
// uses this same bridge, so no separate window is needed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wikiSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  info: () => ipcRenderer.invoke('settings:info'),
  save: (data) => ipcRenderer.invoke('settings:save', data),
  close: () => ipcRenderer.invoke('settings:close'),
  chooseVault: () => ipcRenderer.invoke('settings:chooseVault'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  syncGet: () => ipcRenderer.invoke('sync:get'),
  syncSave: (data) => ipcRenderer.invoke('sync:save', data),
  syncTest: (data) => ipcRenderer.invoke('sync:test', data),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  onSyncStatus: (cb) => {
    if (typeof cb !== 'function') return;
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('sync-status', listener);
    return () => ipcRenderer.removeListener('sync-status', listener);
  },
  onEditorFlushRequest: (cb) => {
    if (typeof cb !== 'function') return;
    const listener = (_event, payload) => {
      if (payload && typeof payload.requestId === 'string') cb({ requestId: payload.requestId });
    };
    ipcRenderer.on('editor:flush-request', listener);
    return () => ipcRenderer.removeListener('editor:flush-request', listener);
  },
  replyEditorFlush: (result) => {
    if (!result || typeof result !== 'object') return;
    const { requestId, ok, code } = result;
    if (typeof requestId !== 'string' || typeof ok !== 'boolean') return;
    if (ok && code === undefined) {
      ipcRenderer.send('editor:flush-result', { requestId, ok: true });
    } else if (!ok && typeof code === 'string') {
      ipcRenderer.send('editor:flush-result', { requestId, ok: false, code });
    }
  },
  // Let the app menu (Cmd/Ctrl+,) / first-run open the in-page settings modal.
  onOpenSettings: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('open-settings', () => cb());
  },
  // Fired after settings are hot-applied so the page can refresh its UI state.
  onSettingsUpdated: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('settings-updated', (_event, payload) => cb(payload));
  },
});
