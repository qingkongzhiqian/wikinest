// Guarded so the declarative injection and the programmatic injection used for
// already-open tabs cannot register the selection listeners twice.
if (!globalThis.__wikinestSelectionBridge) {
  globalThis.__wikinestSelectionBridge = true;

  const MAX_SELECTION_CHARS = 500_000;

  const meta = (...selectors) => {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.content?.trim();
      if (value) return value;
    }
    return '';
  };

  const absoluteUrl = (value) => {
    try { return new URL(value, location.href).href; } catch { return ''; }
  };

  const pageMetadata = () => ({
    sourceUrl: location.href,
    canonicalUrl: absoluteUrl(
      document.querySelector('link[rel="canonical"]')?.href || location.href,
    ),
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
  });

  const currentSelection = () => window.getSelection()?.toString().trim() || '';

  const capturePayload = (selection) => ({
    ...pageMetadata(),
    captureMode: 'selection',
    originalMarkdown: selection.slice(0, MAX_SELECTION_CHARS),
  });

  let publishTimer;

  const publishSelection = (delay) => {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      const selection = currentSelection();
      // An empty selection is usually just a click, or focus moving into the
      // panel, so the previously captured quote is kept instead of cleared.
      if (!selection) return;
      chrome.runtime.sendMessage({
        type: 'selection-changed',
        capture: capturePayload(selection),
      }).catch(() => {});
    }, delay);
  };

  document.addEventListener('selectionchange', () => publishSelection(140));
  document.addEventListener('mouseup', () => publishSelection(60));
  document.addEventListener('keyup', (event) => {
    if (event.shiftKey || event.key === 'a') publishSelection(140);
  });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== 'request-capture') return undefined;
    respond({ capture: capturePayload(currentSelection()) });
    return undefined;
  });

  publishSelection(0);
}
