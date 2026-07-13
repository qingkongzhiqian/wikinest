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
  // Let the app menu (Cmd/Ctrl+,) / first-run open the in-page settings modal.
  onOpenSettings: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('open-settings', () => cb());
  },
  // Fired after settings are hot-applied so the page can refresh its UI state.
  onSettingsUpdated: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('settings-updated', () => cb());
  },
});
