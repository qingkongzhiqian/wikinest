import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// store.js reads WIKI_CONTENT_DIR at module-load time, so the env var must be
// set before the (dynamic) import. node --test isolates each file in its own
// process, so this won't leak into other test files.
let store;
let dir;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wiki-store-'));
  process.env.WIKI_CONTENT_DIR = dir;
  store = await import('../src/core/store.js');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('resolveNotePath keeps paths inside the content dir', () => {
  const abs = store.resolveNotePath('journal/today');
  assert.ok(abs.startsWith(dir));
  assert.ok(abs.endsWith('journal/today.md'));
});

test('resolveNotePath appends .md only when missing', () => {
  assert.ok(store.resolveNotePath('a').endsWith('a.md'));
  assert.ok(store.resolveNotePath('a.md').endsWith('a.md'));
  assert.equal(store.resolveNotePath('a').endsWith('a.md.md'), false);
});

test('resolveNotePath rejects traversal and empty paths', () => {
  assert.throws(() => store.resolveNotePath('../evil'));
  assert.throws(() => store.resolveNotePath('a/../../b'));
  assert.throws(() => store.resolveNotePath(''));
  assert.throws(() => store.resolveNotePath('   '));
});

test('resolveNotePath treats absolute-looking paths as relative (stays inside)', () => {
  const abs = store.resolveNotePath('/etc/passwd');
  assert.ok(abs.startsWith(dir));
  assert.ok(abs.endsWith('etc/passwd.md'));
});

test('normalizeCategoryList trims, dedupes, and drops non-strings', () => {
  assert.deepEqual(store.normalizeCategoryList(['a', 'a', ' b ', '']), ['a', 'b']);
  assert.deepEqual(store.normalizeCategoryList('x'), ['x']);
  assert.deepEqual(store.normalizeCategoryList(null), []);
  assert.deepEqual(store.normalizeCategoryList(undefined), []);
  assert.deepEqual(store.normalizeCategoryList([1, 2, {}]), []);
});

test('writeNote / readNote roundtrip preserves body and frontmatter', async () => {
  await store.writeNote('notes/hello', '# Hi\nbody text', { frontmatter: { title: 'Hi' } });
  const note = await store.readNote('notes/hello');
  assert.equal(note.data.title, 'Hi');
  assert.match(note.content, /body text/);
});

test('nextAvailablePath avoids clobbering existing notes', async () => {
  await store.writeNote('dup/note', 'first');
  const p = await store.nextAvailablePath('dup/note');
  assert.equal(p, 'dup/note-2.md');
});

test('searchNotes: multi-keyword AND, phrases, and ranking', async () => {
  await store.writeNote('search/a', '# Electron 桌面\n本地优先的知识库,支持 MCP 和 RAG。');
  await store.writeNote('search/b', '# MCP 教程\nMCP 是核心。MCP MCP MCP 多次出现。RAG 也提到。');
  await store.writeNote('search/c', '# 随笔\n今天写了点 electron 相关的东西,顺便聊 rag。');

  const single = await store.searchNotes('mcp');
  const singlePaths = single.map((h) => h.path);
  assert.ok(singlePaths.includes('search/b.md'));
  assert.ok(singlePaths.includes('search/a.md'));
  // b has the term in title + repeated, so it should outrank a.
  assert.ok(single.findIndex((h) => h.path === 'search/b.md')
    < single.findIndex((h) => h.path === 'search/a.md'));

  const both = (await store.searchNotes('electron rag')).map((h) => h.path).sort();
  assert.deepEqual(both, ['search/a.md', 'search/c.md']);

  const phrase = (await store.searchNotes('"本地优先"')).map((h) => h.path);
  assert.deepEqual(phrase, ['search/a.md']);

  assert.equal((await store.searchNotes('zzznomatch')).length, 0);
  assert.equal((await store.searchNotes('   ')).length, 0);
});
