# AI Push Drawer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the content-covering floating assistant with a resizable right-side push drawer and expose safe, actionable AI provider errors including rate-limit retry behavior.

**Architecture:** Preserve the current contextual chat and thread store, but move provider failure normalization into a focused core module and pass only whitelisted error metadata through SSE. Rework the application shell into a content-plus-drawer layout, then layer localized error cards and context-safe retries on top of the existing request ownership model.

**Tech Stack:** Node.js 18+, Express 4, browser Fetch/ReadableStream, server-rendered vanilla JavaScript, CSS Grid/flex and pointer events, `node:test`.

## Global Constraints

- Preserve current object-storage sync, contextual chat, multi-thread, and safe selection-writeback behavior.
- Never expose API keys, provider raw bodies, request messages, Vault content, stack traces, or full provider URLs in public SSE events or diagnostics.
- Public AI errors are limited to stable code, optional `retryAfterSeconds`, and short request ID.
- The desktop drawer pushes content on wide screens and becomes a dedicated assistant view on narrow screens; it must not overlay readable content.
- Selection remains the default context when non-empty; otherwise use the current document, then General.
- Do not auto-retry rate-limited requests and do not auto-save AI output.
- Do not create commits unless the user explicitly requests one; the branch contains extensive uncommitted sync and AI work.

---

### Task 1: Structured Provider Errors and Safe SSE

**Files:**
- Create: `src/core/ai-errors.js`
- Modify: `src/core/llm.js`
- Modify: `src/web/server.js`
- Create: `test/ai-errors.test.js`
- Modify: `test/llm-stream.test.js`
- Modify: `test/ai-edit-api.test.js`

**Interfaces:**
- Produces: `createAiUpstreamError(kind, metadata?)`
- Produces: `classifyAiError(error) -> { code, retryAfterSeconds?, status? }`
- Produces: `toPublicAiError(error, requestId) -> { code, requestId, retryAfterSeconds? }`
- `chatStream()` throws structured upstream errors without retaining provider bodies

- [ ] **Step 1: Write failing classifier and leak tests**

Cover:

```js
assert.deepEqual(
  classifyAiError(createAiUpstreamError('http', {
    status: 429,
    providerCode: 'limit_requests',
    retryAfterSeconds: 12,
  })),
  { code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 12 },
);
```

