# Unified Markdown Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wikinest’s read/textarea split with an embedded Milkdown editor that edits rendered Markdown directly, autosaves safely, and integrates with existing AI and object-sync behavior.

**Architecture:** Build a Vite + TypeScript + React editor island with a narrow imperative handle, while retaining `page.js` as the owner of navigation, search, settings, sync status and the AI drawer. Markdown remains the only persisted document format; an HTTP `WikiClient` and a versioned note API isolate the editor from Express today and from a possible Electron/Tauri adapter later.

**Tech Stack:** Node.js 18+, Electron 41, Express 4, Vite 6, TypeScript 5, React 18, Milkdown 7/ProseMirror, Vitest 2, Testing Library, existing `node:test`.

## Global Constraints

- Do not migrate to Tauri/Rust in this plan.
- Do not rewrite `src/core/sync/*`, MCP, RAG or LLM services.
- First-stage scope is the note editing surface; index, search, Ask, settings and sync controls remain in `src/web/page.js`.
- Markdown file bytes remain the persisted source of truth; semantic-equivalent Markdown normalization is allowed.
- Support headings, paragraphs, hard breaks, ordered/unordered/task lists, blockquotes, emphasis, links, images, tables, fenced code and Mermaid.
- Autosave debounce is exactly 800ms; `Cmd/Ctrl+S`, note navigation, Vault switching and application shutdown flush immediately.
- Local dirty content must never be overwritten by sync or external file refresh.
- AI defaults to selection-only and full-note inclusion remains a volatile explicit grant.
- Never expose Vault content, credentials, provider bodies or local absolute paths in public errors.
- Preserve Node.js 18 compatibility.
- Do not commit task changes unless the user explicitly requests commits; existing uncommitted work overlaps `page.js`.

---

