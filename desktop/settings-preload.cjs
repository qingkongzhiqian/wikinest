// Preload for the settings window. CommonJS so it loads under the default
// sandbox; exposes a tiny, audited IPC surface to the settings page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wikiSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  info: () => ipcRenderer.invoke('settings:info'),
  save: (data) => ipcRenderer.invoke('settings:save', data),
  close: () => ipcRenderer.invoke('settings:close'),
  chooseVault: () => ipcRenderer.invoke('settings:chooseVault'),
});
