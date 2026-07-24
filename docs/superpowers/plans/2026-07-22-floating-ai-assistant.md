# Floating AI Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the editor-bound AI sidebar with a Craft-style global floating assistant that supports contextual document chat, safe selection editing, and multiple in-memory conversations.

**Architecture:** Generalize the existing bounded AI-edit service from selection-only input to explicit `selection`, `document`, and `general` modes while retaining the current SSE transport. Keep context inference and temporary thread state in pure frontend helpers, then render the assistant as a fixed overlay that never changes the article/editor layout.

**Tech Stack:** Node.js 18+, Express 4, browser Fetch/ReadableStream, existing server-rendered vanilla JavaScript page, CSS fixed positioning, `node:test`.

## Global Constraints

- Preserve all current object-storage sync changes and existing AI selection safety behavior.
- `LLM_API_KEY` remains backend-only and never appears in HTML, public errors, SSE events, or logs.
- Selection input is limited to 16,000 characters, document input to 32,000 characters, and total user/assistant messages to 48,000 characters.
- Conversation threads remain in page memory only; they are not saved to the Vault or synchronized.
- AI result application updates the textarea draft only and never saves automatically.
- Only completed selection-mode answers with a still-valid snapshot may replace or insert text.
- Do not create commits unless the user explicitly requests one; the branch contains uncommitted object-sync and AI work.

---

### Task 1: Contextual AI Service Modes

**Files:**
- Modify: `src/core/ai-edit.js`
- Modify: `src/web/server.js`
- Modify: `test/ai-edit.test.js`
- Modify: `test/ai-edit-api.test.js`

**Interfaces:**
- Extends: `streamAiEdit({ mode, messages, selection, noteContent }, options?)`
- Modes: `'selection' | 'document' | 'general'`
- Preserves: `GET /api/ai/edit/status`, `POST /api/ai/edit/chat`, existing SSE event format

- [ ] **Step 1: Write failing mode tests**

Add service and API tests proving:

```js
await collect(streamAiEdit({
  mode: 'document',
  messages: [{ role: 'user', content: '总结这篇笔记' }],
  selection: '',
  noteContent: '# 标题\n正文',
}, { stream: fakeStream }));

await collect(streamAiEdit({
  mode: 'general',
  messages: [{ role: 'user', content: '解释 Markdown 表格' }],
  selection: '',
  noteContent: '',
}, { stream: fakeStream }));
```

`selection` rejects blank selection, `document` rejects blank document, `general` omits all Vault content, unsupported modes fail before SSE headers, and all existing budgets remain enforced.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test test/ai-edit.test.js test/ai-edit-api.test.js`

Expected: FAIL because the current service always requires `selection`.

- [ ] **Step 3: Implement explicit mode validation and prompts**

Use mode-specific request sections:

```js
const CONTEXT_LABELS = {
  selection: '选区',
  document: '当前文档',
};
```

Keep the same history budgeting and stream options. In `general` mode, never include `selection` or `noteContent`, even if a malicious caller supplies them.

- [ ] **Step 4: Verify service and API**

Run: `node --test test/ai-edit.test.js test/ai-edit-api.test.js test/web-errors.test.js`

Expected: all contextual service/API tests PASS.

---

### Task 2: Context and Temporary Thread State

**Files:**
- Modify: `src/web/page.js`
- Modify: `test/page-layout.test.js`

**Interfaces:**
- Produces: `deriveAiContext({ view, editing, draftKey, path, selectionStart, selectionEnd, editorText, noteText })`
- Produces: `createAiThreadStore({ now?, createId? } = {})`
- Thread methods: `create(context)`, `get(id)`, `list()`, `update(id, updater)`, `remove(id)`, `setActive(id)`, `getActive()`

- [ ] **Step 1: Write failing pure-helper tests**

Cover all four contexts:

```js
assert.equal(deriveAiContext({
  view: 'article', editing: true, draftKey: 'notes/a.md',
  selectionStart: 2, selectionEnd: 5, editorText: '前文选区后文',
}).mode, 'selection');