### Task 1: Editor Build Boundary and Typed Contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vite.editor.config.ts`
- Create: `tsconfig.editor.json`
- Create: `web-editor/index.html`
- Create: `web-editor/src/types.ts`
- Create: `web-editor/src/wiki-client.ts`
- Create: `web-editor/src/main.tsx`
- Create: `web-editor/src/EditorRoot.tsx`
- Create: `web-editor/test/wiki-client.test.ts`
- Modify: `src/web/server.js`
- Modify: `test/web-errors.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `WikiClient`, `NoteDocument`, `SaveNoteInput`, `SaveNoteResult`, `EditorSelectionSnapshot`, `EditorHandle`
- Produces: `HttpWikiClient`
- Produces: `window.WikinestEditor.mount(options) -> EditorHandle`
- Serves: `/editor-assets/*` from `web-dist/editor`

- [ ] **Step 1: Write failing contract and static-asset tests**

Create a Vitest test that instantiates `HttpWikiClient` with an injected fetch:

```ts
it('maps note and upload APIs without exposing fetch to components', async () => {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const client = new HttpWikiClient(async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify({
      path: 'notes/a.md',
      content: '# A',
      data: { title: 'A' },
      version: 'a'.repeat(64),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const note = await client.readNote('notes/a.md');
  expect(note.version).toHaveLength(64);
  expect(calls[0][0]).toBe('/api/note?path=notes%2Fa.md');
});
```

Add a Node test asserting `/editor-assets/editor.js` is served from an injected editor-dist directory and traversal outside that directory returns 404.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npx vitest run --config vite.editor.config.ts web-editor/test/wiki-client.test.ts
node --test test/web-errors.test.js
```

Expected: FAIL because the editor contracts, bundle and asset route do not exist.

- [ ] **Step 3: Add pinned build dependencies and scripts**

Add matching Milkdown 7 packages and Node-18-compatible build tools:

```json
{
  "scripts": {
    "editor:dev": "vite --config vite.editor.config.ts",
    "editor:build": "vite build --config vite.editor.config.ts",
    "editor:test": "vitest run --config vite.editor.config.ts",
    "test": "npm run editor:test && node --test 'test/**/*.test.js'",
    "desktop": "npm run editor:build && electron desktop/main.js",
    "desktop:dev": "concurrently -k \"npm:editor:dev\" \"wait-on http://127.0.0.1:5173/src/main.tsx && cross-env WIKINEST_EDITOR_DEV_URL=http://127.0.0.1:5173 electron desktop/main.js\""
  },
  "dependencies": {
    "@milkdown/core": "^7.21.1",
    "@milkdown/plugin-history": "^7.21.1",
    "@milkdown/plugin-listener": "^7.21.1",
    "@milkdown/preset-gfm": "^7.21.1",
    "@milkdown/prose": "^7.21.1",
    "@milkdown/react": "^7.21.1",
    "@milkdown/utils": "^7.21.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@vitejs/plugin-react": "^4.3.4",
    "concurrently": "^9.1.2",
    "cross-env": "^7.0.3",
    "jsdom": "^25.0.1",
    "typescript": "^5.7.3",
    "vite": "^6.1.0",
    "vitest": "^2.1.8",
    "wait-on": "^8.0.2"
  }
}
```

Run `npm install` so `package-lock.json` records exact resolved versions. All `@milkdown/*` packages must resolve to one version. Declare and register the GFM extension and CommonMark base preset directly, exactly once each; do not rely on a transitive CommonMark dependency.

- [ ] **Step 4: Define contracts and the HTTP adapter**

Define exact public types:

```ts
export interface NoteDocument {
  path: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  version: string;
}

export interface SaveNoteInput {
  path: string;
  markdown: string;
  baseVersion: string;
}

export interface SaveNoteResult {
  path: string;
  version: string;
  conflictPath?: string;
}

export type EditorSaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface EditorSelectionSnapshot {
  path: string;
  docRevision: number;
  from: number;
  to: number;
  selectedMarkdown: string;
}

export interface EditorHandle {
  load(document: NoteDocument): Promise<void>;
  flush(): Promise<void>;
  focus(): void;
  getMarkdown(): string;
  getDocumentState(): {
    path: string;
    version: string;
    status: EditorSaveStatus;
    revision: number;
  };
  getSelectionSnapshot(): EditorSelectionSnapshot | null;
  applyAiResult(
    snapshot: EditorSelectionSnapshot,
    markdown: string,
    mode: 'replace' | 'insert',
  ): boolean;
  destroy(): void;
}

export interface MountEditorOptions {
  element: HTMLElement;
  client: WikiClient;
  locale: 'en' | 'zh-CN';
  onStatus(status: EditorSaveStatus): void;
  onConflictOpen(path: string): void;
  onFatal(code: string): void;
}
```

`HttpWikiClient` accepts a `fetchImpl` constructor argument, URL-encodes paths, throws a typed `WikiClientError` containing only `status`, stable `code`, `conflictPath` and `currentVersion`, and never retains raw response text.

- [ ] **Step 5: Add the Vite library build and mount entry**

Configure fixed production filenames:

```ts
export default defineConfig({
  root: 'web-editor',
  plugins: [react()],
  build: {
    outDir: '../web-dist/editor',
    emptyOutDir: true,
    lib: {
      entry: 'src/main.tsx',
      formats: ['es'],
      fileName: () => 'editor.js',
      cssFileName: 'editor',
    },
  },
  test: {
    environment: 'jsdom',
    include: ['web-editor/test/**/*.test.ts', 'web-editor/test/**/*.test.tsx'],
  },
});
```

`main.tsx` exposes only:

```ts
declare global {
  interface Window {
    WikinestEditor: {
      mount(options: MountEditorOptions): EditorHandle;
    };
  }
}

