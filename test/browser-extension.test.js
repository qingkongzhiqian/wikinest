import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../browser-extension/', import.meta.url);

test('browser extension manifest defines the side panel and local API permission', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Wikinest 网页助手');
  assert.equal(manifest.background.service_worker, 'service-worker.js');
  assert.equal(manifest.side_panel.default_path, 'side-panel.html');
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.ok(manifest.permissions.includes('contextMenus'));
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1:4321/*'));
  const [contentScript] = manifest.content_scripts;
  assert.deepEqual(contentScript.js, ['content-script.js']);
  assert.deepEqual(contentScript.matches, ['http://*/*', 'https://*/*']);
});

test('the selection watcher lives in a persistent content script', async () => {
  const script = await readFile(new URL('content-script.js', root), 'utf8');
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /document\.addEventListener\('selectionchange'/);
  assert.match(script, /document\.addEventListener\('mouseup'/);
  assert.match(script, /type: 'selection-changed'/);
  assert.match(script, /message\?\.type !== 'request-capture'/);
  // An empty selection must never wipe an already captured quote.
  assert.match(script, /if \(!selection\) return;/);
  // Double injection must not register the listeners twice.
  assert.match(script, /globalThis\.__wikinestSelectionBridge/);
});

test('tabs opened before loading the extension still report selections', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const worker = await readFile(new URL('service-worker.js', root), 'utf8');
  const panel = await readFile(new URL('side-panel.js', root), 'utf8');
  for (const pattern of ['http://*/*', 'https://*/*']) {
    assert.ok(manifest.host_permissions.includes(pattern));
  }
  assert.match(worker, /files: \['content-script\.js'\]/);
  assert.match(worker, /chrome\.runtime\.onStartup\.addListener/);
  assert.match(worker, /void injectIntoOpenTabs\(\)/);
  assert.match(worker, /message\?\.type === 'pull-selection'/);
  assert.match(worker, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(panel, /chrome\.runtime\.sendMessage\(\{ type: 'pull-selection' \}\)/);
});

test('extension scripts parse and keep saving behind explicit confirmation', async () => {
  const worker = await readFile(new URL('service-worker.js', root), 'utf8');
  const panel = await readFile(new URL('side-panel.js', root), 'utf8');
  const panelHtml = await readFile(new URL('side-panel.html', root), 'utf8');
  assert.doesNotThrow(() => new Function(worker));
  assert.doesNotThrow(() => new Function(panel));
  assert.match(worker, /\/api\/bookmarks/);
  assert.match(worker, /chrome\.sidePanel\.open/);
  assert.match(worker, /fetch\(`\$\{API_BASE\}\/assets\/icon\.png`\)/);
  assert.match(worker, /chrome\.action\.setIcon/);
  assert.match(worker, /const capturePromise = pageData\(tab\.id, mode, selectedText\)/);
  assert.match(worker, /info\.selectionText \|\| ''/);
  assert.match(worker, /chrome\.tabs\.sendMessage\(tabId, \{ type: 'request-capture' \}\)/);
  assert.match(worker, /message\?\.type === 'selection-changed'/);
  assert.match(worker, /void storeSelection\(message\.capture\)/);
  assert.match(worker, /chrome\.action\.onClicked\.addListener\(\(tab\) => openClip\(tab, 'selection'\)\)/);
  assert.doesNotMatch(worker, /wikinest-clip-article/);
  assert.doesNotMatch(worker, /markdownFromElement/);
  assert.doesNotMatch(worker, /if \(!capture\.originalMarkdown\)/);
  assert.doesNotMatch(worker, /\/api\/clips['"`]/);
  assert.match(panelHtml, /id="originalPreview"/);
  assert.doesNotMatch(panelHtml, /class="brand"/);
  assert.match(panelHtml, /id="userPrompt"/);
  assert.match(panelHtml, /id="modelSettings"/);
  assert.match(panelHtml, /id="modelApiKey" type="password"/);
  assert.match(panelHtml, /id="newChat"/);
  assert.match(panelHtml, /id="historyToggle"/);
  assert.match(panelHtml, /id="historyList"/);
  assert.match(panelHtml, /id="messageList"/);
  assert.match(panelHtml, /<footer id="footer">/);
  assert.match(panelHtml, /id="original"/);
  assert.match(panel, /\$\('charCount'\)\.textContent/);
  assert.match(panel, /api\('\/api\/clips\/ask'/);
  assert.match(panel, /chrome\.storage\.local\.set/);
  assert.match(panel, /const CHAT_KEY = 'chatHistory'/);
  assert.match(panel, /chrome\.storage\.session\.set\(\{ \[CHAT_KEY\]/);
  assert.match(panel, /chrome\.storage\.session\.get\(CHAT_KEY\)/);
  assert.match(panel, /\$\('newChat'\)\.addEventListener\('click', startNewChat\)/);
  assert.match(panel, /message\.contextQuote = capture\.originalMarkdown/);
  assert.match(panel, /await appendMessage\('user', question, true\)/);
  assert.match(panel, /await appendMessage\('assistant', result\.output \|\| ''\)/);
  assert.match(panel, /chrome\.storage\.session\.onChanged\.addListener/);
  assert.match(panel, /\$\('saveBookmark'\)\.disabled = busy \|\| !capture/);
  assert.match(panel, /async function saveBookmark\(\) \{\s+if \(!capture \|\| busy\) return/);
  assert.match(panel, /\$\('saveBookmark'\)\.addEventListener\('click', saveBookmark\)/);
  assert.match(panel, /\$\('save'\)\.addEventListener\('click', saveClip\)/);
  assert.match(panel, /api\('\/api\/clips'/);
});