Also test 401/403, model-not-found provider codes, invalid request, timeout, network, interrupted stream and unknown errors. Inject API keys, Vault text, URLs and stack content into raw provider bodies and assert neither structured errors, public errors nor safe diagnostics contain them.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
node --test test/ai-errors.test.js test/llm-stream.test.js test/ai-edit-api.test.js
```

Expected: FAIL because structured classifiers and public codes are absent.

- [ ] **Step 3: Implement structured upstream errors**

For non-2xx responses, parse only whitelisted fields (`code`, nested `error.code`) and HTTP headers. Do not retain `message` or raw body after extracting a bounded provider code. Normalize `Retry-After` seconds/date safely.

For transport failures, distinguish timeout/abort owned by the timeout controller from caller cancellation; caller cancellation remains an abort path and should not be logged as provider failure.

- [ ] **Step 4: Emit safe SSE errors and diagnostics**

Generate a request ID for each AI route. Emit:

```text
event: error
data: {"code":"RATE_LIMITED","retryAfterSeconds":12,"requestId":"…"}
```

Log only `{ requestId, code, status, providerHost, model }`. Obtain host/model from safe configuration fields; never log messages or request bodies.

- [ ] **Step 5: Verify error pipeline**

Run:

```bash
node --test test/ai-errors.test.js test/llm-stream.test.js test/ai-edit-api.test.js test/web-errors.test.js
```

Expected: all error classification, streaming and leak tests PASS.

---

### Task 2: Resizable Push Drawer Layout

**Files:**
- Modify: `src/web/page.js`
- Modify: `test/page-layout.test.js`

**Interfaces:**
- Produces: `clampAiDrawerWidth(value) -> number` in range 320–560
- Produces: `createAiDrawerState({ initialWidth? })`
- State methods: `open()`, `close()`, `resize(width)`, `snapshot()`

- [ ] **Step 1: Write failing layout-state tests**

Test width clamping, in-memory-only width, open/close state and immutable snapshots. Add rendered-page assertions for:

- content-plus-drawer application shell;
- default 380px drawer;
- resizer and 320–560px constraints;
- no fixed overlay on wide screens;
- narrow-screen dedicated assistant view;
- `prefers-reduced-motion`;
- right-edge launcher while closed.

- [ ] **Step 2: Run page tests and confirm failure**

Run: `node --test test/page-layout.test.js`

Expected: FAIL because the current assistant uses `position: fixed` overlay behavior.

- [ ] **Step 3: Implement the push layout**

Use an application shell CSS variable:

```css
--ai-drawer-width: 380px;
```

When open on wide screens, reserve that width in the main layout. Preserve the content element and its scroll container so opening does not reset scroll. On narrow screens, hide the main view and let the assistant occupy the available application body instead of layering over it.

- [ ] **Step 4: Implement pointer resizing**

Use pointer capture on the drawer’s left-edge handle. Clamp every update with `clampAiDrawerWidth()`. Keep width in JavaScript memory only. Provide keyboard resizing in 16px steps with arrow keys and an accessible separator role.

- [ ] **Step 5: Preserve focus and request lifecycle**

Opening focuses the prompt without recreating the article DOM. Closing restores the launcher focus and keeps completed threads. Closing during generation retains the existing stop semantics.

- [ ] **Step 6: Verify drawer behavior**

Run: `node --test test/page-layout.test.js`

Expected: all drawer state and rendered layout tests PASS.

---

### Task 3: Actionable Error Cards and Safe Retry

**Files:**
- Modify: `src/web/page.js`
- Modify: `src/i18n.js`
- Modify: `test/page-layout.test.js`
- Modify: `test/i18n.test.js`

**Interfaces:**
- Consumes: Task 1 public `{ code, retryAfterSeconds?, requestId }`
- Produces: `aiErrorPresentation(error) -> { messageKey, canRetry, canOpenSettings }`
- Produces: `createAiRetryState({ now?, setTimer?, clearTimer? } = {})`

- [ ] **Step 1: Write failing presentation and retry tests**

Cover every public code, unknown fallback, Retry-After countdown, timer cleanup, and request-ID display. Verify:

- rate limit shows countdown then retry;
- auth/model errors expose settings action;
- interrupted/network/timeout errors expose retry;
- partial failed responses never expose copy/replace/insert;
- retry sends the original instruction but captures a fresh context snapshot.

- [ ] **Step 2: Run page and i18n tests and confirm failure**

Run: `node --test test/page-layout.test.js test/i18n.test.js`

Expected: FAIL because all errors currently collapse to one message.

- [ ] **Step 3: Parse and store structured SSE errors**

Store only public code, retry delay and request ID on the assistant message. Keep the original user instruction in thread state for manual retry. Do not store provider bodies.

- [ ] **Step 4: Render localized actionable cards**

Add bilingual strings for rate limit, authentication, model, invalid request, timeout, network, interrupted stream and fallback. Render retry/open-settings controls according to `aiErrorPresentation()`.

- [ ] **Step 5: Implement context-safe retry**

Retry invokes the normal send path with the stored instruction. That path must capture a fresh context snapshot and refresh the context label before sending; it must not reuse the failed request’s selection text or full-note authorization.

- [ ] **Step 6: Verify UI error behavior**

Run:

```bash
node --test test/page-layout.test.js test/i18n.test.js test/ai-edit-api.test.js
```

Expected: all presentation, countdown, retry and SSE tests PASS.

---

### Task 4: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Documents: push drawer, resizing, narrow view, error meanings, retry/privacy behavior

- [ ] **Step 1: Update bilingual documentation**

Describe:

- wide-screen content-pushing drawer and 320–560px resize;
- narrow-screen dedicated assistant view;
- selection-first context;
- explicit full-note authorization;
- rate-limit/auth/model/network/timeout feedback;
- manual retry always recaptures current context;
- threads and width are memory-only.

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --test test/ai-errors.test.js test/llm-stream.test.js test/ai-edit.test.js \
  test/ai-edit-api.test.js test/page-layout.test.js test/i18n.test.js test/web-errors.test.js
```

Expected: all focused tests PASS.

- [ ] **Step 3: Run the full suite**

Run: `npm test`

Expected: zero failures, cancellations, or unexpected skips.

- [ ] **Step 4: Run unsigned packaging and whitespace checks**

Run:

```bash
env -u CSC_NAME -u CSC_LINK -u CSC_KEY_PASSWORD \
  -u CSC_INSTALLER_LINK -u CSC_INSTALLER_KEY_PASSWORD \
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --dir --config.mac.identity=null
git diff --check
```

Expected: package exits `0`, signing is skipped, whitespace check prints nothing.

- [ ] **Step 5: Inspect diagnostics**

Check `src/core/ai-errors.js`, `src/core/llm.js`, `src/web/server.js`, `src/web/page.js`, and `src/i18n.js`; fix diagnostics introduced by the redesign.