window.WikinestEditor = { mount: mountUnifiedEditor };
```

- [ ] **Step 6: Serve only the built editor directory**

Add `editorDistDir` as a `createApp()` option with a production default under `web-dist/editor`, then mount:

```js
app.use('/editor-assets', express.static(editorDistDir, {
  fallthrough: false,
  index: false,
  dotfiles: 'deny',
}));
```

Add `web-dist/` to `.gitignore` and `web-dist/**/*` to `electron-builder.files`.

- [ ] **Step 7: Verify the boundary**

Run:

```bash
npm run editor:test
npm run editor:build
node --test test/web-errors.test.js
```

Expected: contract tests PASS and `web-dist/editor/editor.js` plus `editor.css` exist.

---

### Task 2: Atomic Note Versions and Conflict Copies

**Files:**
- Modify: `src/core/store.js`
- Modify: `src/web/server.js`
- Modify: `test/store.test.js`
- Create: `test/note-version-api.test.js`
- Modify: `web-editor/src/wiki-client.ts`
- Modify: `web-editor/test/wiki-client.test.ts`

**Interfaces:**
- Produces: `noteVersion(raw) -> 64-character SHA-256 hex`
- Produces: `writeNoteVersioned(path, body, { frontmatter, baseVersion })`
- Extends: `GET /api/note` with `version`
- Extends: `PUT /api/note` with optional `baseVersion`
- Conflict response: HTTP 409 `{ code: 'NOTE_VERSION_CONFLICT', conflictPath, currentVersion }`

- [ ] **Step 1: Write failing atomic-version tests**

Cover exact file-byte hashing and a race where the file changes after initial read but before rename:

```js
assert.equal(noteVersion(Buffer.from('abc')), createHash('sha256').update('abc').digest('hex'));

await assert.rejects(
  writeNoteVersioned('notes/a.md', 'local draft', {
    frontmatter: {},
    baseVersion: staleVersion,
  }),
  { code: 'NOTE_VERSION_CONFLICT' },
);
assert.equal((await readNote('notes/a.md')).content.trim(), 'external change');
```

API tests must assert that the stale body is saved to a non-colliding `*-conflict-local*.md` copy while the original remains unchanged.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
node --test test/store.test.js test/note-version-api.test.js
npx vitest run --config vite.editor.config.ts web-editor/test/wiki-client.test.ts
```

Expected: FAIL because versions and HTTP 409 conflict metadata are absent.

- [ ] **Step 3: Implement version helpers under the existing path lock**

Export:

```js
export function noteVersion(raw) {
  return createHash('sha256').update(raw).digest('hex');
}
```

`writeNoteVersioned()` must acquire the same `withPathLocks([abs])` lock used by `writeNote()`, read the current bytes inside the lock, compare `noteVersion(current)` to `baseVersion`, serialize with existing frontmatter, and recheck immediately before atomic rename. On mismatch throw:

```js
const error = new Error('note changed externally');
error.code = 'NOTE_VERSION_CONFLICT';
error.currentVersion = noteVersion(currentRaw);
throw error;
```

Return `{ path, version }` computed from the exact bytes written.

- [ ] **Step 4: Add safe local conflict-copy creation**

On `NOTE_VERSION_CONFLICT`, the API creates a path using the original stem plus `-conflict-local.md`, then `nextAvailablePath()` and `writeNote(..., { mode: 'skip' })`. Retry path allocation if a concurrent writer claims the candidate.

Return only:

```json
{
  "code": "NOTE_VERSION_CONFLICT",
  "conflictPath": "notes/a-conflict-local.md",
  "currentVersion": "<sha256>"
}
```

Do not return either document body.

- [ ] **Step 5: Extend read/save API and client**

`GET /api/note` computes `version` from `note.raw`. `PUT /api/note` keeps legacy behavior when `baseVersion` is absent and uses `writeNoteVersioned` when it is present. `HttpWikiClient.saveNote()` maps HTTP 409 to `WikiClientError`.

- [ ] **Step 6: Verify atomic conflict behavior**

Run:

```bash
node --test test/store.test.js test/note-version-api.test.js
npm run editor:test
```

Expected: original file is never overwritten on stale version, conflict copy contains the local Markdown, and all tests PASS.

---

### Task 3: Deterministic Autosave State Machine

**Files:**
- Create: `web-editor/src/autosave.ts`
- Create: `web-editor/test/autosave.test.ts`
- Modify: `web-editor/src/types.ts`

**Interfaces:**
- Produces: `createAutosaveController(options) -> AutosaveController`
- Status: `'saved' | 'dirty' | 'saving' | 'error' | 'conflict'`
- Methods: `change(markdown)`, `flush()`, `retry()`, `replaceBaseline(document)`, `snapshot()`, `destroy()`

- [ ] **Step 1: Write failing fake-clock tests**

