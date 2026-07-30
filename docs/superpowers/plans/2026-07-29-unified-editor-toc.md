# Unified Editor TOC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在统一 Markdown 编辑器左侧恢复可点击、随 H2/H3 实时更新的目录。

**Architecture:** 在 `page.js` 中增加可独立测试的标题提取函数，并为统一编辑器建立独立的目录布局。浏览器控制器扫描 Milkdown 的标题 DOM，以 `MutationObserver` + `requestAnimationFrame` 合并更新，离开编辑器时统一清理。

**Tech Stack:** JavaScript、DOM、MutationObserver、CSS Grid、Node test runner。

## Global Constraints

- 目录仅包含非空的 H2、H3，并保持文档顺序。
- 少于两个标题时隐藏目录并恢复单栏。
- 视口不超过 1024px 时隐藏目录。
- 不改变只读正文目录行为。
- 不增加第三方依赖。

---

### Task 1: 可测试的目录模型

**Files:**
- Modify: `src/web/page.js`
- Test: `test/page-layout.test.js`

**Interfaces:**
- Consumes: `Array<{ tagName?: string, textContent?: string }>`
- Produces: `editorTocEntries(headings): Array<{ index: number, text: string, sub: boolean }>`

- [ ] **Step 1: Write the failing test**

在 `test/page-layout.test.js` 导入 `editorTocEntries`，添加：

```js
test('editor TOC keeps non-empty H2/H3 headings in document order', () => {
  assert.deepEqual(pageModule.editorTocEntries([
    { tagName: 'H1', textContent: '标题' },
    { tagName: 'H2', textContent: ' 第一节 ' },
    { tagName: 'H3', textContent: '细节' },
    { tagName: 'H2', textContent: '  ' },
  ]), [
    { index: 1, text: '第一节', sub: false },
    { index: 2, text: '细节', sub: true },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/page-layout.test.js`

Expected: FAIL，因为 `editorTocEntries` 尚未导出。

- [ ] **Step 3: Write minimal implementation**

在 `src/web/page.js` 的纯函数区域添加：

```js
export function editorTocEntries(headings) {
  return Array.from(headings || []).flatMap((heading, index) => {
    const tag = (heading?.tagName || '').toUpperCase();
    const text = (heading?.textContent || '').trim();
    if ((tag !== 'H2' && tag !== 'H3') || !text) return [];
    return [{ index, text, sub: tag === 'H3' }];
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/page-layout.test.js`

Expected: PASS。

### Task 2: 统一编辑器目录布局和生命周期

**Files:**
- Modify: `src/web/page.js`
- Test: `test/page-layout.test.js`

**Interfaces:**
- Consumes: `editorTocEntries(headings)`
- Produces: `buildUnifiedEditorToc()` 和 `clearUnifiedEditorToc()` 页面生命周期函数。

- [ ] **Step 1: Write failing layout and lifecycle assertions**

在 `test/page-layout.test.js` 添加源码级回归断言：

```js
test('unified editor owns a live TOC layout and cleans its observer', () => {
  assert.match(PAGE_HTML, /id="unifiedEditorBody"/);
  assert.match(PAGE_HTML, /id="editorToc"/);
  assert.match(PAGE_HTML, /new MutationObserver/);
  assert.match(PAGE_HTML, /clearUnifiedEditorToc\(\)/);
  assert.match(PAGE_HTML, /requestAnimationFrame/);
});
```

同时扩展 `applyUnifiedArticleChrome` 测试元素，断言 `unifiedEditorBody.style.display === ''`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/page-layout.test.js`

Expected: FAIL，缺少统一目录 DOM 和观察器。

- [ ] **Step 3: Add the editor layout**

把统一编辑器 HTML 改为：

```html
<div class="unified-editor-body no-toc" id="unifiedEditorBody" style="display:none">
  <nav class="toc empty" id="editorToc"></nav>
  <div id="unifiedEditor" hidden></div>
</div>
```

增加与只读正文一致的宽屏网格和窄屏规则：

```css
.unified-editor-body {
  display: grid;
  grid-template-columns: 220px minmax(0, 760px);
  gap: 56px;
  justify-content: center;
  align-items: start;
  margin-top: 48px;
}
.unified-editor-body.no-toc { grid-template-columns: minmax(0, 760px); }
@media (max-width: 1024px) {
  .unified-editor-body, .unified-editor-body.no-toc {
    grid-template-columns: minmax(0, 760px);
  }
  #editorToc { display: none; }
}
```

- [ ] **Step 4: Implement live rebuilding and cleanup**

在页面脚本中维护 `editorTocObserver` 和待执行帧。`buildUnifiedEditorToc()` 查询 `#unifiedEditor h2, #unifiedEditor h3`，调用 `editorTocEntries`，重建链接；链接点击时对对应标题调用 `scrollIntoView({ behavior: 'smooth' })`。标题不足两个时为目录添加 `empty`，为布局添加 `no-toc`。

安装观察器时使用：

```js
editorTocObserver = new MutationObserver(scheduleUnifiedEditorToc);
editorTocObserver.observe($('unifiedEditor'), {
  subtree: true,
  childList: true,
  characterData: true,
});
```

`scheduleUnifiedEditorToc()` 只安排一个 `requestAnimationFrame`。`clearUnifiedEditorToc()` 断开观察器、取消帧、清空目录，并由 `showIndex`、`showAskView`、`showSourceFallback` 调用。

- [ ] **Step 5: Wire editor opening**

`applyUnifiedArticleChrome` 显示 `unifiedEditorBody`。`applyOpenedNote` 在编辑器载入后调用目录安装函数；`showView` 和源码后备模式隐藏统一编辑器布局。

- [ ] **Step 6: Run focused tests**

Run: `node --test test/page-layout.test.js`

Expected: PASS。

- [ ] **Step 7: Run full verification**

Run:

```bash
npm run editor:test
npm run editor:build
node --test test/page-layout.test.js test/editor-bundle.test.js
```

Expected: 所有命令退出码为 0，无新增 lint 错误。
