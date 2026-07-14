import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_HTML, renderPage } from '../src/web/page.js';

const EN_HTML = renderPage('en');
const ZH_HTML = renderPage('zh-CN');

test('page renders navigation in the selected locale', () => {
  assert.match(EN_HTML, /<html lang="en">/);
  assert.match(ZH_HTML, /<html lang="zh-CN">/);
  assert.match(EN_HTML, />All notes</);
  assert.match(EN_HTML, />Ask Wikinest</);
  assert.match(EN_HTML, />Settings</);
  assert.match(ZH_HTML, />全部笔记</);
  assert.match(ZH_HTML, />问一问</);
  assert.match(ZH_HTML, />设置</);
});

test('filters use stable identifiers instead of translated labels', () => {
  for (const html of [EN_HTML, ZH_HTML]) {
    assert.match(html, /const TAB_ALL = '__all__'/);
    assert.match(html, /const TAB_UNCATEGORIZED = '__uncategorized__'/);
    assert.doesNotMatch(html, /activeTab = '全部'/);
  }
});

test('client formatting and feedback use the selected locale dictionary', () => {
  assert.match(EN_HTML, /new Intl\.DateTimeFormat\(UI_LOCALE/);
  assert.match(EN_HTML, /tr\('toast\.settingsSaved'\)/);
  assert.match(ZH_HTML, /"toast\.settingsSaved":"设置已保存并生效"/);
});

test('desktop settings exposes English and Simplified Chinese choices', () => {
  for (const html of [EN_HTML, ZH_HTML]) {
    assert.match(html, /id="UI_LOCALE"/);
    assert.match(html, /<option value="en">English<\/option>/);
    assert.match(html, /<option value="zh-CN">简体中文<\/option>/);
    assert.match(html, /out\.locale = \$\('UI_LOCALE'\)\.value/);
    assert.match(html, /onSettingsUpdated\(\(payload\) =>/);
    assert.match(html, /if \(!\$\('setOverlay'\)\.classList\.contains\('show'\)\) location\.reload\(\)/);
  }
});

test('desktop titlebar places only the sidebar toggle after traffic lights', () => {
  const titlebarId = PAGE_HTML.indexOf('id="desktopTitlebar"');
  const titlebarStart = PAGE_HTML.lastIndexOf('<div', titlebarId);
  const titlebarEnd = PAGE_HTML.indexOf('</div>', titlebarStart);
  const desktopToggle = PAGE_HTML.indexOf('id="sideCollapse"');
  const navStart = PAGE_HTML.indexOf('<div class="nav-inner">');
  const navEnd = PAGE_HTML.indexOf('</nav>', navStart);
  const webToggle = PAGE_HTML.indexOf('id="webSideCollapse"');

  assert.ok(titlebarId >= 0 && titlebarStart >= 0 && titlebarEnd > titlebarStart);
  assert.ok(desktopToggle > titlebarStart && desktopToggle < titlebarEnd);
  assert.ok(navStart >= 0 && navEnd > navStart);
  assert.ok(webToggle > navStart && webToggle < navEnd);
  assert.doesNotMatch(PAGE_HTML, /id="(?:navBack|navForward|sideCtrl|sideMenu|sideMenuPop)"/);
});

test('desktop settings has a persistent sidebar footer button', () => {
  const sidebarStart = PAGE_HTML.indexOf('<aside id="sidebar">');
  const sidebarEnd = PAGE_HTML.indexOf('</aside>', sidebarStart);
  const settings = PAGE_HTML.indexOf('id="sideSettings"');

  assert.ok(settings > sidebarStart && settings < sidebarEnd);
});

test('toolbar keeps its primary action aligned to the right', () => {
  assert.match(PAGE_HTML, /\.nav-right\s*\{[^}]*margin-left:\s*auto/);
});

test('search bar expands into the available toolbar space', () => {
  const rule = PAGE_HTML.match(/\.cmdbar\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /flex:\s*1/);
  assert.doesNotMatch(rule, /max-width/);
});

test('app hides scrollbars without disabling vertical scrolling', () => {
  assert.match(PAGE_HTML, /html,\s*body\s*\{[^}]*overflow-x:\s*hidden/);
  assert.match(PAGE_HTML, /scrollbar-width:\s*none/);
  assert.match(PAGE_HTML, /::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
});

test('sidebar brand uses the packaged Wikinest logo', () => {
  assert.match(PAGE_HTML, /<img class="brand-logo" src="\/assets\/icon\.png" alt="" \/>/);
});

test('sidebar exposes MCP and settings as two labeled footer rows', () => {
  assert.match(PAGE_HTML, /<span class="mcp-text">MCP 运行中<\/span>/);
  assert.match(PAGE_HTML, /id="sideSettings"[^>]*>[\s\S]*?<span>设置<\/span>/);
  assert.match(PAGE_HTML, /\.side-foot\s*\{[^}]*flex-direction:\s*column/);
});

test('MCP modal provides local connection instructions and copy actions', () => {
  assert.match(PAGE_HTML, /id="mcpOverlay"/);
  assert.match(PAGE_HTML, /id="mcpCopyAddress"/);
  assert.match(PAGE_HTML, /id="mcpCopyCursor"/);
  assert.match(PAGE_HTML, /id="mcpCopyClaude"/);
  assert.match(PAGE_HTML, /http:\/\/127\.0\.0\.1:4321\/mcp/);
  assert.match(PAGE_HTML, /claude mcp add --scope user --transport http wikinest-local/);
  assert.match(PAGE_HTML, /const localMcpUrl = location\.origin \+ '\/mcp'/);
  assert.match(PAGE_HTML, /html\.desktop \.mcp-mini\s*\{\s*display:\s*flex/);
  assert.match(PAGE_HTML, /addr\.onclick = openMcpModal/);
  assert.match(PAGE_HTML, /\$\('mcpClose'\)\.onclick = closeMcpModal/);
  assert.match(PAGE_HTML, /if \(e\.target === overlay\) closeMcpModal\(\)/);
  assert.match(PAGE_HTML, /e\.key === 'Escape'[\s\S]*?closeMcpModal\(\)/);
});