Use Vitest fake timers to cover:

```ts
controller.change('one');
await vi.advanceTimersByTimeAsync(799);
expect(save).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(1);
expect(save).toHaveBeenCalledTimes(1);
```

Also cover composition suppression, one in-flight save, edits during save, stale completion, immediate flush, retry, conflict, baseline replacement and destroy.

- [ ] **Step 2: Run test to verify RED**

Run: `npx vitest run --config vite.editor.config.ts web-editor/test/autosave.test.ts`

Expected: FAIL because `createAutosaveController` does not exist.

- [ ] **Step 3: Implement revision-owned saves**

Maintain:

```ts
interface AutosaveSnapshot {
  status: 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
  path: string;
  markdown: string;
  baseVersion: string;
  revision: number;
  savedRevision: number;
  conflictPath?: string;
}
```

Every `change()` increments `revision`. A save captures `{ revision, markdown, baseVersion }`. Completion updates `baseVersion` but marks `saved` only when captured revision equals current revision; otherwise immediately queue the latest revision. `flush()` cancels the timer and resolves only after all queued changes are saved or a terminal error/conflict occurs.

- [ ] **Step 4: Add composition ownership**

Expose `setComposing(boolean)`. While true, `change()` updates local state but schedules no save. Transition to false schedules one 800ms save from the final composed value.

- [ ] **Step 5: Verify state machine**

Run: `npm run editor:test -- web-editor/test/autosave.test.ts`

Expected: all clock, race and error tests PASS without real time sleeps.

---

### Task 4: Milkdown GFM Editor and Markdown Round Trips

**Files:**
- Create: `web-editor/src/editor/create-editor.ts`
- Create: `web-editor/src/editor/markdown.ts`
- Create: `web-editor/src/editor/selection.ts`
- Create: `web-editor/src/UnifiedMarkdownEditor.tsx`
- Create: `web-editor/src/editor.css`
- Modify: `web-editor/src/EditorRoot.tsx`
- Modify: `web-editor/src/main.tsx`
- Create: `web-editor/test/markdown-roundtrip.test.ts`
- Create: `web-editor/test/unified-editor.test.tsx`

**Interfaces:**
- Produces: `createWikinestEditor(config)`
- Produces: `serializeSelection(view, from, to) -> string`
- Implements: `EditorHandle.load/focus/getMarkdown/getDocumentState/getSelectionSnapshot/destroy`

- [ ] **Step 1: Write failing round-trip and editing tests**

Use a fixture containing all supported GFM primitives:

```md
# 标题

- [x] 已完成
- [ ] 待处理

| 名称 | 值 |
| --- | --- |
| A | 1 |

> 引用

```js
console.log('ok')
```
```

Assert parse→serialize→parse preserves document semantics, code language/content, task state, links, images and frontmatter separation. Component tests must type directly into rendered paragraph content and observe Markdown change without opening a textarea.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npx vitest run --config vite.editor.config.ts \
  web-editor/test/markdown-roundtrip.test.ts \
  web-editor/test/unified-editor.test.tsx
```

Expected: FAIL because the Milkdown editor is not mounted.

- [ ] **Step 3: Create one GFM editor instance**

Configure `Editor.make()` with the CommonMark base preset and GFM extension exactly once each, plus history and listener plugins. Set initial Markdown through `defaultValueCtx` and route listener updates to the autosave controller.

React state receives only save status and fatal editor state, not per-keystroke Markdown.

- [ ] **Step 4: Implement composition and keyboard behavior**

Wire ProseMirror composition events to `autosave.setComposing()`. Handle `Mod-s` with `preventDefault()` and `void autosave.flush()`. Preserve ProseMirror history so typing, paste and programmatic transactions can be undone.

- [ ] **Step 5: Implement safe selection snapshots**

`getSelectionSnapshot()` returns null for an empty selection. For non-empty selections, serialize the selected ProseMirror slice to Markdown and include current `path`, local revision, `from`, and `to`.

- [ ] **Step 6: Add save-state UI**

Render localized status text and buttons:

```tsx
<button hidden={status !== 'error'} onClick={() => autosave.retry()}>
  {t('editor.retrySave')}
