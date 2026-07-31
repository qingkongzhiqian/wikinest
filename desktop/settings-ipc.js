const SETTINGS_HANDLERS = Object.freeze({
  'settings:get': 'get',
  'settings:info': 'info',
  'settings:save': 'save',
  'settings:close': 'close',
  'settings:chooseVault': 'chooseVault',
});

export function createSettingsIpcHandlers({
  ipcMain,
  assertTrustedSender,
  get,
  info,
  save,
  close,
  chooseVault,
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('ipcMain is required');
  }
  if (typeof assertTrustedSender !== 'function') {
    throw new TypeError('assertTrustedSender is required');
  }
  const implementations = { get, info, save, close, chooseVault };
  for (const [channel, name] of Object.entries(SETTINGS_HANDLERS)) {
    const implementation = implementations[name];
    if (typeof implementation !== 'function') {
      throw new TypeError(`${name} settings handler is required`);
    }
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event);
      return implementation(event, ...args);
    });
  }
}
