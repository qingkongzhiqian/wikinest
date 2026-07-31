# AI Selection Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a streaming, per-note AI chat sidebar that works from a Markdown selection and safely applies model output to the editor draft.

**Architecture:** Extend the shared OpenAI-compatible client with an async text stream, wrap it in a bounded AI-edit service, and expose that service through an SSE Express route. Keep ephemeral conversation state and selection snapshots in the renderer; isolate text-application rules in exported pure helpers so stale selections cannot overwrite edits.

**Tech Stack:** Node.js 18+, Express 4, browser Fetch/ReadableStream, existing single-file HTML renderer, `node:test`, existing OpenAI-compatible `LLM_*` configuration.

## Global Constraints

- `LLM_API_KEY` remains backend-only and must never appear in page HTML, API errors, events, or logs.
- Selection input is limited to 16,000 characters, optional note content to 32,000 characters, and total recent conversation input to 48,000 characters.
- AI output changes the textarea draft only and never saves a note automatically.
- Conversation history is per-note and process-memory-only; it is not persisted or synchronized.
- Existing non-streaming `chat()` callers retain their behavior.
- Do not create commits unless the user explicitly requests one; the branch already contains unrelated uncommitted object-sync work.

---

### Task 1: Streaming OpenAI-Compatible Client

**Files:**
- Modify: `src/core/llm.js`
- Create: `test/llm-stream.test.js`

**Interfaces:**
- Produces: `chatStream(messages, options?) -> AsyncGenerator<string>`
- Preserves: `chat(messages, options?) -> Promise<string>`

- [ ] **Step 1: Write failing stream parser tests**

Cover split SSE frames, multiple `data:` events in one chunk, `[DONE]`, provider error responses, aborts, and malformed/non-content events. Stub `globalThis.fetch` with a `ReadableStream`:

```js
test('chatStream yields text deltas across split SSE chunks', async () => {
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你')) ;
      controller.enqueue(new TextEncoder().encode('好"}}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  assert.deepEqual(await Array.fromAsync(chatStream([{ role: 'user', content: 'x' }])), ['你好']);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test test/llm-stream.test.js`

Expected: FAIL because `chatStream` is not exported.

- [ ] **Step 3: Implement the async generator**

Add `stream: true` to the request, preserve the existing timeout/error wording, parse frames using a buffered `TextDecoder`, yield only string `choices[0].delta.content`, cancel the body reader in `finally`, and combine an optional caller signal with the timeout abort.

```js
export async function* chatStream(messages, {
  temperature = 0.3,
  timeoutMs,
  signal,
} = {}) {
  // Validate configuration, start POST /chat/completions with stream: true,
  // parse complete SSE frames from a rolling buffer, and yield text deltas.
}
```

- [ ] **Step 4: Verify the client**

Run: `node --test test/llm-stream.test.js`

Expected: all stream client tests PASS.

---

### Task 2: Bounded AI-Edit Service

**Files:**
- Create: `src/core/ai-edit.js`
- Create: `test/ai-edit.test.js`

**Interfaces:**
- Consumes: `chatStream(messages, options)`
- Produces: `isAiEditConfigured() -> boolean`
- Produces: `streamAiEdit({ messages, selection, noteContent, includeNote }, options?) -> AsyncGenerator<string>`

- [ ] **Step 1: Write failing service tests**

Inject a fake stream function and assert that:

- an empty selection is rejected;
- selection and note limits are deterministic;
- the full note is absent unless `includeNote === true`;
- only valid user/assistant history is retained;
- recent history is kept within 48,000 characters;
- the system prompt demands Markdown-only output and preserves source facts unless instructed otherwise.

```js
const chunks = [];
for await (const chunk of streamAiEdit({
  messages: [{ role: 'user', content: '改成表格' }],
  selection: '苹果 3 个，梨 2 个',
  noteContent: '# 库存',
  includeNote: true,
}, { stream: fakeStream })) chunks.push(chunk);
assert.deepEqual(chunks, ['| 水果 | 数量 |']);
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test test/ai-edit.test.js`

Expected: FAIL because `src/core/ai-edit.js` does not exist.

- [ ] **Step 3: Implement validation, clipping, and prompt construction**

Use constants `MAX_SELECTION_CHARS = 16_000`, `MAX_NOTE_CHARS = 32_000`, and `MAX_HISTORY_CHARS = 48_000`. Reject non-array messages, unsupported roles, empty final user instruction, empty selection, and non-string fields with stable user-safe errors.

- [ ] **Step 4: Verify the service**

Run: `node --test test/ai-edit.test.js`

Expected: all AI-edit service tests PASS.

---

### Task 3: SSE Web API

**Files:**
- Modify: `src/web/server.js`
- Create: `test/ai-edit-api.test.js`
- Modify: `test/web-errors.test.js`

**Interfaces:**
- Consumes: `isAiEditConfigured`, `streamAiEdit`
- Produces: `GET /api/ai/edit/status`
- Produces: `POST /api/ai/edit/chat` with `event: delta`, `event: done`, and `event: error`

- [ ] **Step 1: Write failing API tests**

Start the real server on an ephemeral port and assert:

- status reports disabled with missing `LLM_*`;
- invalid bodies return JSON `400` before SSE headers are committed;
- a configured fake upstream produces escaped JSON delta events and one done event;
- client disconnect aborts upstream work;
- errors do not contain the configured API key.

Expected wire format:

```text
event: delta
data: {"text":"重写结果"}

event: done
data: {}

```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `node --test test/ai-edit-api.test.js test/web-errors.test.js`

Expected: FAIL because the routes are absent.

- [ ] **Step 3: Implement status and streaming routes**

Validate required body shape before calling `res.flushHeaders()`. Set:

```js
res.set({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});
```

Create an `AbortController`, abort it on `req.close` only while the response is unfinished, serialize every event with `JSON.stringify`, and end exactly once. Map unconfigured state to `LLM_NOT_CONFIGURED`.

- [ ] **Step 4: Verify the API**

Run: `node --test test/ai-edit-api.test.js test/web-errors.test.js`

Expected: all API and public-error tests PASS.

---

### Task 4: Pure Selection and Session Helpers

**Files:**
- Modify: `src/web/page.js`
- Modify: `test/page-layout.test.js`

**Interfaces:**
- Produces: `captureSelection(text, start, end, draftKey)`
- Produces: `canApplyAiResult(snapshot, currentText, draftKey)`
- Produces: `applyAiResult(snapshot, currentText, result, mode, draftKey)`
- Produces: `createAiSessionStore()`

- [ ] **Step 1: Write failing helper tests**

Test replacement, insertion, unchanged text outside the selection, changed selected text, switched note/draft key, invalid ranges, Unicode text, and per-note session isolation.

```js
const snap = captureSelection('前文旧文本后文', 2, 5, 'notes/a.md');
assert.equal(
  applyAiResult(snap, '前文旧文本后文', '新文本', 'replace', 'notes/a.md').text,
  '前文新文本后文',
);
assert.equal(canApplyAiResult(snap, '前文已修改后文', 'notes/a.md'), false);
```

- [ ] **Step 2: Run the focused helper tests and confirm they fail**

Run: `node --test test/page-layout.test.js`

Expected: FAIL because the helper exports are absent.

- [ ] **Step 3: Implement pure helpers**

Snapshots are frozen objects containing `start`, `end`, `selectedText`, and `draftKey`. Application validates both identity and exact selected text, returns a new text plus caret range, and throws a stable stale-selection error instead of mutating DOM.

- [ ] **Step 4: Verify helper behavior**

Run: `node --test test/page-layout.test.js`

Expected: helper tests PASS without changing existing page tests.

---

### Task 5: AI Chat Sidebar and Streaming Renderer

**Files:**
- Modify: `src/web/page.js`
- Modify: `src/i18n.js`
- Modify: `test/page-layout.test.js`
- Modify: `test/i18n.test.js`

**Interfaces:**
- Consumes: SSE API and Task 4 helpers
- Produces: editor-only AI sidebar with temporary per-note sessions

- [ ] **Step 1: Add failing layout and localization assertions**

Assert stable IDs for the AI toggle, panel, context switch, quick actions, message list, prompt, send, stop, and close controls. Assert English and Simplified Chinese strings for all labels, empty/error/stopped states, stale-selection warning, copy result, and the four quick actions.

- [ ] **Step 2: Run page and i18n tests and confirm they fail**

Run: `node --test test/page-layout.test.js test/i18n.test.js`

Expected: FAIL because the sidebar and message keys are absent.

- [ ] **Step 3: Add responsive sidebar markup and styles**

Use a desktop grid/flex sibling beside `editorSplit`; at narrow width, render the panel as a fixed overlay. Keep the textarea usable, preserve the existing optional preview split, and use buttons with accessible labels and visible focus styles.

- [ ] **Step 4: Implement request and session lifecycle**

Implement a browser SSE parser over `fetch()` because `EventSource` cannot POST. One request may run at a time. Each request stores its own snapshot and `AbortController`; switching note, canceling edit, or starting a new draft aborts the old request. Append text using `textContent`, never `innerHTML`.

- [ ] **Step 5: Implement application actions**

For replace/insert, call the pure helper against the current textarea and draft key, then use `setRangeText()` where possible, dispatch an `input` event, update preview, and mark the draft as no longer AI-tidied. Copy uses `navigator.clipboard.writeText()` and remains available even if the selection is stale.

- [ ] **Step 6: Verify UI source-level behavior**

Run: `node --test test/page-layout.test.js test/i18n.test.js`

Expected: all page and localization tests PASS.

---

### Task 6: Regression Verification and Documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Documents: setup, selection workflow, optional full-note context, ephemeral history, safe application, and limitations

- [ ] **Step 1: Add concise user documentation**

Document the editor workflow and state explicitly that the feature reuses existing `LLM_*`, sends selected content to the configured provider, does not persist chat, and never auto-saves model output.

- [ ] **Step 2: Run focused AI tests**

Run:

```bash
node --test test/llm-stream.test.js test/ai-edit.test.js test/ai-edit-api.test.js test/page-layout.test.js test/i18n.test.js test/web-errors.test.js
```

Expected: all focused tests PASS.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: all tests PASS with no failed, cancelled, or skipped tests introduced by this feature.

- [ ] **Step 4: Run packaging and whitespace checks**

Run:

```bash
npm run dist:dir
git diff --check
```

Expected: Electron directory build exits `0`; `git diff --check` produces no output.

- [ ] **Step 5: Inspect diagnostics for edited files**

Check `src/core/llm.js`, `src/core/ai-edit.js`, `src/web/server.js`, `src/web/page.js`, and `src/i18n.js`; fix any diagnostics introduced by this feature.