</button>
```

Conflict status links to `conflictPath` through the host callback; it never displays an absolute path.

- [ ] **Step 7: Verify editor core**

Run:

```bash
npm run editor:test
npm run editor:build
```

Expected: supported Markdown round trips semantically, direct rendered editing works, and bundle builds.

---

### Task 5: Host Integration, Navigation Flush and Source Fallback

**Files:**
- Modify: `src/web/page.js`
- Modify: `src/i18n.js`
- Modify: `test/page-layout.test.js`
- Modify: `test/i18n.test.js`
- Modify: `web-editor/src/main.tsx`
- Modify: `web-editor/src/types.ts`
- Create: `web-editor/test/host-lifecycle.test.ts`

**Interfaces:**
- Consumes: `window.WikinestEditor.mount()`
- Produces host callbacks: `onStatus`, `onConflictOpen`, `onFatal`, `onMarkdownChange`
- Produces: `flushUnifiedEditor()`

- [ ] **Step 1: Write failing lifecycle tests**

Cover:

- loading a note mounts the unified editor and hides legacy read/textarea UI;
- switching notes awaits `flush()` before fetching the next note;
- index, Vault switch and `beforeunload` call `flush()`;
- initialization failure opens source fallback;
- fallback destroys the unified editor before enabling textarea writes;
- a stale `openNote()` response cannot load into the editor.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
node --test test/page-layout.test.js test/i18n.test.js
npx vitest run --config vite.editor.config.ts web-editor/test/host-lifecycle.test.ts
```

Expected: FAIL because `page.js` still owns separate read and textarea flows.

- [ ] **Step 3: Add the editor mount point and production assets**

Add:

```html
<div id="unifiedEditor" hidden></div>
```

Keep `#articleRead` and `#editor` as hidden fallback surfaces.

`renderPage()` receives an `editorAssetBase` derived only from trusted server configuration. Production emits:

```html
<link rel="stylesheet" href="/editor-assets/editor.css">
<script type="module" src="/editor-assets/editor.js"></script>
```

When `WIKINEST_EDITOR_DEV_URL=http://127.0.0.1:5173`, it emits:

```html
<script type="module" src="http://127.0.0.1:5173/src/main.tsx"></script>
```

Only loopback `http://127.0.0.1:<port>` development URLs are accepted; invalid values fall back to production assets. Vite handles CSS injection and HMR in development.

- [ ] **Step 4: Replace the primary open/edit flow**

`openNote()` maps the API response to:

```js
await unifiedEditor.load({
  path: note.path,
  markdown: note.content,
  frontmatter: note.data,
  version: note.version,
});
```

`showArticle()` displays `#unifiedEditor`. Existing “Edit” and preview toggle are removed from the primary toolbar; “查看 Markdown 源码” invokes an explicit fallback transition.

- [ ] **Step 5: Serialize host transitions**

Create one navigation promise chain. Every transition calls `flushUnifiedEditor()` before mutating `current`, switching Vault, returning to index, or allowing desktop shutdown. If flush returns conflict/error, keep the current editor visible and ask the user whether to continue; never silently discard.

- [ ] **Step 6: Preserve fallback exclusivity**

Entering fallback:

1. awaits `flush()`;
2. calls `destroy()`;
3. copies current Markdown into textarea;
4. enables legacy save.

Returning to unified mode saves or discards fallback changes explicitly, then creates a fresh editor instance. Both modes must never have active autosave simultaneously.

- [ ] **Step 7: Verify host lifecycle**

Run:

```bash
node --test test/page-layout.test.js test/i18n.test.js test/boot.test.js
npm run editor:test
```

Expected: all navigation, fallback and old-response guard tests PASS.

---

### Task 6: Images, Tables, Code Blocks and Mermaid Nodes

**Files:**
- Create: `web-editor/src/editor/upload.ts`
- Create: `web-editor/src/editor/mermaid-node.ts`
- Create: `web-editor/src/MermaidView.tsx`
- Modify: `web-editor/src/editor/create-editor.ts`
- Modify: `web-editor/src/UnifiedMarkdownEditor.tsx`
- Create: `web-editor/test/upload.test.ts`
- Create: `web-editor/test/mermaid.test.tsx`
- Modify: `test/upload.test.js`