assert.equal(deriveAiContext({
  view: 'index', editing: false, editorText: '', noteText: '',
}).mode, 'general');
```

Also test deterministic thread creation, active switching, recent-update sorting, deletion fallback, message isolation, and no browser storage usage.

- [ ] **Step 2: Run page tests and confirm failure**

Run: `node --test test/page-layout.test.js`

Expected: FAIL because contextual and multi-thread helpers do not exist.

- [ ] **Step 3: Implement pure state helpers**

Return frozen context snapshots. Thread store copies arrays/objects at its boundary so one thread cannot mutate another. Generate the title from the first non-empty user instruction, clipped to 28 characters, and use a localized fallback in rendering rather than storing translated text.

- [ ] **Step 4: Verify helpers**

Run: `node --test test/page-layout.test.js`

Expected: all context and thread tests PASS.

---

### Task 3: Craft-Style Floating Assistant UI

**Files:**
- Modify: `src/web/page.js`
- Modify: `src/i18n.js`
- Modify: `test/page-layout.test.js`
- Modify: `test/i18n.test.js`

**Interfaces:**
- Consumes: Task 1 modes and Task 2 context/thread helpers
- Replaces: editor toolbar `#aiToggle` and layout-bound `#aiPanel`
- Produces: fixed launcher, overlay panel, thread menu, contextual suggestions and compose controls

- [ ] **Step 1: Add failing structure, lifecycle, and localization tests**

Require stable IDs for:

```text
aiLauncher, aiPanel, aiThreadMenu, aiNewChat, aiClose,
aiSuggestions, aiMessages, aiContextCard, aiPrompt, aiSend, aiStop
```

Assert fixed bottom-right positioning, a 420px desktop card, narrow-screen overlay rules, dialog semantics, focus restoration, Escape close, localized thread/menu/context/suggestion labels, and removal of the editor-layout sidebar class.

- [ ] **Step 2: Run page and i18n tests and confirm failure**

Run: `node --test test/page-layout.test.js test/i18n.test.js`

Expected: FAIL because the existing assistant is editor-bound and single-session.

- [ ] **Step 3: Replace markup and CSS**

Render the launcher outside article/editor layout:

```html
<button id="aiLauncher" class="ai-launcher" aria-controls="aiPanel">...</button>
<section id="aiPanel" class="ai-float" role="dialog" aria-modal="false" hidden>...</section>
```

Use `position: fixed`, safe-area-aware offsets, `width: min(420px, calc(100vw - 32px))`, and a viewport-bounded height. Do not shrink `#editorSplit`.

- [ ] **Step 4: Integrate context-aware suggestions**

At send time call `deriveAiContext()` again. Selection mode shows editing actions and selection suggestions; document mode shows summary/key-point/table suggestions; general mode shows only a neutral prompt. Display a non-editable context card naming the current note or “No document context”.

- [ ] **Step 5: Integrate temporary multi-thread behavior**

“New chat” creates and activates a thread. Menu lists threads by `updatedAt`, supports switch/delete, and closes after selection. Switching threads or closing the panel aborts the current request and marks partial output stopped. Preserve the existing request-identity guard so an old `finally` cannot clear a newer request.

- [ ] **Step 6: Preserve safe result application**

Show replace/insert only for completed selection-mode messages whose snapshot still validates. Document/general replies only show copy. Mark any successfully applied answer as applied. Continue using `textContent`, the independent status live region, and the existing explicit-save editor path.

- [ ] **Step 7: Verify UI source and behavior helpers**

Run: `node --test test/page-layout.test.js test/i18n.test.js`

Expected: all floating assistant and localization tests PASS.

---

### Task 4: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Documents: global launcher, context modes, temporary threads, privacy, write-back limits

- [ ] **Step 1: Update bilingual documentation**

Replace the editor-sidebar description with the floating workflow. Explicitly state:

- reading sends the current note;
- editing selection permits guarded write-back;
- index/general chat sends no Vault content;
- threads disappear on refresh/exit and never synchronize;
- the configured provider receives the selected document context.

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --test test/llm-stream.test.js test/ai-edit.test.js test/ai-edit-api.test.js test/page-layout.test.js test/i18n.test.js test/web-errors.test.js
```

Expected: all focused tests PASS.

- [ ] **Step 3: Run complete tests**

Run: `npm test`

Expected: zero failures, cancellations, or unexpected skips.

- [ ] **Step 4: Run unsigned directory build and whitespace checks**

Run:

```bash
env -u CSC_NAME -u CSC_LINK -u CSC_KEY_PASSWORD \
  -u CSC_INSTALLER_LINK -u CSC_INSTALLER_KEY_PASSWORD \
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --dir --config.mac.identity=null
git diff --check
```

Expected: packaging exits `0`, signing is explicitly skipped, and `git diff --check` prints nothing.

- [ ] **Step 5: Inspect diagnostics**

Check `src/core/ai-edit.js`, `src/web/server.js`, `src/web/page.js`, and `src/i18n.js`; fix diagnostics introduced by this redesign.
