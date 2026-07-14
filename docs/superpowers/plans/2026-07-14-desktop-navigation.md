# Desktop Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed floating sidebar control with a normal toolbar button and restore a persistent desktop settings button at the bottom of the sidebar.

**Architecture:** Keep the existing single-page HTML in `src/web/page.js`, but make controls participate in flex layout instead of viewport positioning. Add a small structural regression test against `PAGE_HTML` so future CSS changes cannot move the toggle back into a floating overlay or hide settings in a menu.

**Tech Stack:** Node.js test runner, embedded HTML/CSS/JavaScript, Electron preload IPC.

---

### Task 1: Lock the intended structure with a failing test

**Files:**
- Create: `test/page-layout.test.js`
- Read: `src/web/page.js`

- [ ] **Step 1: Write the failing structural test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_HTML } from '../src/web/page.js';

test('desktop navigation keeps the sidebar toggle in toolbar flow', () => {
  const navStart = PAGE_HTML.indexOf('<div class="nav-inner">');
  const navEnd = PAGE_HTML.indexOf('</nav>', navStart);
  const toggle = PAGE_HTML.indexOf('id="sideCollapse"');
  assert.ok(navStart >= 0 && navEnd > navStart);
  assert.ok(toggle > navStart && toggle < navEnd);
  assert.doesNotMatch(PAGE_HTML, /id="sideCtrl"|id="sideMenu"|id="sideMenuPop"/);
});

test('desktop settings has a persistent sidebar footer button', () => {
  const sidebarStart = PAGE_HTML.indexOf('<aside id="sidebar">');
  const sidebarEnd = PAGE_HTML.indexOf('</aside>', sidebarStart);
  const settings = PAGE_HTML.indexOf('id="sideSettings"');
  assert.ok(settings > sidebarStart && settings < sidebarEnd);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/page-layout.test.js
```

Expected: both tests fail because `sideCollapse` is still inside `#sideCtrl`, the dropdown still exists, and `sideSettings` does not exist.

### Task 2: Rebuild controls using normal layout

**Files:**
- Modify: `src/web/page.js`
- Test: `test/page-layout.test.js`

- [ ] **Step 1: Replace floating-control CSS**

Remove all `#sideCtrl`, `.ctrl-btn`, and `#sideMenuPop` positioning rules, including the collapsed-nav padding compensation. Add:

```css
.nav-collapse {
  width: 34px;
  height: 34px;
  border: 1px solid var(--faint);
  border-radius: 9px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  color: var(--muted);
  background: #fff;
  -webkit-app-region: no-drag;
}
.nav-collapse:hover { color: var(--fg); background: var(--hover); }
.nav-collapse svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
}
.cmdbar { max-width: 760px; }
.side-foot {
  margin: auto 12px 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.side-foot .mcp-mini { margin: 0; flex: 1; min-width: 0; }
.side-settings {
  width: 36px;
  height: 36px;
  border: 1px solid var(--faint);
  border-radius: 10px;
  display: none;
  place-items: center;
  flex: 0 0 auto;
}
.side-settings.desktop-visible { display: grid; }
```

- [ ] **Step 2: Move the toggle and settings button in HTML**

Delete the complete `#sideCtrl` block. Insert this as the first child of `.nav-inner`:

```html
<button class="nav-collapse" id="sideCollapse" title="显示 / 隐藏侧栏" aria-label="显示或隐藏侧栏">
  <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>
</button>
```

Replace the standalone MCP pill at the bottom of `#sidebar` with:

```html
<div class="side-foot">
  <div class="mcp-mini" id="mcpAddr" title="MCP 写入 · 已连接,点击复制地址">
    <span class="mcp-dot"></span>
    <span class="mcp-text">加载中…</span>
  </div>
  <button class="side-settings" id="sideSettings" title="设置" aria-label="打开设置">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
  </button>
</div>
```

- [ ] **Step 3: Simplify event wiring**

Keep the existing `sideCollapse` handler. Remove all `sideMenu`, `sideMenuPop`, `miSettings`, `miVault`, and dropdown-close handlers. In the desktop bridge branch add:

```js
const settingsButton = $('sideSettings');
if (settingsButton && window.wikiSettings) {
  settingsButton.classList.add('desktop-visible');
  settingsButton.onclick = openSettings;
}
```

Keep `setChooseVault` inside the settings modal as the only page-level Vault switch entry.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test test/page-layout.test.js
```

Expected: 2 tests pass.

- [ ] **Step 5: Run complete verification**

Run:

```bash
npm test
node --check desktop/main.js
git diff --check
```

Expected: all tests pass, syntax check exits 0, and `git diff --check` prints no output.

- [ ] **Step 6: Manually verify Electron**

Restart with:

```bash
npm run desktop
```

Verify:

1. Sidebar open: toggle is the first toolbar control; search and “新建” do not overlap it.
2. Sidebar closed: the same toggle remains in place and reopens the sidebar.
3. Sidebar bottom: settings gear is visible and opens the existing modal.
4. Browser mode: settings gear remains hidden.

### Task 3: Add the local MCP connection modal

**Files:**
- Modify: `src/web/page.js`
- Modify: `test/page-layout.test.js`

- [x] Add failing structural tests for the two footer rows, MCP modal, local URL, Cursor JSON, Claude Code command, and three copy actions.
- [x] Change `.side-foot` to a vertical stack and render full-width MCP/settings rows.
- [x] Add `#mcpOverlay` using the existing `.set-overlay`, `.set-modal`, `.set-head`, `.set-body`, and `.set-foot` styles.
- [x] Add compact code/copy rows for the address and configuration snippets.
- [x] Wire MCP open/close, backdrop/Escape close, and copy buttons.
- [x] Run focused tests, full tests, lint, syntax checks, and `git diff --check`.