**Interfaces:**
- Produces: `createUploadController(client)`
- Produces: Mermaid node view preserving fenced source and language `mermaid`

- [ ] **Step 1: Write failing rich-node tests**

Test:

- paste/drop image inserts a temporary placeholder;
- successful upload replaces it with a Markdown image;
- failed upload leaves a retry control and no broken URL;
- GFM table and task mutations serialize correctly;
- Mermaid inactive view renders a diagram;
- active view edits source;
- invalid Mermaid retains source and shows a local error.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npx vitest run --config vite.editor.config.ts \
  web-editor/test/upload.test.ts \
  web-editor/test/mermaid.test.tsx
node --test test/upload.test.js
```

Expected: FAIL because custom upload and Mermaid node behavior are absent.

- [ ] **Step 3: Implement one upload pipeline**

Paste, drop and file-picker paths all call:

```ts
const uploaded = await client.uploadImage(file, signal);
replacePlaceholder(placeholderId, {
  src: uploaded.url,
  alt: file.name.replace(/\.[^.]+$/, ''),
});
```

Validate image MIME and size before calling the API. Abort upload when the node is deleted or editor destroyed.

- [ ] **Step 4: Implement safe Mermaid rendering**

Use the packaged Mermaid module with `securityLevel: 'strict'`. Render into an isolated node-view container. Keep source in the ProseMirror node attributes/content; render errors update only node-view state and never replace source.

- [ ] **Step 5: Verify rich nodes and undo**

Run: `npm run editor:test`

Expected: upload replacement, table/task edits, code language, Mermaid source, error state and single-step undo tests PASS.

---

### Task 7: ProseMirror AI Context and Safe Write-Back

**Files:**
- Modify: `web-editor/src/editor/selection.ts`
- Modify: `web-editor/src/UnifiedMarkdownEditor.tsx`
- Modify: `web-editor/src/types.ts`
- Modify: `src/web/page.js`
- Modify: `test/page-layout.test.js`
- Create: `web-editor/test/ai-selection.test.ts`

**Interfaces:**
- Consumes: `EditorSelectionSnapshot`
- Implements: `EditorHandle.applyAiResult(snapshot, markdown, mode) -> boolean`
- Host context: `selection | document | general`

- [ ] **Step 1: Write failing selection and stale-write tests**

Cover:

- non-empty ProseMirror selection sends only selected Markdown;
- empty editor selection sends the full current Markdown;
- full-note grant is false by default and bound to the exact snapshot;
- changed path, revision, range or selected Markdown rejects write-back;
- replace/insert is one undoable transaction;
- accepted write-back schedules normal autosave.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npx vitest run --config vite.editor.config.ts web-editor/test/ai-selection.test.ts
node --test test/page-layout.test.js
```

Expected: FAIL because AI still reads textarea/DOM-selection snapshots.

- [ ] **Step 3: Route AI context through `EditorHandle`**

When unified editor is active, `captureAiContext()` uses:

```js
const snapshot = unifiedEditor.getSelectionSnapshot();
return snapshot
  ? { mode: 'selection', content: snapshot.selectedMarkdown, snapshot }
  : { mode: 'document', content: unifiedEditor.getMarkdown() };
```

Use the existing `EditorHandle.getMarkdown()` contract from Task 1. Keep the old textarea/rendered selection code only for fallback mode.

- [ ] **Step 4: Apply results as guarded transactions**

Before dispatch, validate path, revision, valid range and reserialized selected slice. Parse returned Markdown into a ProseMirror slice, then replace or insert in one transaction with history enabled. Return false on any mismatch and expose copy only.

- [ ] **Step 5: Verify AI integration**

Run:

```bash
npm run editor:test
node --test test/page-layout.test.js test/ai-edit.test.js test/ai-edit-api.test.js
```

Expected: new editor selection/write-back tests and all existing AI privacy/error tests PASS.

---

### Task 8: Sync Refresh, Dirty Protection and Desktop Flush

