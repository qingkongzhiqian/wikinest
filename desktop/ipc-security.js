export function createTrustedSenderPolicy({
  settingsUrl,
  getAppOrigin,
} = {}) {
  if (typeof settingsUrl !== 'string' || !settingsUrl) {
    throw new Error('settingsUrl is required');
  }
  if (typeof getAppOrigin !== 'function') {
    throw new TypeError('getAppOrigin must be a function');
  }

  function isTrustedUrl(value) {
    if (value === settingsUrl) return true;
    const appOrigin = getAppOrigin();
    if (!appOrigin) return false;
    try {
      return new URL(value).origin === appOrigin;
    } catch {
      return false;
    }
  }

  function assertTrustedSender(event) {
    if (!isTrustedUrl(event?.senderFrame?.url)) {
      throw new Error('untrusted IPC sender');
    }
  }

  return { isTrustedUrl, assertTrustedSender };
}

export function installPreloadNavigationGuards(webContents, isAllowed) {
  if (!webContents || typeof webContents.on !== 'function') {
    throw new TypeError('webContents is required');
  }
  if (typeof isAllowed !== 'function') {
    throw new TypeError('isAllowed must be a function');
  }
  const guard = (event, legacyTargetUrl) => {
    const targetUrl = event?.url ?? legacyTargetUrl;
    if (!isAllowed(targetUrl)) event.preventDefault();
  };
  webContents.on('will-navigate', guard);
  webContents.on('will-redirect', guard);
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
