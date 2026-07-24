import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pageModule from '../src/web/page.js';
import {
  PAGE_HTML,
  applyAiResult,
  buildSyncPayload,
  canApplyAiResult,
  canRefreshSyncedNote,
  captureSelection,
  createDocumentNavigator,
  createUnifiedEditorHost,
  createAiSessionStore,
  createAiThreadStore,
  createSettingsOpener,
  deriveAiContext,
  isAiMessageActionable,
  loadNoteWithGuard,
  refreshSyncedNote,
  renderPage,
} from '../src/web/page.js';

const EN_HTML = renderPage('en');
const ZH_HTML = renderPage('zh-CN');
const README_EN = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const README_ZH = readFileSync(new URL('../README.zh-CN.md', import.meta.url), 'utf8');

test('clean source fallback can leave while dirty or conflicted fallback stays protected', () => {
  assert.equal(pageModule.canLeaveSourceFallback({
    active: true,
    markdown: '# unchanged',
    baseline: '# unchanged',
    conflictPath: null,
  }), true);
  assert.equal(pageModule.canLeaveSourceFallback({
    active: true,
    markdown: '# edited',
    baseline: '# unchanged',
    conflictPath: null,
  }), false);
  assert.equal(pageModule.canLeaveSourceFallback({
    active: true,
    markdown: '# unchanged',
    baseline: '# unchanged',
    conflictPath: 'notes/a-conflict-local.md',
  }), false);
});

test('unified editing keeps the original title, categories, and organize actions visible', () => {
  const element = () => ({ style: { display: 'initial' }, hidden: true });
  const elements = {
    articleRead: element(),
    articleBody: element(),
    articleSubtitle: element(),
    unifiedEditor: element(),
    legacyEditor: element(),
    returnEditorButton: element(),
    editButton: element(),
    deleteButton: element(),
    renameButton: element(),
    tidyButton: element(),
    saveButton: element(),
    cancelButton: element(),
  };

  pageModule.applyUnifiedArticleChrome(elements, { organizeEnabled: true });

  assert.equal(elements.articleRead.style.display, '');
  assert.equal(elements.articleBody.style.display, 'none');
  assert.equal(elements.articleSubtitle.style.display, 'none');
  assert.equal(elements.unifiedEditor.hidden, false);
  assert.equal(elements.tidyButton.style.display, '');
  assert.equal(elements.editButton.style.display, '');
  assert.equal(elements.deleteButton.style.display, '');
  assert.equal(elements.renameButton.style.display, '');
  assert.equal(elements.saveButton.style.display, 'none');
});

test('document navigator flushes once before effects and suppresses effects after a failed flush', async () => {
  assert.equal(typeof createDocumentNavigator, 'function');
  const events = [];
  let allow = true;
  const host = {
    async transition(effect) {
      events.push('flush');
      if (!allow) return false;
      await effect();
      return true;
    },
    async open(options) {
      events.push(`open:${options.path}`);
      return true;
    },
  };
  const navigator = createDocumentNavigator(host, {
    index: () => events.push('index'),
    ask: () => events.push('ask'),
    reload: () => events.push('reload'),
  });

  assert.equal(await navigator.run('index'), true);
  assert.equal(await navigator.run('ask'), true);
  assert.equal(await navigator.open({ path: 'notes/a.md' }), true);
  allow = false;
  assert.equal(await navigator.run('reload'), false);
  assert.deepEqual(events, ['flush', 'index', 'flush', 'ask', 'open:notes/a.md', 'flush']);
});

test('document navigator delegates open directly without nesting a host transition', async () => {
  let transitioning = false;
  const host = {
    async transition(effect) {
      assert.equal(transitioning, false, 'nested transition would deadlock the host queue');
      transitioning = true;
      try {
        await effect();
        return true;
      } finally {
        transitioning = false;
      }
    },
    async open() {
      assert.equal(transitioning, false, 'open must not be wrapped in transition');
      return true;
    },
  };
  const navigator = createDocumentNavigator(host);
  assert.equal(await navigator.open({ path: 'notes/a.md' }), true);
});

test('mutation runAndOpen flushes once, never opens after API failure, and preserves guards', async () => {
  for (const mutation of ['rename', 'tidy', 'synthesize', 'delete']) {
    const calls = [];
    let allow = true;
    const host = {
      async runAndOpen({ operation, fetchNote, path, guard }) {
        calls.push('flush');
        if (!allow) return false;
        const result = await operation();
        if (!result) return true;
        const note = await fetchNote(result);
        if (path && note.path !== path) return false;
        if (guard && !guard()) return false;
        calls.push(`open:${note.path}`);
        return true;
      },
      transition: async () => true,
      open: async () => { throw new Error('must not use public open'); },
    };
    const navigator = createDocumentNavigator(host);
    assert.equal(await navigator.runAndOpen({
      operation: async () => {
        calls.push(`api:${mutation}`);
        return { path: `notes/${mutation}.md` };
      },
      fetchNote: async ({ path }) => ({ path }),
      path: `notes/${mutation}.md`,
      guard: () => true,
    }), true);
    assert.deepEqual(calls, ['flush', `api:${mutation}`, `open:notes/${mutation}.md`]);

    calls.length = 0;
    allow = false;
    assert.equal(await navigator.runAndOpen({
      operation: async () => { calls.push('api'); return { path: 'notes/no.md' }; },
      fetchNote: async () => { calls.push('open'); return { path: 'notes/no.md' }; },
      path: 'notes/no.md',
    }), false);
    assert.deepEqual(calls, ['flush']);

    calls.length = 0;
    allow = true;
    await assert.rejects(
      navigator.runAndOpen({
        operation: async () => { calls.push('api'); throw new Error('API failed'); },
        fetchNote: async () => { calls.push('open'); return { path: 'notes/no.md' }; },
      }),
      /API failed/,
    );
    assert.deepEqual(calls, ['flush', 'api']);
  }
});

test('document navigator gates every departure-effect class behind one successful transition', async () => {
  const classes = [
    'sidebar', 'list', 'search', 'ask', 'back', 'noteLink', 'newDraft',
    'fallbackReturn', 'postMutationOpen', 'deleteIndex', 'logout', 'localeReload', 'vaultSwitch',
  ];
  const calls = [];
  let flushSucceeded = true;
  const navigator = createDocumentNavigator({
    async transition(effect) {
      calls.push('flush');
      if (!flushSucceeded) return false;
      await effect();
      return true;
    },
    open: async () => true,
  }, Object.fromEntries(classes.map((name) => [name, () => calls.push(name)])));

  for (const name of classes) assert.equal(await navigator.run(name), true);
  flushSucceeded = false;
  assert.equal(await navigator.run('logout'), false);
  assert.deepEqual(calls, classes.flatMap((name) => ['flush', name]).concat('flush'));
});