**Files:**
- Modify: `src/web/page.js`
- Modify: `desktop/main.js`
- Modify: `desktop/settings-preload.cjs`
- Modify: `desktop/ipc-security.js`
- Modify: `test/page-layout.test.js`
- Modify: `test/boot.test.js`
- Create: `web-editor/test/external-refresh.test.ts`

**Interfaces:**
- Produces: `EditorHandle.getDocumentState() -> { path, version, status, revision }`
- Produces IPC: `editor:flush-request` / `editor:flush-result`

- [ ] **Step 1: Write failing external-refresh and shutdown tests**

Test:

- clean editor reloads a newer version;
- dirty/saving/error editor rejects external replacement;
- sync status never calls `load()` over dirty state;
- app close requests renderer flush and waits up to 15 seconds;
- conflict/error keeps window open unless user explicitly confirms exit;
- switching Vault uses the same flush gate.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npx vitest run --config vite.editor.config.ts web-editor/test/external-refresh.test.ts
node --test test/page-layout.test.js test/boot.test.js
```

Expected: FAIL because desktop close and sync refresh know only legacy textarea dirty state.

- [ ] **Step 3: Guard sync refresh with editor state**

Replace legacy `editorRaw === currentRaw` checks in unified mode with `getDocumentState()`. Only `status === 'saved'` permits a version-changing reload. Dirty states show “检测到外部修改” without mutating the document.

- [ ] **Step 4: Add bounded desktop flush handshake**

Before window close or Vault switch, main sends `editor:flush-request` with a request ID. Preload exposes a listener and a reply method. Renderer calls `flush()` and replies `{ ok: true }` or `{ ok: false, code }`. Main waits at most 15 seconds, then presents an explicit continue/cancel choice.

Validate request IDs and trusted sender origin with existing IPC policy.

- [ ] **Step 5: Verify refresh and lifecycle safety**

Run:

```bash
npm run editor:test
node --test test/page-layout.test.js test/boot.test.js test/desktop-security.test.js test/sync-desktop-ipc.test.js
```

Expected: dirty content survives sync refresh, shutdown and Vault-switch tests PASS, and IPC sender tests remain green.

---

### Task 9: Documentation, Packaging and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `package.json`

**Interfaces:**
- Documents: unified editing, autosave, source fallback, conflicts, AI selection and supported Markdown

- [ ] **Step 1: Update bilingual documentation**

Document:

- rendered Markdown is directly editable;
- autosave after 800ms and `Cmd/Ctrl+S`;
- semantic Markdown normalization;
- source fallback;
- version conflicts and conflict copies;
- selection-first AI;
- supported GFM, images and Mermaid;
- Electron remains the desktop runtime.

- [ ] **Step 2: Run all editor and backend tests**

Run:

```bash
npm run editor:test
node --test 'test/**/*.test.js'
```

Expected: zero failures, cancellations or unexpected skips.

- [ ] **Step 3: Run production bundle and unsigned Electron packaging**

Run:

```bash
npm run editor:build
env -u CSC_NAME -u CSC_LINK -u CSC_KEY_PASSWORD \
  -u CSC_INSTALLER_LINK -u CSC_INSTALLER_KEY_PASSWORD \
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --dir --config.mac.identity=null
```

Expected: editor assets are present in the packaged app, Electron packaging exits `0`, and signing is skipped.

- [ ] **Step 4: Run static checks**

Run:

```bash
npx tsc -p tsconfig.editor.json --noEmit
git diff --check
```

Read diagnostics for all changed TypeScript, JavaScript and TSX files. Expected: zero TypeScript errors, linter errors or whitespace errors.

- [ ] **Step 5: Perform a manual desktop acceptance pass**

Run `npm run desktop` and verify:

1. open an existing Chinese note and type without clicking Edit;
2. wait 800ms and observe Saved;
3. use Chinese IME, undo and redo;
4. edit a table, task item, code block and Mermaid source;
5. paste an image;
6. select text, ask AI, replace it and undo once;
7. cause an external file update while dirty and confirm no overwrite;
8. switch notes and quit with a pending save.

Record exact pass/fail results in `.superpowers/sdd/unified-editor-verification.md`.
