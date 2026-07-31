const API_BASE = 'http://127.0.0.1:4321';
const SESSION_KEY = 'pendingClip';

async function applyWikinestIcon() {
  try {
    const response = await fetch(`${API_BASE}/assets/icon.png`);
    if (!response.ok) return;
    const bitmap = await createImageBitmap(await response.blob());
    const imageData = {};
    for (const size of [16, 32, 48, 128]) {
      const canvas = new OffscreenCanvas(size, size);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0, size, size);
      imageData[size] = context.getImageData(0, 0, size, size);
    }
    bitmap.close();
    await chrome.action.setIcon({ imageData });
  } catch {
    // The desktop app may not be running yet; retry on the next user action.
  }
}

function collectPage(mode, selectedText) {
  function meta(...selectors) {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.content?.trim();
      if (value) return value;
    }
    return '';
  }

  function absoluteUrl(value) {
    try { return new URL(value, location.href).href; } catch { return ''; }
  }

  const canonicalUrl = absoluteUrl(
    document.querySelector('link[rel="canonical"]')?.href || location.href,
  );
  const metadata = {
    sourceUrl: location.href,
    canonicalUrl,
    sourceTitle: meta('meta[property="og:title"]', 'meta[name="twitter:title"]')
      || document.title,
    description: meta(
      'meta[property="og:description"]',
      'meta[name="description"]',
      'meta[name="twitter:description"]',
    ),
    siteName: meta('meta[property="og:site_name"]') || location.hostname,
    author: meta('meta[name="author"]', 'meta[property="article:author"]'),
    publishedAt: meta(
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'meta[itemprop="datePublished"]',
    ),
    favicon: absoluteUrl(document.querySelector('link[rel~="icon"]')?.href || '/favicon.ico'),
  };

  if (mode === 'bookmark') return metadata;
  const selection = selectedText?.trim() || window.getSelection()?.toString().trim() || '';
  return {
    ...metadata,
    captureMode: 'selection',
    originalMarkdown: selection.slice(0, 500_000),
  };
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    });
  } catch {
    // Restricted pages (chrome://, the Web Store) cannot be scripted.
  }
}

/** Tabs opened before the extension loaded have no content script yet. */
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((tab) => (tab.id ? ensureContentScript(tab.id) : null)));
}

async function injectedPageData(tabId, mode, selectedText = '') {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectPage,
    args: [mode, selectedText],
  });
  return result;
}

/**
 * Prefer the always-present content script: it survives navigation and keeps the
 * live selection. Injection is only a fallback for tabs that were already open
 * before the extension loaded.
 */
async function pageData(tabId, mode, selectedText = '') {
  if (mode !== 'bookmark' && !selectedText) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const reply = await chrome.tabs.sendMessage(tabId, { type: 'request-capture' });
        if (reply?.capture) return reply.capture;
      } catch {
        await ensureContentScript(tabId);
      }
    }
  }
  return injectedPageData(tabId, mode, selectedText);
}

async function pullSelectionFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return;
  await ensureContentScript(tab.id);
  try {
    const capture = await pageData(tab.id, 'selection');
    await storeSelection(capture);
  } catch (error) {
    console.error('Wikinest selection pull failed', error);
  }
}

async function request(path, init) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Wikinest returned ${response.status}`);
  return body;
}

async function showBadge(tabId, text, color) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 1800);
}

async function saveCurrentBookmark(tab) {
  try {
    const data = await pageData(tab.id, 'bookmark');
    const result = await request('/api/bookmarks', {
      method: 'POST',
      body: JSON.stringify({
        url: data.sourceUrl,
        canonicalUrl: data.canonicalUrl,
        title: data.sourceTitle,
        description: data.description,
        siteName: data.siteName,
        favicon: data.favicon,
      }),
    });
    await showBadge(tab.id, result.duplicate ? 'IN' : 'OK', '#2e7d32');
  } catch (error) {
    console.error('Wikinest bookmark failed', error);
    await showBadge(tab.id, 'ERR', '#b3261e');
  }
}

async function openClip(tab, mode, selectedText = '') {
  try {
    void applyWikinestIcon();
    // Start extraction before opening the panel so changing focus cannot clear
    // the page selection. Both calls still happen inside the user gesture.
    const capturePromise = pageData(tab.id, mode, selectedText);
    const [, capture] = await Promise.all([
      chrome.sidePanel.open({ tabId: tab.id }),
      capturePromise,
    ]);
    await chrome.storage.session.set({ [SESSION_KEY]: capture });
    await chrome.runtime.sendMessage({ type: 'clip-ready' }).catch(() => {});
  } catch (error) {
    console.error('Wikinest clip failed', error);
    await showBadge(tab.id, 'ERR', '#b3261e');
  }
}

async function storeSelection(capture) {
  if (!capture?.originalMarkdown?.trim()) return;
  await chrome.storage.session.set({ [SESSION_KEY]: capture });
  await chrome.runtime.sendMessage({ type: 'clip-ready' }).catch(() => {});
}

chrome.runtime.onStartup.addListener(() => {
  void injectIntoOpenTabs();
});

chrome.runtime.onInstalled.addListener(() => {
  void applyWikinestIcon();
  void injectIntoOpenTabs();
  chrome.contextMenus.create({
    id: 'wikinest-bookmark',
    title: '收藏当前网址到 Wikinest',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'wikinest-clip-selection',
    title: '在 Wikinest 中处理选中内容',
    contexts: ['selection'],
  });
});

chrome.action.onClicked.addListener((tab) => openClip(tab, 'selection'));

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'selection-changed' && sender.tab?.id) {
    void storeSelection(message.capture);
  }
  if (message?.type === 'pull-selection') void pullSelectionFromActiveTab();
});

chrome.tabs.onActivated.addListener(() => {
  void pullSelectionFromActiveTab();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'wikinest-bookmark') await saveCurrentBookmark(tab);
  if (info.menuItemId === 'wikinest-clip-selection') {
    await openClip(tab, 'selection', info.selectionText || '');
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'save-bookmark') await saveCurrentBookmark(tab);
  if (command === 'clip-selection') await openClip(tab, 'selection');
});