test('page wires every document departure through the navigator without wrapping openNote', () => {
  assert.match(PAGE_HTML, /const documentNavigator = createDocumentNavigator\(editorHost\)/);
  assert.match(PAGE_HTML, /function leaveCurrentDocument\(action\)[\s\S]*?documentNavigator\.leave\(action\)/);
  assert.match(PAGE_HTML, /return documentNavigator\.open\(\{/);
  assert.doesNotMatch(PAGE_HTML, /documentNavigator\.leave\(\(\) => openNote\(/);
  for (const pattern of [
    /brand\.onclick = \(\) => leaveCurrentDocument/,
    /row\.onclick = \(\) => openNote\(it\.path\)/,
    /await leaveCurrentDocument\(showIndex\)/,
    /return leaveCurrentDocument\(\(\) => doAsk\(query\)\)/,
    /\$\('newBtn'\)\.onclick = \(\) => startDraft\(\)/,
    /leaveCurrentDocument\(async \(\) => \{ location\.reload\(\); \}\)/,
    /window\.wikiSettings\.chooseVault\(\)/,
  ]) assert.match(PAGE_HTML, pattern);
});

test('unified editor host serializes flushes, discards stale loads, and preserves fallback exclusivity', async () => {
  assert.equal(typeof createUnifiedEditorHost, 'function');
  const events = [];
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const editor = {
    load: async (note) => events.push(`load:${note.path}`),
    flush: async () => events.push('flush'),
    getMarkdown: () => 'editor markdown',
    destroy: () => events.push('destroy'),
    getDocumentState: () => ({ status: 'dirty' }),
  };
  const host = createUnifiedEditorHost({
    mount: () => editor,
    client: {},
    element: {},
    locale: 'en',
    onFallback: (markdown) => events.push(`fallback:${markdown}`),
  });

  const stale = host.open({
    fetchNote: () => first,
    path: 'notes/first.md',
  });
  const current = host.open({
    fetchNote: async () => ({ path: 'notes/second.md', content: 'second', data: {}, version: 'v2' }),
    path: 'notes/second.md',
  });
  resolveFirst({ path: 'notes/first.md', content: 'first', data: {}, version: 'v1' });
  assert.equal(await stale, false);
  assert.equal(await current, true);
  assert.deepEqual(events, ['load:notes/second.md']);

  await host.enterFallback();
  assert.deepEqual(events, ['load:notes/second.md', 'flush', 'destroy', 'fallback:editor markdown']);
});

test('runAndOpen drops a stale mutation load before applying it', async () => {
  const events = [];
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const editor = {
    load: async (note) => events.push(`load:${note.path}`),
    flush: async () => events.push('flush'),
    destroy: () => {},
  };
  const host = createUnifiedEditorHost({
    mount: () => editor, client: {}, element: {}, locale: 'en',
  });
  await host.load({ path: 'notes/current.md', markdown: '', frontmatter: {}, version: 'v0' });
  events.length = 0;
  const stale = host.runAndOpen({
    operation: async () => ({ path: 'notes/first.md' }),
    fetchNote: () => first,
  });
  const current = host.runAndOpen({
    operation: async () => ({ path: 'notes/second.md' }),
    fetchNote: async () => ({ path: 'notes/second.md', content: 'second', data: {}, version: 'v2' }),
  });
  resolveFirst({ path: 'notes/first.md', content: 'first', data: {}, version: 'v1' });
  assert.equal(await stale, false);
  assert.equal(await current, true);
  assert.deepEqual(events, ['flush', 'flush', 'load:notes/second.md']);
});

test('unified editor host leaves current editor visible when flush fails', async () => {
  const editor = {
    load: async () => {},
    flush: async () => { throw new Error('conflict'); },
    getMarkdown: () => '',
    destroy: () => {},
    getDocumentState: () => ({ status: 'conflict' }),
  };
  let blocked = 0;
  const host = createUnifiedEditorHost({
    mount: () => editor,
    client: {},
    element: {},
    locale: 'en',
    onFlushFailure: () => { blocked += 1; },
  });
  await host.open({
    fetchNote: async () => ({ path: 'notes/a.md', content: 'a', data: {}, version: 'v1' }),
    path: 'notes/a.md',
  });
  assert.equal(await host.transition(async () => {}), false);
  assert.equal(blocked, 1);
});

test('unified editor host destroys autosave owner before fatal fallback and proxies AI methods', async () => {
  const events = [];
  let mountOptions;
  const editor = {
    load: async () => {},
    flush: async () => {},
    getMarkdown: () => 'unsaved unified markdown',
    getSelectionSnapshot: () => ({ path: 'notes/a.md', docRevision: 1, from: 1, to: 2, selectedMarkdown: 'x' }),
    getDocumentState: () => ({ path: 'notes/a.md', status: 'dirty' }),
    applyAiResult: () => true,
    destroy: () => events.push('destroy'),
  };
  const host = createUnifiedEditorHost({
    mount: (options) => { mountOptions = options; return editor; },
    client: {}, element: {}, locale: 'en',
    onFatal: (code, markdown) => events.push(`fatal:${code}:${markdown}`),
  });
  await host.load({ path: 'notes/a.md', markdown: 'initial', frontmatter: {}, version: 'v1' });
  assert.equal(host.getMarkdown(), 'unsaved unified markdown');
  assert.equal(host.getSelectionSnapshot().selectedMarkdown, 'x');
  assert.equal(host.applyAiResult({}, 'changed', 'replace'), true);
  mountOptions.onFatal('EDITOR_RUNTIME_FAILED');
  assert.deepEqual(events, ['destroy', 'fatal:EDITOR_RUNTIME_FAILED:unsaved unified markdown']);
  assert.equal(host.getDocumentState(), null);
});

test('AI context UI state and request payload share one captured snapshot', () => {
  assert.equal(typeof pageModule.createAiContextUiState, 'function');
  assert.equal(typeof pageModule.buildAiChatPayload, 'function');
  const captured = Object.freeze({
    mode: 'selection',
    content: '旧选区',
    noteContent: '旧全文',
    label: '旧标题',
  });
  const uiState = pageModule.createAiContextUiState(captured, true);
  const laterCapture = Object.freeze({
    mode: 'selection',
    content: '新选区',
    noteContent: '新全文',
    label: '新标题',
  });
  const payload = pageModule.buildAiChatPayload(
    uiState.context,
    [{ role: 'user', content: '润色' }],
    uiState.includeNote,
  );

  assert.equal(uiState.context, captured);
  assert.equal(uiState.context.label, '旧标题');
  assert.equal(payload.selection, '旧选区');
  assert.equal(payload.noteContent, '旧全文');
  assert.doesNotMatch(JSON.stringify(payload), /新选区|新全文|新标题/);
  assert.notEqual(uiState.context, laterCapture);
});

test('fallback note client works without the editor bundle and sanitizes conflict metadata', async () => {
  assert.equal(typeof pageModule.createSafeNoteClient, 'function');
  const calls = [];
  const client = pageModule.createSafeNoteClient(async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify({
      path: 'notes/renamed.md',
      version: 'b'.repeat(64),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const saved = await client.saveNote({
    path: 'notes/draft.md', markdown: 'body', unique: true,
  });
  assert.equal(saved.path, 'notes/renamed.md');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    path: 'notes/draft.md', markdown: 'body', unique: true,
  });

  const conflictClient = pageModule.createSafeNoteClient(async () => new Response(JSON.stringify({
    code: 'NOTE_VERSION_CONFLICT',
    conflictPath: 'notes/a-conflict-local.md',
    currentVersion: 'c'.repeat(64),
    error: 'secret upstream body',
  }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(
    conflictClient.saveNote({ path: 'notes/a.md', markdown: 'body', baseVersion: 'a'.repeat(64) }),
    (error) => error.code === 'NOTE_VERSION_CONFLICT'
      && error.conflictPath === 'notes/a-conflict-local.md'
      && !error.message.includes('secret'),
  );

  const maliciousClient = pageModule.createSafeNoteClient(async () => new Response(JSON.stringify({
    code: '../../BAD',
    conflictPath: '../secret.md',
    currentVersion: 'invalid',
    error: 'super-secret',
  }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(
    maliciousClient.saveNote({ path: 'notes/a.md', markdown: 'body', baseVersion: 'a'.repeat(64) }),
    (error) => error.code === 'HTTP_409'
      && error.conflictPath === undefined
      && !error.message.includes('secret'),
  );
});

test('fallback note client bounds oversized error bodies and releases their reader lock', async () => {
  const events = { cancel: 0, release: 0 };
  const client = pageModule.createSafeNoteClient(async () => ({
    ok: false,
    status: 502,
    headers: { get: () => 'application/json' },
    body: {
      getReader() {
        return {
          async read() {
            return {
              done: false,
              value: new TextEncoder().encode(`{"error":"${'super-secret'.repeat(10_000)}"}`),
            };
          },
          async cancel() { events.cancel += 1; },
          releaseLock() { events.release += 1; },
        };
      },
    },
  }));

  await assert.rejects(
    client.saveNote({ path: 'notes/a.md', markdown: 'body' }),
    (error) => error.code === 'HTTP_502' && !error.message.includes('super-secret'),
  );
  assert.deepEqual(events, { cancel: 1, release: 1 });
});

test('AI selection full-note state defaults off and resets outside selection mode', () => {
  assert.equal(typeof pageModule.createAiContextUiState, 'function');
  const selection = { mode: 'selection', content: '选区', noteContent: '全文' };
  assert.deepEqual(
    pageModule.createAiContextUiState(selection),
    {
      context: selection,
      modeKey: 'ai.contextSelection',
      suggestionKeys: ['ai.quick.polish', 'ai.quick.shorten', 'ai.quick.expand', 'ai.quick.fix'],
      showIncludeNote: true,
      includeNote: false,
    },
  );
  assert.equal(pageModule.createAiContextUiState(selection, true).includeNote, true);

  for (const mode of ['document', 'general']) {
    const state = pageModule.createAiContextUiState({ mode, content: '文档' }, true);
    assert.equal(state.showIncludeNote, false);
    assert.equal(state.includeNote, false);
  }
});

test('AI full-note grant is volatile and bound to one exact selection context', () => {
  assert.equal(typeof pageModule.updateAiIncludeNoteGrant, 'function');
  assert.equal(typeof pageModule.isAiIncludeNoteGranted, 'function');
  const selection = {
    mode: 'selection',
    draftKey: 'notes/a.md',
    path: 'notes/a.md',
    selectionStart: 0,
    selectionEnd: 2,
    content: '选区',
    noteContent: '选区和全文',
  };
  const changedSelection = { ...selection, selectionStart: 3, selectionEnd: 5 };
  const changedDraft = { ...selection, draftKey: 'notes/b.md', path: 'notes/b.md' };
  let grant = pageModule.updateAiIncludeNoteGrant(null, selection, true);

  assert.equal(pageModule.isAiIncludeNoteGranted(grant, selection), true);
  assert.equal(pageModule.isAiIncludeNoteGranted(grant, changedSelection), false);
  assert.equal(pageModule.isAiIncludeNoteGranted(grant, changedDraft), false);
  grant = pageModule.updateAiIncludeNoteGrant(grant, changedSelection);
  assert.equal(grant, null);
});

test('AI full-note grant binds the exact unified editor snapshot and request context freezes it', () => {
  const snapshot = {
    path: 'notes/a.md',
    docRevision: 7,
    from: 4,
    to: 8,
    selectedMarkdown: '选区',
  };
  const context = {
    mode: 'selection',
    draftKey: 'notes/a.md',
    path: 'notes/a.md',
    content: '选区',
    noteContent: '未保存全文',
    snapshot,
  };
  const grant = pageModule.updateAiIncludeNoteGrant(null, context, true);
  const frozen = pageModule.freezeAiRequestContext(context);

  assert.equal(pageModule.isAiIncludeNoteGranted(grant, context), true);
  assert.equal(pageModule.isAiIncludeNoteGranted(grant, {
    ...context,
    snapshot: { ...snapshot, docRevision: 8 },
  }), false);
  assert.equal(pageModule.isAiIncludeNoteGranted(grant, {
    ...context,
    snapshot: { ...snapshot, selectedMarkdown: '别的选区' },
  }), false);
  snapshot.selectedMarkdown = '已变化';
  assert.equal(frozen.snapshot.selectedMarkdown, '选区');
  assert.equal(Object.isFrozen(frozen.snapshot), true);
  assert.deepEqual(pageModule.buildAiChatPayload(frozen, [], true), {
    mode: 'selection',
    messages: [],
    selection: '选区',
    noteContent: '未保存全文',
    includeNote: true,
  });
});

test('AI full-note grant stays revoked across close, general, document, selection, and reopen', () => {
  assert.equal(typeof pageModule.updateAiIncludeNoteGrant, 'function');
  const selection = {
    mode: 'selection',
    draftKey: 'notes/a.md',
    path: 'notes/a.md',
    selectionStart: 0,
    selectionEnd: 2,
    content: '选区',
    noteContent: '私密全文',
  };
  let grant = pageModule.updateAiIncludeNoteGrant(null, selection, true);
  // Closing the panel does not itself observe a new context.
  assert.equal(pageModule.isAiIncludeNoteGranted(grant, selection), true);
  grant = pageModule.updateAiIncludeNoteGrant(grant, { mode: 'general' });
  grant = pageModule.updateAiIncludeNoteGrant(grant, { mode: 'document', content: '另一文档' });
  grant = pageModule.updateAiIncludeNoteGrant(grant, selection);

  const reopened = pageModule.createAiContextUiState(
    selection,
    pageModule.isAiIncludeNoteGranted(grant, selection),
  );
  const firstPayload = pageModule.buildAiChatPayload(
    reopened.context,
    [{ role: 'user', content: '首次发送' }],
    reopened.includeNote,
  );
  assert.equal(grant, null);
  assert.equal(reopened.includeNote, false);
  assert.equal(firstPayload.includeNote, false);
  assert.equal(firstPayload.noteContent, '');
  assert.doesNotMatch(JSON.stringify(firstPayload), /私密全文/);
});

test('AI chat payload sends selection full text only after explicit opt-in', () => {
  assert.equal(typeof pageModule.buildAiChatPayload, 'function');
  const context = { mode: 'selection', content: '公开选区', noteContent: '私密全文' };
  const messages = [{ role: 'user', content: '润色' }];

  assert.deepEqual(pageModule.buildAiChatPayload(context, messages, false), {
    mode: 'selection',
    messages,
    selection: '公开选区',
    noteContent: '',
    includeNote: false,
  });
  assert.deepEqual(pageModule.buildAiChatPayload(context, messages, true), {
    mode: 'selection',
    messages,
    selection: '公开选区',
    noteContent: '私密全文',
    includeNote: true,
  });
});

test('AI context refresh strategy covers editor selection, input, and keyboard and mouse changes', () => {
  assert.deepEqual(pageModule.AI_CONTEXT_REFRESH_EVENTS, ['select', 'input', 'keyup', 'mouseup']);
});

test('rendered article selection helper trims, bounds, and rejects invalid selections', () => {
  assert.equal(typeof pageModule.readRenderedArticleSelection, 'function');
  const insideStart = { inside: true };
  const insideEnd = { inside: true };
  const outside = { inside: false };
  const container = {
    contains(node) {
      return !!node?.inside;
    },
  };
  const validSelection = {
    rangeCount: 1,
    getRangeAt() {
      return {
        collapsed: false,
        startContainer: insideStart,
        endContainer: insideEnd,
      };
    },
    toString() {
      return '  abcdef  ';
    },
  };
  assert.equal(
    pageModule.readRenderedArticleSelection(validSelection, container, { maxChars: 4 }),
    'abcd',
  );
  for (const selection of [
    null,
    { rangeCount: 0 },
    {
      rangeCount: 1,
      getRangeAt() {
        return {
          collapsed: true,
          startContainer: insideStart,
          endContainer: insideEnd,
        };
      },
      toString() {
        return 'abc';
      },
    },
    {
      rangeCount: 1,
      getRangeAt() {
        return {
          collapsed: false,
          startContainer: outside,
          endContainer: insideEnd,
        };
      },
      toString() {
        return 'abc';
      },
    },
    {
      rangeCount: 1,
      getRangeAt() {
        throw new Error('boom');
      },
      toString() {
        return 'abc';
      },
    },
    {
      rangeCount: 1,
      getRangeAt() {
        return {
          collapsed: false,
          startContainer: insideStart,
          endContainer: insideEnd,
        };
      },
      toString() {
        return '   ';
      },
    },
  ]) {
    assert.equal(pageModule.readRenderedArticleSelection(selection, container), '');
  }
});

test('rendered article selection snapshots stay path-bound until explicitly cleared', () => {
  assert.equal(typeof pageModule.createRenderedSelectionSnapshotStore, 'function');
  const store = pageModule.createRenderedSelectionSnapshotStore();
  assert.equal(store.read({ view: 'article', editing: false, path: 'notes/a.md' }), '');

  store.capture('notes/a.md', '阅读选区');
  assert.equal(store.read({ view: 'article', editing: false, path: 'notes/a.md' }), '阅读选区');
  assert.equal(store.read({ view: 'article', editing: false, path: 'notes/b.md' }), '');

  store.capture('notes/a.md', '   ');
  assert.equal(store.read({ view: 'article', editing: false, path: 'notes/a.md' }), '阅读选区');

  store.capture('notes/a.md', '新选区');
  assert.equal(store.read({ view: 'article', editing: false, path: 'notes/a.md' }), '新选区');
  assert.equal(store.read({ view: 'index', editing: false, path: 'notes/a.md' }), '');
  assert.equal(store.read({ view: 'article', editing: true, path: 'notes/a.md' }), '');

  store.clear();
  assert.equal(store.read({ view: 'article', editing: false, path: 'notes/a.md' }), '');
});

test('AI context derives frozen editor selection, rendered selection, note, and general snapshots', () => {
  const editorSelection = deriveAiContext({
    view: 'article',
    editing: true,
    draftKey: 'notes/a.md',
    path: 'notes/a.md',
    selectionStart: 2,
    selectionEnd: 5,
    editorText: '前文选区后文',
    noteText: '旧内容',
    renderedSelection: '阅读态选区',
  });
  const renderedSelection = deriveAiContext({
    view: 'article',
    editing: false,
    path: 'notes/a.md',
    noteText: '完整笔记',
    renderedSelection: '  阅读态选区  ',
  });
  const draft = deriveAiContext({
    view: 'article',
    editing: true,
    draftKey: 'notes/new.md',
    selectionStart: 2,
    selectionEnd: 2,
    editorText: '草稿内容',
  });
  const note = deriveAiContext({
    view: 'article',
    editing: false,
    path: 'notes/a.md',
    noteText: '笔记内容',
  });
  const general = deriveAiContext({
    view: 'index',
    editing: false,
    editorText: '',
    noteText: '',
  });

  assert.equal(editorSelection.mode, 'selection');
  assert.equal(editorSelection.content, '选区后');
  assert.equal(renderedSelection.mode, 'selection');
  assert.equal(renderedSelection.content, '阅读态选区');
  assert.equal(draft.mode, 'draft');
  assert.equal(draft.content, '草稿内容');
  assert.equal(note.mode, 'note');
  assert.equal(note.content, '笔记内容');
  assert.equal(general.mode, 'general');
  for (const context of [editorSelection, renderedSelection, draft, note, general]) {
    assert.equal(Object.isFrozen(context), true);
  }
});

test('AI context snapshots do not retain mutable input state', () => {
  const input = {
    view: 'article',
    editing: true,
    draftKey: 'notes/a.md',
    selectionStart: 0,
    selectionEnd: 2,
    editorText: '原文',
  };
  const context = deriveAiContext(input);
  input.editorText = '改文';
  input.draftKey = 'notes/b.md';

  assert.equal(context.content, '原文');
  assert.equal(context.draftKey, 'notes/a.md');
});

test('AI thread store creates deterministically, switches active, and sorts recent updates', () => {
  const times = [10, 20, 30];
  const ids = ['thread-a', 'thread-b'];
  const store = createAiThreadStore({
    now: () => times.shift(),
    createId: () => ids.shift(),
  });
  const context = deriveAiContext({ view: 'index' });
  const first = store.create(context);
  const second = store.create(context);

  assert.equal(first.id, 'thread-a');
  assert.equal(second.id, 'thread-b');
  assert.equal(store.getActive().id, 'thread-b');
  assert.deepEqual(store.list().map(({ id }) => id), ['thread-b', 'thread-a']);

  store.update('thread-a', (thread) => ({
    messages: [...thread.messages, { role: 'user', content: '  请总结这篇很长很长的笔记内容并列出行动项  ' }],
  }));
  assert.deepEqual(store.list().map(({ id }) => id), ['thread-a', 'thread-b']);
  assert.equal(store.get('thread-a').title, '请总结这篇很长很长的笔记内容并列出行动项'.slice(0, 28));

  store.setActive('thread-b');
  assert.equal(store.getActive().id, 'thread-b');
});

test('AI thread title uses the first non-empty user instruction and clips 28 Unicode code points', () => {
  const store = createAiThreadStore({ now: () => 1, createId: () => 'thread-a' });
  const instruction = `${'😀'.repeat(27)}甲乙`;
  store.create(deriveAiContext({ view: 'index' }));
  store.update('thread-a', () => ({
    messages: [
      { role: 'assistant', content: '不能作为标题' },
      { role: 'user', content: ' \n\t ' },
      { role: 'user', content: `  ${instruction}  ` },
      { role: 'user', content: '不能覆盖首条有效指令' },
    ],
  }));

  const title = store.get('thread-a').title;
  assert.equal(title, `${'😀'.repeat(27)}甲`);
  assert.equal(Array.from(title).length, 28);
  assert.ok(instruction.length > 28);
});

test('AI thread store isolates every returned snapshot and the updater draft', () => {
  const store = createAiThreadStore({ now: () => 1, createId: () => 'thread-a' });
  const mutableContext = { mode: 'general', nested: { value: 1 } };
  const created = store.create(mutableContext);
  mutableContext.nested.value = 2;
  created.messages.push({ role: 'user', content: 'from create' });
  assert.throws(() => { created.context.nested.value = 3; }, TypeError);
  assert.deepEqual(store.get('thread-a').messages, []);
  assert.equal(store.get('thread-a').context.nested.value, 1);

  const message = { role: 'user', content: 'hello', meta: { value: 1 } };
  let updaterDraft;
  const updated = store.update('thread-a', (draft) => {
    updaterDraft = draft;
    return { messages: [message] };
  });
  message.content = 'changed';
  message.meta.value = 2;
  updaterDraft.messages.push({ role: 'user', content: 'late updater mutation' });
  updated.messages[0].content = 'mutated update result';

  const read = store.get('thread-a');
  assert.equal(read.context.nested.value, 1);
  assert.equal(read.messages[0].content, 'hello');
  assert.equal(read.messages[0].meta.value, 1);
  read.messages[0].content = 'mutated read';

  const listed = store.list();
  listed[0].messages[0].meta.value = 4;
  listed.push({ id: 'fake' });

  const active = store.getActive();
  active.messages.push({ role: 'assistant', content: 'mutated active' });

  const final = store.get('thread-a');
  assert.equal(final.messages.length, 1);
  assert.equal(final.messages[0].content, 'hello');
  assert.equal(final.messages[0].meta.value, 1);
  assert.equal(store.list().length, 1);
  for (const snapshot of [created, updated, read, listed[0], active, final]) {
    assert.equal(Object.isFrozen(snapshot.context), true);
    assert.equal(Object.isFrozen(snapshot.context.nested), true);
  }
});

test('AI thread store has stable missing-ID behavior without changing active state', () => {
  const store = createAiThreadStore({ now: () => 1, createId: () => 'thread-a' });
  store.create(deriveAiContext({ view: 'index' }));
  let updaterCalled = false;

  assert.equal(store.get('missing'), undefined);
  assert.equal(store.update('missing', () => { updaterCalled = true; }), undefined);
  assert.equal(updaterCalled, false);
  assert.equal(store.setActive('missing'), false);
  assert.equal(store.remove('missing'), false);
  assert.equal(store.getActive().id, 'thread-a');
});

test('AI thread deletion falls back to the most recent thread and supports empty state', () => {
  let id = 0;
  let time = 0;
  const store = createAiThreadStore({
    now: () => ++time,
    createId: () => `thread-${++id}`,
  });
  store.create(deriveAiContext({ view: 'index' }));
  store.create(deriveAiContext({ view: 'index' }));
  store.create(deriveAiContext({ view: 'index' }));
  store.setActive('thread-2');

  assert.equal(store.remove('thread-2'), true);
  assert.equal(store.getActive().id, 'thread-3');
  assert.equal(store.remove('thread-3'), true);
  assert.equal(store.getActive().id, 'thread-1');
  assert.equal(store.remove('thread-1'), true);
  assert.equal(store.getActive(), null);
  assert.equal(store.remove('missing'), false);
});

test('AI context and thread state never access browser storage', () => {
  const previousLocal = globalThis.localStorage;
  const previousSession = globalThis.sessionStorage;
  const forbidden = new Proxy({}, {
    get() { throw new Error('browser storage accessed'); },
  });
  globalThis.localStorage = forbidden;
  globalThis.sessionStorage = forbidden;
  try {
    const store = createAiThreadStore({ now: () => 1, createId: () => 'thread-a' });
    store.create(deriveAiContext({ view: 'index' }));
    store.list();
    store.getActive();
  } finally {
    if (previousLocal === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocal;
    if (previousSession === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSession;
  }
});

test('selection snapshots are frozen and use JavaScript Unicode indexes', () => {
  const snapshot = captureSelection('A😀中文B', 1, 5, 'notes/a.md');

  assert.deepEqual(snapshot, {
    start: 1,
    end: 5,
    selectedText: '😀中文',
    draftKey: 'notes/a.md',
  });
  assert.equal(Object.isFrozen(snapshot), true);
});

test('selection capture rejects invalid ranges', () => {
  for (const [start, end] of [
    [-1, 0],
    [2, 1],
    [0, 4],
    [0.5, 1],
    [0, Number.NaN],
  ]) {
    assert.throws(
      () => captureSelection('abc', start, end, 'notes/a.md'),
      { name: 'RangeError', message: 'Invalid selection range' },
    );
  }
});

test('AI replacement changes only the captured selection and returns its range', () => {
  const snapshot = captureSelection('前文旧文本后文', 2, 5, 'notes/a.md');

  assert.deepEqual(
    applyAiResult(snapshot, '前文旧文本后文', '新文本', 'replace', 'notes/a.md'),
    { text: '前文新文本后文', start: 2, end: 5 },
  );
});

test('AI insertion retains the selection and returns the inserted range', () => {
  const snapshot = captureSelection('A😀B', 1, 3, 'notes/a.md');

  assert.deepEqual(
    applyAiResult(snapshot, 'A😀B', '中文', 'insert', 'notes/a.md'),
    { text: 'A😀中文B', start: 3, end: 5 },
  );
});

test('AI results require the same draft and exact selected text', () => {
  const snapshot = captureSelection('前文旧文本后文', 2, 5, 'notes/a.md');

  assert.equal(canApplyAiResult(snapshot, '前文旧文本后文', 'notes/a.md'), true);
  assert.equal(canApplyAiResult(snapshot, '别文旧文本尾文', 'notes/a.md'), true);
  assert.deepEqual(
    applyAiResult(snapshot, '别文旧文本尾文', '结果', 'replace', 'notes/a.md'),
    { text: '别文结果尾文', start: 2, end: 4 },
  );
  assert.equal(canApplyAiResult(snapshot, '新前文旧文本新后文', 'notes/a.md'), false);
  assert.equal(canApplyAiResult(snapshot, '前文已修改后文', 'notes/a.md'), false);
  assert.equal(canApplyAiResult(snapshot, '前文旧文本后文', 'notes/b.md'), false);
  for (const [text, draftKey] of [
    ['前文已修改后文', 'notes/a.md'],
    ['前文旧文本后文', 'notes/b.md'],
  ]) {
    assert.throws(
      () => applyAiResult(snapshot, text, '结果', 'replace', draftKey),
      { message: 'Stale AI selection' },
    );
  }
});

test('AI session stores isolate notes and store state only per instance', () => {
  const first = createAiSessionStore();
  const second = createAiSessionStore();
  const sessionA = { messages: ['a'] };
  const sessionB = { messages: ['b'] };

  assert.equal(first.get('notes/a.md'), undefined);
  assert.equal(first.set('notes/a.md', sessionA), first);
  assert.equal(first.set('notes/b.md', sessionB), first);
  assert.equal(first.get('notes/a.md'), sessionA);
  assert.equal(first.get('notes/b.md'), sessionB);
  assert.equal(second.get('notes/a.md'), undefined);
  assert.equal(first.delete('notes/a.md'), true);
  assert.equal(first.get('notes/a.md'), undefined);
  first.clear();
  assert.equal(first.get('notes/b.md'), undefined);
});

test('AI drawer state clamps its volatile width and returns immutable snapshots', () => {
  assert.equal(typeof pageModule.clampAiDrawerWidth, 'function');
  assert.equal(typeof pageModule.createAiDrawerState, 'function');
  assert.equal(pageModule.clampAiDrawerWidth(319), 320);
  assert.equal(pageModule.clampAiDrawerWidth(320), 320);
  assert.equal(pageModule.clampAiDrawerWidth(417), 417);
  assert.equal(pageModule.clampAiDrawerWidth(560), 560);
  assert.equal(pageModule.clampAiDrawerWidth(561), 560);
  assert.equal(pageModule.clampAiDrawerWidth(Number.NaN), 380);

  const drawer = pageModule.createAiDrawerState();
  assert.deepEqual(drawer.snapshot(), { open: false, width: 380 });
  assert.deepEqual(drawer.open(), { open: true, width: 380 });
  assert.deepEqual(drawer.resize(999), { open: true, width: 560 });
  const closed = drawer.close();
  assert.deepEqual(closed, { open: false, width: 560 });
  assert.equal(Object.isFrozen(closed), true);
  assert.throws(() => { closed.width = 320; }, TypeError);
  assert.deepEqual(drawer.snapshot(), { open: false, width: 560 });
  assert.notEqual(drawer.snapshot(), drawer.snapshot());
});

test('AI drawer accepts a clamped initial width without browser persistence', () => {
  const previousLocal = globalThis.localStorage;
  const previousSession = globalThis.sessionStorage;
  const forbidden = new Proxy({}, {
    get() { throw new Error('browser storage accessed'); },
  });
  globalThis.localStorage = forbidden;
  globalThis.sessionStorage = forbidden;
  try {
    const drawer = pageModule.createAiDrawerState({ initialWidth: 200 });
    assert.deepEqual(drawer.snapshot(), { open: false, width: 320 });
    drawer.resize(500);
    assert.deepEqual(drawer.snapshot(), { open: false, width: 500 });
  } finally {
    if (previousLocal === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocal;
    if (previousSession === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSession;
  }
});

function createFakeElement() {
  const listeners = new Map();
  const capturedPointers = new Set();
  const classes = new Set();
  const attributes = new Map();
  return {
    hidden: false,
    focusCount: 0,
    listeners,
    style: {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, value); },
    },
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
    addEventListener(name, listener) { listeners.set(name, listener); },
    setPointerCapture(pointerId) { capturedPointers.add(pointerId); },
    hasPointerCapture(pointerId) { return capturedPointers.has(pointerId); },
    releasePointerCapture(pointerId) { capturedPointers.delete(pointerId); },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    focus() { this.focusCount += 1; },
  };
}

function createDrawerTransitionHarness({
  viewportWidth = 1200,
  pageScrollY = 0,
  sidebarOpen = false,
  initialWidth,
} = {}) {
  const elements = {
    shell: createFakeElement(),
    main: createFakeElement(),
    panel: createFakeElement(),
    launcher: createFakeElement(),
    resizeHandle: createFakeElement(),
    prompt: createFakeElement(),
  };
  const scheduled = [];
  const scrollCalls = [];
  let scrollReads = 0;
  const state = pageModule.createAiDrawerState({ initialWidth });
  const controller = pageModule.createAiDrawerController({
    state,
    elements,
    getViewportWidth: () => viewportWidth,
    getSidebarOpen: () => sidebarOpen,
    getScrollY: () => { scrollReads += 1; return pageScrollY; },
    scrollTo: (...args) => scrollCalls.push(args),
    schedule: (callback) => scheduled.push(callback),
  });
  return {
    state,
    controller,
    elements,
    scheduled,
    scrollCalls,
    get scrollReads() { return scrollReads; },
    setSidebarOpen(value) { sidebarOpen = value; },
    setViewportWidth(value) { viewportWidth = value; },
    setPageScrollY(value) { pageScrollY = value; },
  };
}

test('page renders a wide push drawer shell and a dedicated narrow assistant view', () => {
  const ids = [
    'appShell', 'mainContent', 'aiLauncher', 'aiPanel', 'aiResize',
    'aiThreadMenu', 'aiNewChat', 'aiClose',
    'aiSuggestions', 'aiMessages', 'aiContextCard', 'aiPrompt', 'aiSend', 'aiStop',
  ];
  for (const html of [EN_HTML, ZH_HTML]) {
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(html, /id="aiPanel"[^>]*role="dialog"[^>]*aria-modal="false"/);
    assert.match(html, /id="aiResize"[^>]*role="separator"[^>]*aria-orientation="vertical"[^>]*aria-valuemin="320"[^>]*aria-valuemax="560"/);
    assert.doesNotMatch(html, /id="aiMessages"[^>]*aria-live=/);
    assert.match(html, /id="aiStatus"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="aiPrompt"[^>]*aria-label=/);
  }
  assert.doesNotMatch(PAGE_HTML, /class="editor-workspace"/);
  assert.match(PAGE_HTML, /--ai-drawer-width:\s*380px/);
  assert.match(PAGE_HTML, /\.app-shell\.ai-open\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--ai-drawer-width\)/);
  const drawerRule = PAGE_HTML.match(/\.ai-drawer\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(drawerRule, /width:\s*var\(--ai-drawer-width\)/);
  assert.match(drawerRule, /min-width:\s*320px/);
  assert.match(drawerRule, /max-width:\s*560px/);
  assert.doesNotMatch(drawerRule, /position:\s*(?:fixed|absolute)/);
  const launcherRule = PAGE_HTML.match(/\.ai-launcher\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(launcherRule, /right:\s*0/);
  assert.match(launcherRule, /top:\s*50%/);
  assert.doesNotMatch(launcherRule, /bottom:/);
  assert.match(PAGE_HTML, /\.app-shell\.ai-open\.ai-narrow\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(PAGE_HTML, /\.app-shell\.ai-open\.ai-narrow\s+\.app-main\s*\{[^}]*display:\s*none/);
  assert.match(PAGE_HTML, /\.app-shell\.ai-open\.ai-narrow\s+\.ai-drawer\s*\{[^}]*display:\s*flex[^}]*width:\s*100%/);
  assert.match(PAGE_HTML, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.app-shell,\s*\.ai-drawer\s*\{[^}]*transition:\s*none/);
  const desktopShellRule = PAGE_HTML.match(/html\.desktop \.app-shell\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(desktopShellRule, /min-height:\s*calc\(100vh - var\(--titlebar\) - 68px\)/);
  const desktopDrawerRule = PAGE_HTML.match(/html\.desktop \.ai-drawer\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(desktopDrawerRule, /height:\s*calc\(100vh - var\(--titlebar\) - 68px\)/);
  assert.match(desktopDrawerRule, /top:\s*calc\(var\(--titlebar\) \+ 68px\)/);
  const desktopNarrowDrawerRule = PAGE_HTML.match(/html\.desktop \.app-shell\.ai-open\.ai-narrow \.ai-drawer\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(desktopNarrowDrawerRule, /height:\s*calc\(100vh - var\(--titlebar\) - 68px\)/);
  assert.match(PAGE_HTML, /const aiDrawerController = createAiDrawerController\(\{/);
  assert.match(PAGE_HTML, /getScrollY:\s*\(\) => Number\.isFinite\(window\.scrollY\) \? window\.scrollY : window\.pageYOffset/);
  assert.match(PAGE_HTML, /scrollTo:\s*\(x, y\) => window\.scrollTo\(x, y\)/);
  assert.match(PAGE_HTML, /getSidebarOpen:\s*\(\) => document\.body\.classList\.contains\('sidebar-open'\)/);
  assert.match(PAGE_HTML, /schedule:\s*\(callback\) => window\.requestAnimationFrame\(callback\)/);
  assert.match(PAGE_HTML, /const aiDrawerResizeController = createAiDrawerResizeController\(\{/);
  assert.match(PAGE_HTML, /aiDrawerResizeController\.bind\(\)/);
  assert.match(PAGE_HTML, /window\.addEventListener\('resize', renderAiDrawerState\)/);
  assert.match(PAGE_HTML, /function applySidebar\(open\)[\s\S]*?renderAiDrawerState\(\)/);
  assert.match(PAGE_HTML, /(?:button|textarea):focus-visible/);
});

test('drawer presentation resolves wide push and narrow dedicated modes', () => {
  assert.deepEqual(pageModule.resolveAiDrawerPresentation(1200, false, false, 380), {
    open: false, narrow: false, mainHidden: false, drawerHidden: true,
  });
  assert.deepEqual(pageModule.resolveAiDrawerPresentation(1200, true, false, 380), {
    open: true, narrow: false, mainHidden: false, drawerHidden: false,
  });
  assert.deepEqual(pageModule.resolveAiDrawerPresentation(759, true, false, 380), {
    open: true, narrow: true, mainHidden: true, drawerHidden: false,
  });
  assert.deepEqual(pageModule.resolveAiDrawerPresentation(761, true, true, 380), {
    open: true, narrow: true, mainHidden: true, drawerHidden: false,
  });
  assert.deepEqual(pageModule.resolveAiDrawerPresentation(939, true, false, 560), {
    open: true, narrow: true, mainHidden: true, drawerHidden: false,
  });
  assert.deepEqual(pageModule.resolveAiDrawerPresentation(940, true, false, 560), {
    open: true, narrow: false, mainHidden: false, drawerHidden: false,
  });
  assert.deepEqual(pageModule.resolveAiDrawerPresentation(400, false, false, 380), {
    open: false, narrow: true, mainHidden: false, drawerHidden: true,
  });
});

test('drawer controller re-renders against live sidebar state and current drawer width', () => {
  const harness = createDrawerTransitionHarness({ viewportWidth: 900, pageScrollY: 287 });
  harness.controller.open();
  assert.equal(harness.elements.main.hidden, false);

  harness.setSidebarOpen(true);
  harness.controller.render();
  assert.equal(harness.elements.main.hidden, true);
  assert.equal(harness.scrollReads, 1);

  harness.setSidebarOpen(false);
  harness.controller.render();
  assert.equal(harness.elements.main.hidden, false);
  assert.equal(harness.scheduled.length, 1);
  harness.scheduled[0]();
  assert.deepEqual(harness.scrollCalls, [[0, 287]]);

  harness.state.resize(560);
  harness.controller.render();
  assert.equal(harness.elements.main.hidden, true);
  assert.equal(harness.scrollReads, 2);

  harness.state.resize(320);
  harness.controller.render();
  assert.equal(harness.elements.main.hidden, false);
  assert.equal(harness.scheduled.length, 2);
  harness.scheduled[1]();
  assert.deepEqual(harness.scrollCalls, [[0, 287], [0, 287]]);
});

test('drawer resize controller captures, moves left to grow, and releases pointers', () => {
  const state = pageModule.createAiDrawerState();
  const handle = createFakeElement();
  let renders = 0;
  const controller = pageModule.createAiDrawerResizeController({
    state,
    handle,
    render: () => { renders += 1; },
  });
  controller.bind();
  let prevented = 0;
  handle.listeners.get('pointerdown')({
    button: 0, clientX: 500, pointerId: 7, preventDefault: () => { prevented += 1; },
  });
  assert.equal(handle.hasPointerCapture(7), true);
  handle.listeners.get('pointermove')({ clientX: 450, pointerId: 7 });
  assert.equal(state.snapshot().width, 430);
  handle.listeners.get('pointermove')({ clientX: 550, pointerId: 7 });
  assert.equal(state.snapshot().width, 330);
  assert.equal(renders, 2);
  handle.listeners.get('pointerup')({ pointerId: 7 });
  assert.equal(handle.hasPointerCapture(7), false);
  handle.listeners.get('keydown')({
    key: 'ArrowLeft', preventDefault: () => { prevented += 1; },
  });
  assert.equal(state.snapshot().width, 346);
  assert.equal(prevented, 2);
});

test('drawer controller preserves article identity and scroll while managing focus', () => {
  const elements = {
    shell: createFakeElement(),
    main: createFakeElement(),
    panel: createFakeElement(),
    launcher: createFakeElement(),
    resizeHandle: createFakeElement(),
    prompt: createFakeElement(),
  };
  const article = { id: 'article-node' };
  elements.main.article = article;
  elements.main.scrollTop = 173;
  let scrollReads = 0;
  const scrollCalls = [];
  const controller = pageModule.createAiDrawerController({
    state: pageModule.createAiDrawerState(),
    elements,
    getViewportWidth: () => 1200,
    getScrollY: () => { scrollReads += 1; return 900; },
    scrollTo: (...args) => scrollCalls.push(args),
    schedule: (callback) => callback(),
  });

  controller.open();
  assert.equal(elements.main.article, article);
  assert.equal(elements.main.scrollTop, 173);
  assert.equal(elements.main.hidden, false);
  assert.equal(elements.prompt.focusCount, 1);
  controller.close();
  assert.equal(elements.launcher.focusCount, 1);
  assert.equal(scrollReads, 0);
  assert.deepEqual(scrollCalls, []);
});

test('narrow drawer restores captured page scroll after main content returns', () => {
  const elements = {
    shell: createFakeElement(),
    main: createFakeElement(),
    panel: createFakeElement(),
    launcher: createFakeElement(),
    resizeHandle: createFakeElement(),
    prompt: createFakeElement(),
  };
  let pageScrollY = 684;
  const scheduled = [];
  const scrollCalls = [];
  const controller = pageModule.createAiDrawerController({
    state: pageModule.createAiDrawerState(),
    elements,
    getViewportWidth: () => 759,
    getScrollY: () => pageScrollY,
    scrollTo: (...args) => scrollCalls.push(args),
    schedule: (callback) => scheduled.push(callback),
  });

  controller.open();
  assert.equal(elements.main.hidden, true);
  pageScrollY = 0; // Simulate the document becoming shorter while main is hidden.
  controller.close();
  assert.equal(elements.main.hidden, false);
  assert.deepEqual(scrollCalls, []);
  assert.equal(scheduled.length, 1);
  controller.render();
  controller.render();
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.deepEqual(scrollCalls, [[0, 684]]);
});

test('open wide to narrow to wide captures once and restores before later close', () => {
  const harness = createDrawerTransitionHarness({ viewportWidth: 1200, pageScrollY: 512 });
  harness.controller.open();
  assert.equal(harness.scrollReads, 0);
  let mainHidden = harness.elements.main.hidden;
  let scrollReadsWhenHidden = null;
  Object.defineProperty(harness.elements.main, 'hidden', {
    configurable: true,
    get: () => mainHidden,
    set(value) {
      mainHidden = value;
      if (value) scrollReadsWhenHidden = harness.scrollReads;
    },
  });

  harness.setViewportWidth(759);
  harness.controller.render();
  assert.equal(harness.elements.main.hidden, true);
  assert.equal(harness.scrollReads, 1);
  assert.equal(scrollReadsWhenHidden, 1);

  harness.setPageScrollY(0);
  harness.setViewportWidth(1200);
  harness.controller.render();
  assert.equal(harness.elements.main.hidden, false);
  assert.equal(harness.scheduled.length, 1);
  harness.controller.close();
  assert.equal(harness.scheduled.length, 2);
  harness.scheduled[0]();
  assert.deepEqual(harness.scrollCalls, []);
  harness.scheduled[1]();
  assert.deepEqual(harness.scrollCalls, [[0, 512]]);
});

test('open wide to narrow then close restores the resize-captured scroll', () => {
  const harness = createDrawerTransitionHarness({ viewportWidth: 1200, pageScrollY: 431 });
  harness.controller.open();
  harness.setViewportWidth(759);
  harness.controller.render();
  harness.setPageScrollY(0);
  harness.controller.close();

  assert.equal(harness.scrollReads, 1);
  assert.equal(harness.elements.main.hidden, false);
  assert.equal(harness.scheduled.length, 1);
  harness.scheduled[0]();
  assert.deepEqual(harness.scrollCalls, [[0, 431]]);
});

test('repeated resize renders do not duplicate scroll capture or restoration', () => {
  const harness = createDrawerTransitionHarness({ viewportWidth: 1200, pageScrollY: 275 });
  harness.controller.open();
  harness.setViewportWidth(759);
  harness.controller.render();
  harness.controller.render();
  assert.equal(harness.scrollReads, 1);

  harness.setViewportWidth(1200);
  harness.controller.render();
  harness.controller.render();
  assert.equal(harness.scheduled.length, 1);
  harness.scheduled[0]();
  assert.deepEqual(harness.scrollCalls, [[0, 275]]);
});

test('pending restore preserves original scroll across another narrow-wide cycle', () => {
  const harness = createDrawerTransitionHarness({ viewportWidth: 759, pageScrollY: 390 });
  harness.controller.open();
  harness.setPageScrollY(0);
  harness.setViewportWidth(1200);
  harness.controller.render();
  harness.setViewportWidth(759);
  harness.controller.render();
  assert.equal(harness.scrollReads, 1);
  assert.equal(harness.elements.main.hidden, true);
  harness.scheduled[0]();
  assert.deepEqual(harness.scrollCalls, []);
  harness.setViewportWidth(1200);
  harness.controller.render();

  assert.equal(harness.scrollReads, 1);
  assert.equal(harness.scheduled.length, 2);
  harness.scheduled[0]();
  assert.deepEqual(harness.scrollCalls, []);
  harness.scheduled[1]();
  assert.deepEqual(harness.scrollCalls, [[0, 390]]);
});

test('newest restore callback succeeds before stale callback without duplicate scrolling', () => {
  const harness = createDrawerTransitionHarness({ viewportWidth: 759, pageScrollY: 246 });
  harness.controller.open();
  harness.setPageScrollY(0);
  harness.setViewportWidth(1200);
  harness.controller.render();
  harness.setViewportWidth(759);
  harness.controller.render();
  harness.setViewportWidth(1200);
  harness.controller.render();

  assert.equal(harness.scheduled.length, 2);
  harness.scheduled[1]();
  assert.deepEqual(harness.scrollCalls, [[0, 246]]);
  harness.scheduled[0]();
  assert.deepEqual(harness.scrollCalls, [[0, 246]]);
});

test('closing an already closed drawer never focuses launcher or aborts again', () => {
  const elements = {
    shell: createFakeElement(),
    main: createFakeElement(),
    panel: createFakeElement(),
    launcher: createFakeElement(),
    resizeHandle: createFakeElement(),
    prompt: createFakeElement(),
  };
  let aborts = 0;
  const controller = pageModule.createAiDrawerController({
    state: pageModule.createAiDrawerState(),
    elements,
    getViewportWidth: () => 1200,
    abortRequest: () => { aborts += 1; },
  });

  controller.close(); // Mirrors initial/unconfigured status refresh.
  assert.equal(elements.launcher.focusCount, 0);
  assert.equal(aborts, 0);
  controller.open();
  controller.close();
  controller.close();
  assert.equal(elements.launcher.focusCount, 1);
  assert.equal(aborts, 1);
});

test('closing a generating drawer aborts and leaves its message stopped', async () => {
  const elements = {
    shell: createFakeElement(),
    main: createFakeElement(),
    panel: createFakeElement(),
    launcher: createFakeElement(),
    resizeHandle: createFakeElement(),
    prompt: createFakeElement(),
  };
  const message = { status: 'streaming' };
  const request = {
    threadId: 'thread-a',
    messageId: 'message-a',
    controller: { abort() { this.aborted = true; } },
  };
  const abortRequest = () => pageModule.stopAiRequest(request, {
    updateMessage: (_threadId, _messageId, changes) => Object.assign(message, changes),
  });
  const controller = pageModule.createAiDrawerController({
    state: pageModule.createAiDrawerState(),
    elements,
    getViewportWidth: () => 1200,
    abortRequest,
  });

  controller.open();
  controller.close();
  await Promise.resolve();
  assert.equal(request.controller.aborted, true);
  message.status = pageModule.aiRequestErrorStatus({ name: 'AbortError' });
  assert.equal(message.status, 'stopped');
});

test('AI message actions require a complete unapplied assistant answer', () => {
  const base = { role: 'assistant', content: 'answer', status: 'done' };
  assert.equal(isAiMessageActionable(base), true);
  for (const message of [
    { ...base, status: 'streaming' },
    { ...base, status: 'error' },
    { ...base, status: 'stopped' },
    { ...base, applied: true },
    { ...base, content: '' },
    { ...base, role: 'user' },
  ]) {
    assert.equal(isAiMessageActionable(message), false);
  }
});

test('AI error presentation covers every public code and an unknown fallback', () => {
  assert.equal(typeof pageModule.aiErrorPresentation, 'function');
  const cases = {
    RATE_LIMITED: ['ai.error.rateLimited', true, false],
    AUTH_FAILED: ['ai.error.authentication', false, true],
    MODEL_NOT_FOUND: ['ai.error.modelNotFound', false, true],
    REQUEST_INVALID: ['ai.error.invalidRequest', false, false],
    UPSTREAM_TIMEOUT: ['ai.error.timeout', true, false],
    NETWORK_ERROR: ['ai.error.network', true, false],
    STREAM_INTERRUPTED: ['ai.error.interrupted', true, false],
    AI_FAILED: ['ai.error.fallback', false, false],
    FUTURE_ERROR: ['ai.error.fallback', false, false],
  };
  for (const [code, [messageKey, canRetry, canOpenSettings]] of Object.entries(cases)) {
    assert.deepEqual(pageModule.aiErrorPresentation({ code }), {
      messageKey,
      canRetry,
      canOpenSettings,
    });
  }
});

test('AI rate-limit retry state counts down and only enables manual retry at zero', () => {
  assert.equal(typeof pageModule.createAiRetryState, 'function');
  let now = 1_000;
  let scheduled;
  const cleared = [];
  const changes = [];
  const state = pageModule.createAiRetryState({
    now: () => now,
    setTimer: (callback, delay) => {
      scheduled = { callback, delay, id: Symbol('timer') };
      return scheduled.id;
    },
    clearTimer: (id) => cleared.push(id),
  });

  assert.deepEqual(
    state.start('message-a', { code: 'RATE_LIMITED', retryAfterSeconds: 2 }, (value) => {
      changes.push(value);
    }),
    { key: 'message-a', remainingSeconds: 2, canRetry: false },
  );
  assert.equal(scheduled.delay, 1_000);
  now = 2_000;
  scheduled.callback();
  assert.deepEqual(changes.at(-1), {
    key: 'message-a', remainingSeconds: 1, canRetry: false,
  });
  now = 3_000;
  scheduled.callback();
  assert.deepEqual(changes.at(-1), {
    key: 'message-a', remainingSeconds: 0, canRetry: true,
  });
  assert.equal(state.snapshot().canRetry, true);
});

test('AI retry state clears stale timers on replacement, clear, and completion', () => {
  let now = 0;
  let id = 0;
  const timers = new Map();
  const cleared = [];
  const changes = [];
  const state = pageModule.createAiRetryState({
    now: () => now,
    setTimer: (callback) => {
      const timerId = ++id;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimer: (timerId) => {
      cleared.push(timerId);
      timers.delete(timerId);
    },
  });
  state.start('old', { code: 'RATE_LIMITED', retryAfterSeconds: 4 }, (value) => {
    changes.push(['old', value]);
  });
  const staleCallback = timers.get(1);
  state.start('new', { code: 'RATE_LIMITED', retryAfterSeconds: 2 }, (value) => {
    changes.push(['new', value]);
  });
  assert.deepEqual(cleared, [1]);
  staleCallback();
  assert.equal(changes.length, 0);
  assert.equal(state.snapshot().key, 'new');

  state.clear();
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(state.snapshot(), null);
  now = 10_000;
  const newStaleCallback = timers.get(2);
  if (newStaleCallback) newStaleCallback();
  assert.equal(changes.length, 0);
});

test('failed partial AI responses expose error actions but never content actions', () => {
  const failed = {
    role: 'assistant',
    content: 'partial private output',
    status: 'error',
    error: { code: 'NETWORK_ERROR', requestId: '12345678-rest' },
  };
  assert.equal(isAiMessageActionable(failed), false);
  assert.match(PAGE_HTML, /aiErrorPresentation\(message\.error\)/);
  assert.match(PAGE_HTML, /presentation\.canRetry/);
  assert.match(PAGE_HTML, /presentation\.canOpenSettings/);
  assert.match(PAGE_HTML, /shortAiRequestId\(message\.error\.requestId\)/);
  assert.doesNotMatch(PAGE_HTML, /message\.status === 'error'[\s\S]{0,500}navigator\.clipboard/);
});

test('AI retry reuses only the original instruction through the ordinary send path', () => {
  assert.equal(typeof pageModule.aiRetryInstruction, 'function');
  const messages = [
    { id: 'user-a', role: 'user', content: '原始指令', contextMode: 'selection' },
    {
      id: 'assistant-a',
      role: 'assistant',
      content: '部分内容',
      status: 'error',
      error: { code: 'NETWORK_ERROR' },
      snapshot: { selectedText: '旧选区' },
    },
  ];
  assert.equal(pageModule.aiRetryInstruction(messages, 'assistant-a'), '原始指令');
  assert.equal(pageModule.aiRetryInstruction(messages, 'missing'), '');
  assert.match(
    PAGE_HTML,
    /function retryAiMessage\(message\)[\s\S]*?aiErrorActionHandlers\.retry\(message\)/,
  );
  const retryBody = PAGE_HTML.slice(
    PAGE_HTML.indexOf('function retryAiMessage(message)'),
    PAGE_HTML.indexOf('function applyAiMessage(message, mode)'),
  );
  assert.doesNotMatch(retryBody, /message\.snapshot|buildAiChatPayload|fetch\(/);
  assert.match(
    PAGE_HTML,
    /createAiErrorActionHandlers\(\{[\s\S]*?sendInstruction:\s*\(instruction\) => sendAiRequest\(instruction\)/,
  );
  assert.match(
    PAGE_HTML,
    /async function sendAiRequest\(instruction\)[\s\S]*?const requestUi = refreshAiContextUi\(\)/,
  );
});

test('historical AI errors expose no actions and stale handlers cannot send or open settings', () => {
  assert.equal(typeof pageModule.aiErrorActionsForMessage, 'function');
  assert.equal(typeof pageModule.createAiErrorActionHandlers, 'function');
  const instruction = {
    id: 'user-old', role: 'user', content: '原始指令', contextMode: 'general',
  };
  const oldRateLimit = {
    id: 'assistant-old',
    role: 'assistant',
    status: 'error',
    error: { code: 'RATE_LIMITED', retryAfterSeconds: 5 },
  };
  let messages = [instruction, oldRateLimit];
  let sends = 0;
  let settingsOpens = 0;
  const retryState = pageModule.createAiRetryState();
  const handlers = pageModule.createAiErrorActionHandlers({
    getMessages: () => messages,
    retryState,
    sendInstruction: () => { sends += 1; },
    openSettings: () => { settingsOpens += 1; },
  });
  const oldRetryClick = () => handlers.retry(oldRateLimit);

  messages = [...messages, {
    id: 'assistant-new', role: 'assistant', status: 'done', content: 'new answer',
  }];
  assert.deepEqual(
    pageModule.aiErrorActionsForMessage(messages, oldRateLimit),
    { canRetry: false, canOpenSettings: false },
  );
  assert.equal(oldRetryClick(), false);
  assert.equal(sends, 0);

  const oldAuthentication = {
    id: 'assistant-auth',
    role: 'assistant',
    status: 'error',
    error: { code: 'AUTH_FAILED' },
  };
  messages = [instruction, oldAuthentication];
  const oldSettingsClick = () => handlers.openSettings(oldAuthentication);
  messages = [...messages, {
    id: 'assistant-new-error',
    role: 'assistant',
    status: 'error',
    error: { code: 'NETWORK_ERROR' },
  }];
  assert.equal(oldSettingsClick(), false);
  assert.equal(settingsOpens, 0);
});

test('latest rate-limit error waits, never auto-sends, then permits manual retry', () => {
  let now = 1_000;
  let timerCallback;
  let sends = 0;
  const instruction = { id: 'user-a', role: 'user', content: '重试我' };
  const rateLimit = {
    id: 'assistant-a',
    role: 'assistant',
    status: 'error',
    error: { code: 'RATE_LIMITED', retryAfterSeconds: 2 },
  };
  const messages = [instruction, rateLimit];
  const retryState = pageModule.createAiRetryState({
    now: () => now,
    setTimer: (callback) => {
      timerCallback = callback;
      return 1;
    },
    clearTimer: () => {},
  });
  retryState.start(rateLimit.id, rateLimit.error);
  const handlers = pageModule.createAiErrorActionHandlers({
    getMessages: () => messages,
    retryState,
    sendInstruction: (value) => {
      sends += 1;
      assert.equal(value, '重试我');
    },
  });

  assert.deepEqual(pageModule.aiErrorActionsForMessage(messages, rateLimit), {
    canRetry: true,
    canOpenSettings: false,
  });
  assert.equal(handlers.retry(rateLimit), false);
  assert.equal(sends, 0);
  now = 3_000;
  timerCallback();
  assert.equal(sends, 0);
  assert.equal(handlers.retry(rateLimit), true);
  assert.equal(sends, 1);
});

test('structured SSE errors retain only public fields and UI lifecycle clears retry timers', () => {
  assert.deepEqual(pageModule.publicAiError({
    code: 'RATE_LIMITED',
    retryAfterSeconds: 3,
    requestId: 'request-123',
    providerBody: 'secret',
    status: 429,
  }), {
    code: 'RATE_LIMITED',
    retryAfterSeconds: 3,
    requestId: 'request-123',
  });
  assert.match(
    PAGE_HTML,
    /event === 'error'[\s\S]*?publicAiError\([\s\S]*?payload\.code[\s\S]*?payload\.retryAfterSeconds[\s\S]*?payload\.requestId/,
  );
  assert.match(PAGE_HTML, /error:\s*publicAiError\(/);
  for (const pattern of [
    /function switchAiThread\([\s\S]*?aiRetryState\.clear\(\)/,
    /function closeAiPanel\([\s\S]*?aiRetryState\.clear\(\)/,
    /remove\.onclick[\s\S]*?aiRetryState\.clear\(\)/,
    /status:\s*'done'[\s\S]*?aiRetryState\.clear\(\)/,
  ]) {
    assert.match(PAGE_HTML, pattern);
  }
});

test('rendered inline scripts remain valid JavaScript', () => {
  const scripts = [...PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, source] of scripts) {
    assert.doesNotThrow(() => new Function(source));
  }
});

test('rendered main script injects runnable AI helpers and dependencies before initialization', () => {
  const scripts = [...PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const source = scripts.at(-1)?.[1] || '';
  const helperNames = [
    'copyAiState', 'freezeAiState', 'deriveAiContext', 'freezeAiRequestContext', 'createAiThreadStore',
  ];
  const initialization = source.indexOf('const aiThreads = createAiThreadStore()');
  assert.ok(initialization > 0);
  for (const name of helperNames) {
    const definition = source.indexOf(`function ${name}`);
    assert.ok(definition >= 0, `${name} definition missing`);
    assert.ok(definition < initialization, `${name} injected after aiThreads initialization`);
  }

  const helperStart = source.indexOf('function copyAiState');
  const helperEnd = source.indexOf("const TAB_ALL = '__all__'");
  const injectedHelpers = source.slice(helperStart, helperEnd);
  const initialize = new Function(
    `${injectedHelpers}
    const store = createAiThreadStore({ now: () => 1, createId: () => 'runtime-thread' });
    const context = deriveAiContext({ view: 'index' });
    return store.create(context);`,
  );
  assert.deepEqual(initialize(), {
    id: 'runtime-thread',
    title: '',
    context: {
      mode: 'general',
      view: 'index',
      editing: false,
      draftKey: null,
      path: null,
      selectionStart: null,
      selectionEnd: null,
      content: '',
    },
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  });
});

test('rendered script runs the unified AI action guard used by enabled buttons', () => {
  const source = [...PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1] || '';
  const start = source.indexOf('function canApplyUnifiedAiResult');
  const end = source.indexOf('function applyAiResult', start);
  assert.ok(start >= 0, 'unified action guard must be injected');
  assert.ok(end > start, 'unified action guard must precede subsequent helpers');

  const guard = new Function(`${source.slice(start, end)}; return canApplyUnifiedAiResult;`)();
  const snapshot = {
    path: 'notes/a.md', docRevision: 1, from: 2, to: 4, selectedMarkdown: 'old',
  };
  assert.equal(guard({ getSelectionSnapshot: () => ({ ...snapshot }) }, snapshot), true);
  assert.match(
    source,
    /const currentSelection =[\s\S]*?\? canApplyUnifiedAiResult\(editorHost, message\.snapshot\)/,
  );
});

test('AI assistant re-derives context at send time and renders mode-specific suggestions', () => {
  assert.match(PAGE_HTML, /function captureAiContext\(\)[\s\S]*?deriveAiContext\(\{/);
  assert.match(PAGE_HTML, /function refreshAiContextUi\(\)/);
  assert.match(PAGE_HTML, /async function sendAiRequest\(instruction\)[\s\S]*?const requestUi = refreshAiContextUi\(\)/);
  assert.match(
    PAGE_HTML,
    /buildAiChatPayload\(\s*requestContext,\s*history,\s*requestUi\.includeNote,?\s*\)/,
  );
  assert.doesNotMatch(
    PAGE_HTML,
    /async function sendAiRequest\(instruction\)[\s\S]*?const requestContext = captureAiContext\(\)/,
  );
  assert.match(PAGE_HTML, /requestContext\.mode === 'selection'/);
  assert.match(PAGE_HTML, /requestContext\.mode !== 'general'/);
  assert.match(PAGE_HTML, /function renderAiSuggestions\(/);
  assert.match(PAGE_HTML, /ai\.suggest\.summary/);
  assert.match(PAGE_HTML, /ai\.suggest\.neutral/);
  assert.match(PAGE_HTML, /data-ai-instruction/);
});

test('AI selection full-note control is localized, hidden by mode, and refreshes from editor events', () => {
  for (const html of [EN_HTML, ZH_HTML]) {
    assert.match(html, /id="aiIncludeNoteOption"[^>]*hidden/);
    assert.match(html, /id="aiIncludeNote"[^>]*type="checkbox"/);
  }
  assert.match(PAGE_HTML, /includeOption\.hidden = !uiState\.showIncludeNote/);
  assert.match(PAGE_HTML, /includeNote\.checked = uiState\.includeNote/);
  assert.match(PAGE_HTML, /let aiIncludeNoteGrant = null/);
  assert.match(
    PAGE_HTML,
    /function refreshAiContextUi\(\)[\s\S]*?const context = captureAiContext\(\)[\s\S]*?updateAiIncludeNoteGrant\(/,
  );
  assert.match(
    PAGE_HTML,
    /function refreshOpenAiWorkspace\(\)[\s\S]*?refreshAiContextUi\(\)[\s\S]*?aiPanel/,
  );
  assert.match(
    PAGE_HTML,
    /AI_CONTEXT_REFRESH_EVENTS\.forEach\(\(eventName\) =>[\s\S]*?addEventListener\(eventName,\s*refreshAiContextUi\)/,
  );
});

test('AI context card shows the unified editor selection and refreshes after ProseMirror updates it', () => {
  assert.deepEqual(pageModule.createAiContextCardModel({
    mode: 'selection',
    modeKey: 'ai.context.selection',
    context: {
      label: '当前文档',
      content: '用户实际选中的内容',
    },
  }, (key) => key === 'ai.context.selection' ? '选区' : key), {
    heading: '选区 · 当前文档',
    selection: '用户实际选中的内容',
  });
  assert.deepEqual(pageModule.createAiContextCardModel({
    mode: 'document',
    modeKey: 'ai.context.document',
    context: { label: '当前文档', content: '整篇正文' },
  }, (key) => key), {
    heading: 'ai.context.document · 当前文档',
    selection: '',
  });
  assert.match(
    PAGE_HTML,
    /onSelectionChange:\s*\(\)\s*=>[\s\S]*?refreshOpenAiWorkspace\(\)/,
  );
});

test('README files document selection-only defaults and volatile full-note consent', () => {
  assert.match(
    README_EN,
    /Selection[\s\S]*?by default[\s\S]*?only the selection[\s\S]*?Include full note[\s\S]*?complete draft/i,
  );
  assert.match(README_EN, /permission[\s\S]*?reset[\s\S]*?leav(?:e|ing)[\s\S]*?selection context/i);
  assert.match(
    README_ZH,
    /选区（Selection）[\s\S]*?默认[\s\S]*?只发送选区[\s\S]*?附带全文[\s\S]*?完整草稿/,
  );
  assert.match(README_ZH, /授权[\s\S]*?离开选区上下文[\s\S]*?重置/);
});

test('README files describe the AI assistant without floating-title wording', () => {
  assert.match(README_EN, /^### Use the AI assistant$/m);
  assert.doesNotMatch(README_EN, /^### Use the floating AI assistant$/m);
  assert.match(README_EN, /floating button centered on the right edge/i);
  assert.match(README_ZH, /^### 使用 AI 助手$/m);
  assert.doesNotMatch(README_ZH, /^### 使用悬浮 AI 助手$/m);
  assert.match(README_ZH, /右侧边缘垂直居中/);
});

test('AI message list auto-follow helper respects the 48px bottom threshold', () => {
  assert.equal(typeof pageModule.shouldAutoFollowAiMessages, 'function');
  assert.equal(pageModule.shouldAutoFollowAiMessages({
    scrollTop: 352,
    clientHeight: 600,
    scrollHeight: 1000,
  }), true);
  assert.equal(pageModule.shouldAutoFollowAiMessages({
    scrollTop: 351,
    clientHeight: 600,
    scrollHeight: 1000,
  }), false);
  assert.equal(pageModule.shouldAutoFollowAiMessages({
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
  }), true);
  assert.match(PAGE_HTML, /function renderAiMessages\(\)[\s\S]*?const autoFollow = shouldAutoFollowAiMessages\(list\)/);
  assert.match(PAGE_HTML, /if \(autoFollow\) list\.scrollTop = list\.scrollHeight;/);
});

test('AI streaming uses one abortable fetch request and preserves partial failures', () => {
  assert.match(PAGE_HTML, /fetch\('\/api\/ai\/edit\/chat',\s*\{/);
  assert.match(PAGE_HTML, /method:\s*'POST'/);
  assert.match(PAGE_HTML, /response\.body\.getReader\(\)/);
  assert.match(PAGE_HTML, /new TextDecoder\(\)/);
  assert.match(PAGE_HTML, /event === 'delta'/);
  assert.match(PAGE_HTML, /activeAiRequest/);
  assert.match(PAGE_HTML, /new AbortController\(\)/);
  assert.match(PAGE_HTML, /\$\('aiStop'\)\.onclick = abortAiRequest/);
  assert.match(PAGE_HTML, /request\.controller\.abort\(\)/);
  assert.match(PAGE_HTML, /content:\s*\(message\?\.content \|\| ''\) \+ payload\.text/);
  assert.match(PAGE_HTML, /const status = aiRequestErrorStatus\(error\)/);
});

test('AI capability uses its own status flag and provides a localized configuration hint', () => {
  assert.match(PAGE_HTML, /let aiEditEnabled = false/);
  assert.match(PAGE_HTML, /api\('\/api\/ai\/edit\/status'\)/);
  assert.match(PAGE_HTML, /aiEditEnabled = !!\(a && a\.enabled\)/);
  assert.match(PAGE_HTML, /id="aiLauncher"[^>]*aria-disabled="true"/);
  assert.doesNotMatch(PAGE_HTML, /id="aiLauncher"[^>]*\sdisabled(?:\s|>)/);
  assert.match(PAGE_HTML, /\.ai-launcher\[aria-disabled="true"\]/);
  assert.match(PAGE_HTML, /function openAiPanel\(\)\s*\{\s*if \(!aiEditEnabled\) \{\s*toast\(tr\('ai\.notConfigured'\)\);\s*return;/);
  assert.match(PAGE_HTML, /if \(aiEditEnabled\) \$\('aiLauncher'\)\.removeAttribute\('aria-disabled'\)/);
  assert.match(PAGE_HTML, /else \$\('aiLauncher'\)\.setAttribute\('aria-disabled', 'true'\)/);
  assert.doesNotMatch(PAGE_HTML, /\$\('aiLauncher'\)\.disabled\s*=/);
  assert.match(EN_HTML, /Configure LLM settings to enable the AI assistant\./);
  assert.match(ZH_HTML, /请先配置大模型，再使用 AI 助手。/);
});

test('AI threads are temporary, switchable, deletable, and abort stale requests', () => {
  assert.match(PAGE_HTML, /const aiThreads = createAiThreadStore\(\)/);
  assert.match(PAGE_HTML, /function createAiThread\(/);
  assert.match(PAGE_HTML, /function renderAiThreadMenu\(/);
  assert.match(PAGE_HTML, /aiThreads\.setActive\(/);
  assert.match(PAGE_HTML, /aiThreads\.remove\(/);
  assert.match(PAGE_HTML, /\$\('aiNewChat'\)\.onclick/);
  assert.match(PAGE_HTML, /function abortAiRequest\(/);
  assert.match(PAGE_HTML, /function switchAiThread\([\s\S]*?abortAiRequest\(/);
  assert.match(PAGE_HTML, /abortRequest:\s*abortAiRequest/);
});

test('leaving the visible editor for Ask cancels AI work', () => {
  assert.equal(typeof pageModule.isAiEditingState, 'function');
  assert.equal(typeof pageModule.shouldAbortAiRequestForContext, 'function');
  assert.equal(pageModule.isAiEditingState({
    articleDisplay: '',
    editorDisplay: '',
  }), true);
  assert.equal(pageModule.isAiEditingState({
    articleDisplay: 'none',
    editorDisplay: '',
  }), false);
  assert.equal(pageModule.isAiEditingState({
    articleDisplay: '',
    editorDisplay: 'none',
  }), false);
  assert.equal(pageModule.shouldAbortAiRequestForContext('editor'), false);
  assert.equal(pageModule.shouldAbortAiRequestForContext('ask'), true);
  assert.equal(pageModule.shouldAbortAiRequestForContext('index'), true);
  assert.equal(pageModule.shouldAbortAiRequestForContext('read'), true);
  assert.match(PAGE_HTML, /function showAskView\(\) \{\s*leaveAiEditingContext\('ask'\)/);
});

test('an old request settling cannot clear a newer request busy state', () => {
  assert.equal(typeof pageModule.settleAiRequest, 'function');
  const oldRequest = { id: 'old' };
  const newRequest = { id: 'new' };

  assert.deepEqual(pageModule.settleAiRequest(newRequest, oldRequest), {
    activeRequest: newRequest,
    shouldClearBusy: false,
  });
  assert.deepEqual(pageModule.settleAiRequest(newRequest, newRequest), {
    activeRequest: null,
    shouldClearBusy: true,
  });
});

test('selection-only answers offer safe write-back while every completed answer offers copy', () => {
  assert.match(PAGE_HTML, /message = \{[\s\S]*?contextMode:\s*requestContext\.mode/);
  assert.match(PAGE_HTML, /message\.contextMode === 'selection'/);
  assert.match(PAGE_HTML, /const writableSelectionAnswer = selectionAnswer && !!message\.snapshot/);
  assert.match(PAGE_HTML, /canApplyAiResult\(message\.snapshot,\s*ta\.value,\s*aiDraftKey\(\)\)/);
  assert.match(PAGE_HTML, /applyAiResult\(message\.snapshot,\s*ta\.value,\s*message\.content,\s*mode,\s*aiDraftKey\(\)\)/);
  assert.match(PAGE_HTML, /ta\.setRangeText\(/);
  assert.match(PAGE_HTML, /new Event\('input',\s*\{\s*bubbles:\s*true\s*\}\)/);
  assert.match(PAGE_HTML, /draftTidied = false/);
  assert.match(PAGE_HTML, /navigator\.clipboard\.writeText\(message\.content\)/);
  assert.match(PAGE_HTML, /body\.textContent = message\.content/);
  assert.doesNotMatch(PAGE_HTML, /body\.innerHTML = message\.content/);
});

test('only completed answers expose actions and a successful action disables all three', () => {
  assert.match(PAGE_HTML, /message\.status === 'done' && message\.content/);
  assert.match(PAGE_HTML, /writableSelectionAnswer/);
  assert.match(PAGE_HTML, /copy\.disabled = !!message\.applied/);
  assert.ok((PAGE_HTML.match(/\{\s*applied:\s*true\s*\}/g) || []).length >= 2);
});

test('rendered article selection is captured before focus, refreshed live, and cleared on context switches', () => {
  const openAiPanelBody = PAGE_HTML.slice(
    PAGE_HTML.indexOf('function openAiPanel()'),
    PAGE_HTML.indexOf('function switchAiThread(threadId)'),
  );
  assert.match(
    PAGE_HTML,
    /function captureAiContext\(\)[\s\S]*?renderedSelection:\s*renderedSelectionStore\.read\(\{[\s\S]*?path:\s*current[\s\S]*?\}\)/,
  );
  assert.match(openAiPanelBody, /syncRenderedSelectionSnapshot\(\{\s*clearOnMiss:\s*true\s*\}\)[\s\S]*?aiDrawerController\.open\(\)/);
  assert.match(
    PAGE_HTML,
    /document\.addEventListener\('selectionchange',[\s\S]*?syncRenderedSelectionSnapshot\(\)[\s\S]*?refreshOpenAiWorkspace\(\)/,
  );
  assert.match(
    PAGE_HTML,
    /\$\('content'\)\.addEventListener\('mouseup',[\s\S]*?syncRenderedSelectionSnapshot\(\{\s*clearOnMiss:\s*true\s*\}\)[\s\S]*?refreshOpenAiWorkspace\(\)/,
  );
  for (const pattern of [
    /function showIndex\(\)[\s\S]*?clearRenderedSelectionSnapshot\(\)/,
    /function showAskView\(\)[\s\S]*?clearRenderedSelectionSnapshot\(\)/,
    /function showEdit\(\)[\s\S]*?clearRenderedSelectionSnapshot\(\)/,
    /applyNote:\s*\(note\)\s*=>\s*\{[\s\S]*?clearRenderedSelectionSnapshot\(\)/,
  ]) {
    assert.match(PAGE_HTML, pattern);
  }
});

test('read-mode AI selections keep raw note context and expose copy-only answers', () => {
  assert.match(
    PAGE_HTML,
    /function captureAiContext\(\)[\s\S]*?noteContent:\s*mode === 'selection'[\s\S]*?editing \? ta\.value : currentRaw[\s\S]*?mode === 'document' \? raw\.content : ''/,
  );
  assert.match(
    PAGE_HTML,
    /if \(writableSelectionAnswer\) \{[\s\S]*?tr\('ai\.replace'\)[\s\S]*?tr\('ai\.insert'\)/,
  );
  assert.doesNotMatch(
    PAGE_HTML,
    /if \(selectionAnswer\) \{[\s\S]*?tr\('ai\.replace'\)[\s\S]*?tr\('ai\.insert'\)/,
  );
});

test('general history is explicitly tagged and document history is filtered from general requests', () => {
  assert.match(PAGE_HTML, /contextMode:\s*requestContext\.mode/);
  assert.match(PAGE_HTML, /\.filter\(\(item\) => requestContext\.mode !== 'general' \|\| item\.contextMode === 'general'\)/);
  assert.match(PAGE_HTML, /\.map\(\(\{\s*role,\s*content,\s*contextMode\s*\}\) => \(\{\s*role,\s*content,\s*contextMode\s*\}\)\)/);
});

test('drawer closes on Escape and keeps an independent live status', () => {
  assert.match(PAGE_HTML, /event\.key === 'Escape'[\s\S]*?!\$\('aiPanel'\)\.hidden[\s\S]*?closeAiPanel\(\)/);
  assert.match(PAGE_HTML, /id="aiStatus"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('global assistant stays open across views and refreshes its context card', () => {
  assert.doesNotMatch(PAGE_HTML, /function showView\(html\)\s*\{[\s\S]{0,160}closeAiPanel\(\)/);
  assert.match(PAGE_HTML, /function refreshOpenAiWorkspace\(\)/);
  assert.match(PAGE_HTML, /function showIndex\(\)[\s\S]*?refreshOpenAiWorkspace\(\)/);
  assert.match(PAGE_HTML, /function showAskView\(\)[\s\S]*?refreshOpenAiWorkspace\(\)/);
  assert.match(PAGE_HTML, /function showView\(html\)[\s\S]*?refreshOpenAiWorkspace\(\)/);
});

test('AI write-back follows the ordinary textarea input and explicit save flow', () => {
  assert.match(PAGE_HTML, /ta\.setRangeText\([\s\S]*?ta\.dispatchEvent\(new Event\('input',\s*\{\s*bubbles:\s*true\s*\}\)\)/);
  assert.match(PAGE_HTML, /\$\('ta'\)\.addEventListener\('input', updatePreview\)/);
  assert.match(PAGE_HTML, /\$\('saveBtn'\)\.onclick = async \(\) =>[\s\S]*?content: \$\('ta'\)\.value/);
  assert.doesNotMatch(PAGE_HTML, /applyAiMessage[\s\S]{0,1000}api\('\/api\/note'/);
});

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
    assert.match(
      html,
      /if \(!\$\('setOverlay'\)\.classList\.contains\('show'\)\) \{\s*void leaveCurrentDocument\(async \(\) => \{ location\.reload\(\); \}\);/,
    );
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

test('in-page settings renders an accessible, independent vault sync group', () => {
  for (const html of [EN_HTML, ZH_HTML]) {
    assert.match(html, /<fieldset class="set-group"[^>]*>[\s\S]*?id="SYNC_ENABLED"/);
    for (const id of [
      'SYNC_BUCKET', 'SYNC_ENDPOINT', 'SYNC_REGION', 'SYNC_PREFIX',
      'SYNC_FORCE_PATH_STYLE', 'SYNC_ACCESS_KEY_ID', 'SYNC_SECRET_ACCESS_KEY',
      'SYNC_PASSWORD', 'SYNC_CLEAR_PASSWORD',
    ]) {
      assert.match(html, new RegExp(`<label[^>]*for="${id}"|<input[^>]*id="${id}"`));
    }
    assert.match(html, /id="syncPlaintextWarning"[^>]*role="alert"/);
    assert.match(html, /id="syncTest"[^>]*type="button"/);
    assert.match(html, /id="syncNow"[^>]*type="button"/);
    assert.match(html, /id="syncStatus"[^>]*role="status"/);
  }
  assert.match(EN_HTML, />Vault bidirectional sync \(S3-compatible\)</);
  assert.match(ZH_HTML, />Vault 双向同步（S3 兼容）</);
});

test('sync payload is strict and preserves masked secrets by omission', () => {
  assert.deepEqual(buildSyncPayload({
    enabled: true,
    bucket: ' bucket ',
    prefix: '',
    endpoint: ' https://s3.example.com ',
    region: '',
    forcePathStyle: true,
    accessKeyId: ' key ',
    secretAccessKey: '',
    password: '',
    clearPassword: false,
  }), {
    enabled: true,
    bucket: 'bucket',
    prefix: 'wikinest-sync/',
    endpoint: 'https://s3.example.com',
    region: 'auto',
    forcePathStyle: true,
    accessKeyId: 'key',
  });
  assert.deepEqual(buildSyncPayload({
    secretAccessKey: ' secret ',
    password: ' pass ',
    clearSecretAccessKey: true,
    clearPassword: true,
  }), {
    enabled: false,
    bucket: '',
    prefix: 'wikinest-sync/',
    endpoint: '',
    region: 'auto',
    forcePathStyle: false,
    accessKeyId: '',
    secretAccessKey: 'secret',
    clearSecretAccessKey: true,
    clearPassword: true,
  });
});

test('sync status refresh never overwrites an editor or unsaved draft', async () => {
  assert.equal(canRefreshSyncedNote({
    current: 'notes/a.md', editing: false, currentRaw: 'same', editorRaw: 'same',
  }), true);
  assert.equal(canRefreshSyncedNote({
    current: 'notes/a.md', editing: true, currentRaw: 'same', editorRaw: 'same',
  }), false);
  assert.equal(canRefreshSyncedNote({
    current: 'notes/a.md', editing: false, currentRaw: 'old', editorRaw: 'changed',
  }), false);
  assert.equal(canRefreshSyncedNote({
    current: null, editing: false, currentRaw: '', editorRaw: '',
  }), false);
  assert.equal(canRefreshSyncedNote({
    current: 'notes/a.md',
    documentState: { path: 'notes/a.md', status: 'dirty', revision: 3 },
  }), false);
  assert.match(PAGE_HTML, /onSyncStatus\(handleSyncStatus\)/);
  assert.match(PAGE_HTML, /refreshSyncedNote\(\{/);
  assert.match(PAGE_HTML, /canRefreshSyncedNote\(/);

  let snapshot = {
    current: 'notes/a.md', editing: false, currentRaw: 'same', editorRaw: 'same',
  };
  const opened = [];
  await refreshSyncedNote({
    loadIndex: async () => {
      snapshot = { ...snapshot, editing: true, editorRaw: 'typing' };
    },
    getSnapshot: () => snapshot,
    openNote: async (path) => opened.push(path),
  });
  assert.deepEqual(opened, []);

  snapshot = {
    current: 'notes/a.md',
    documentState: { path: 'notes/a.md', status: 'dirty', revision: 3 },
  };
  await refreshSyncedNote({
    loadIndex: async () => {},
    getSnapshot: () => snapshot,
    openNote: async (path) => opened.push(path),
  });
  assert.deepEqual(opened, []);

  snapshot = {
    current: 'notes/a.md', editing: false, currentRaw: 'same', editorRaw: 'same',
  };
  await refreshSyncedNote({
    loadIndex: async () => {},
    getSnapshot: () => snapshot,
    openNote: async (path, guard) => {
      snapshot = { ...snapshot, editing: true, editorRaw: 'typing' };
      if (guard()) opened.push(path);
    },
  });
  assert.deepEqual(opened, []);
});

test('sync refresh ignores a local save before expensive index work and reports only real remote changes', async () => {
  let snapshot = {
    current: 'notes/a.md',
    version: 'local-version',
    documentState: {
      path: 'notes/a.md',
      version: 'previous-version',
      status: 'saving',
      revision: 2,
    },
  };
  let indexLoads = 0;
  let externalChanges = 0;
  const options = {
    loadIndex: async () => { indexLoads += 1; },
    getSnapshot: () => snapshot,
    fetchNote: async () => ({ path: 'notes/a.md', version: 'local-version', content: 'local' }),
    openNote: async () => true,
    onExternalChange: () => { externalChanges += 1; },
  };

  assert.equal(await refreshSyncedNote(options), false);
  assert.equal(indexLoads, 0);
  assert.equal(externalChanges, 0);

  snapshot = {
    ...snapshot,
    version: 'previous-version',
    documentState: { ...snapshot.documentState, status: 'dirty' },
  };
  options.fetchNote = async () => ({ path: 'notes/a.md', version: 'remote-version', content: 'remote' });
  assert.equal(await refreshSyncedNote(options), false);
  assert.equal(indexLoads, 1);
  assert.equal(externalChanges, 1);
  assert.match(PAGE_HTML, /version:\s*currentVersion/);
});

test('guarded note response is discarded before applying stale data', async () => {
  let resolveNote;
  const response = new Promise((resolve) => { resolveNote = resolve; });
  let valid = true;
  const applied = [];
  const loading = loadNoteWithGuard({
    fetchNote: () => response,
    guard: () => valid,
    applyNote: (note) => applied.push(note),
  });
  valid = false;
  resolveNote({ path: 'notes/a.md', content: 'remote' });
  assert.equal(await loading, false);
  assert.deepEqual(applied, []);

  assert.equal(await loadNoteWithGuard({
    fetchNote: async () => ({ path: 'notes/a.md', content: 'normal' }),
    applyNote: (note) => applied.push(note),
  }), true);
  assert.equal(applied[0].content, 'normal');
  assert.match(PAGE_HTML, /async function openNote\(path, applyGuard, prefetchedNote\)/);
});

test('settings opening is single-flight and retries after failure', async () => {
  let calls = 0;
  let shown = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const openSettings = createSettingsOpener({
    isOpen: () => shown,
    loadAndOpen: async () => {
      calls += 1;
      await gate;
      shown = true;
      return 'opened';
    },
  });
  const first = openSettings();
  const second = openSettings();
  assert.equal(first, second);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'opened');
  assert.equal(await openSettings(), false);
  assert.equal(calls, 1);

  let attempts = 0;
  const retryable = createSettingsOpener({
    isOpen: () => false,
    loadAndOpen: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('load failed');
      return 'retried';
    },
  });
  await assert.rejects(retryable(), /load failed/);
  assert.equal(await retryable(), 'retried');
  assert.equal(attempts, 2);
  assert.match(PAGE_HTML, /createSettingsOpener\(\{[\s\S]*loadAndOpen: loadAndOpenSettings/);
});

test('sync settings distinguish partial saves and preserve unsaved modal drafts', () => {
  assert.match(PAGE_HTML, /isOpen: \(\) => \$\('setOverlay'\)\.classList\.contains\('show'\)/);
  assert.match(PAGE_HTML, /let settingsSaved = false/);
  assert.match(PAGE_HTML, /settingsSaved\s*\? tr\('sync\.partialSaveFailed'/);
  assert.match(PAGE_HTML, /let syncSavedEnabled = false/);
  assert.match(PAGE_HTML, /\$\('syncNow'\)\.disabled = !syncSavedEnabled/);
});

test('sync password controls are mutually exclusive and warning follows final mode', () => {
  assert.match(PAGE_HTML, /SYNC_CLEAR_PASSWORD[\s\S]*SYNC_PASSWORD[\s\S]*disabled/);
  assert.match(PAGE_HTML, /SYNC_PASSWORD[\s\S]*SYNC_CLEAR_PASSWORD[\s\S]*checked = false/);
  assert.match(PAGE_HTML, /syncPlaintextWarning'\)\.hidden = !enabled \|\| passwordWillExist/);
  assert.doesNotMatch(PAGE_HTML, /new Date\(\)\.toISOString\(\)/);
});
