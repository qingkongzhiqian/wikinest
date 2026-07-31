import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, readFile, readdir, rm, stat,
} from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// store.js reads WIKI_CONTENT_DIR at module-load time, so the env var must be
// set before the (dynamic) import. node --test isolates each file in its own
// process, so this won't leak into other test files.
let store;
let dir;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withTimeout(promise, message, ms = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

test('concurrent appends to one note do not lose updates', async () => {
  await store.writeNote('concurrency/append', 'start');

  await Promise.all([
    store.writeNote('concurrency/append', 'first', { mode: 'append' }),
    store.writeNote('concurrency/append', 'second', { mode: 'append' }),
  ]);

  const { content } = await store.readNote('concurrency/append');
  assert.match(content, /start/);
  assert.match(content, /first/);
  assert.match(content, /second/);
});

test('concurrent frontmatter updates do not lose fields', async () => {
  await store.writeNote('concurrency/frontmatter', 'body', {
    frontmatter: { title: 'Original' },
  });

  await Promise.all([
    store.updateFrontmatter('concurrency/frontmatter', { alpha: 1 }),
    store.updateFrontmatter('concurrency/frontmatter', { beta: 2 }),
  ]);

  const { data } = await store.readNote('concurrency/frontmatter');
  assert.deepEqual(data, { title: 'Original', alpha: 1, beta: 2 });
});

test('atomic write failure releases the path lock and removes temp files', async () => {
  const originalRename = fs.rename;
  let failOnce = true;
  fs.rename = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('injected rename failure');
    }
    return originalRename(...args);
  };

  try {
    await assert.rejects(
      store.writeNote('atomic/recover', 'failed'),
      /injected rename failure/,
    );
    await store.writeNote('atomic/recover', 'recovered');
  } finally {
    fs.rename = originalRename;
  }

  assert.match((await store.readNote('atomic/recover')).content, /recovered/);
  const entries = await readdir(path.join(dir, 'atomic'));
  assert.deepEqual(entries, ['recover.md']);
});

test('atomic writes to different paths can enter rename concurrently', async () => {
  const originalRename = fs.rename;
  const entered = [];
  const bothEntered = deferred();
  const gate = deferred();
  fs.rename = async (from, to) => {
    entered.push(to);
    if (entered.length === 2) bothEntered.resolve();
    await gate.promise;
    return originalRename(from, to);
  };

  try {
    const writes = Promise.all([
      store.writeNote('parallel/a', 'a'),
      store.writeNote('parallel/b', 'b'),
    ]);
    await withTimeout(
      bothEntered.promise,
      'different paths did not reach rename concurrently',
    );
    assert.equal(entered.length, 2);
    gate.resolve();
    await writes;
  } finally {
    gate.resolve();
    fs.rename = originalRename;
  }
});

test('path locks conservatively serialize case and Unicode aliases', async () => {
  const originalRename = fs.rename;
  const firstAliasEntered = deferred();
  const unrelatedEntered = deferred();
  const gate = deferred();
  const aliasTargets = new Set([
    store.resolveNotePath('aliases/Café'),
    store.resolveNotePath('aliases/CAFE\u0301'),
  ]);
  let aliasEntryCount = 0;

  fs.rename = async (from, to) => {
    if (aliasTargets.has(to)) {
      aliasEntryCount++;
      if (aliasEntryCount === 1) firstAliasEntered.resolve();
    } else if (to === store.resolveNotePath('aliases/unrelated')) {
      unrelatedEntered.resolve();
    }
    await gate.promise;
    return originalRename(from, to);
  };

  try {
    const first = store.writeNote('aliases/Café', 'first');
    await withTimeout(firstAliasEntered.promise, 'first alias never entered rename');
    const second = store.writeNote('aliases/CAFE\u0301', 'second');
    const unrelated = store.writeNote('aliases/unrelated', 'other');
    await withTimeout(unrelatedEntered.promise, 'unrelated path was unexpectedly blocked');
    assert.equal(aliasEntryCount, 1);
    gate.resolve();
    await Promise.all([first, second, unrelated]);
  } finally {
    gate.resolve();
    fs.rename = originalRename;
  }
});

test('case-only move uses one direct atomic rename and preserves the note', async () => {
  await store.writeNote('case-move/note', 'case-sensitive body');
  const originalRename = fs.rename;
  const calls = [];
  fs.rename = async (...args) => {
    calls.push(args);
    return originalRename(...args);
  };

  try {
    await store.moveNote('case-move/note', 'case-move/NOTE');
  } finally {
    fs.rename = originalRename;
  }

  assert.deepEqual(calls, [[
    store.resolveNotePath('case-move/note'),
    store.resolveNotePath('case-move/NOTE'),
  ]]);
  assert.match((await store.readNote('case-move/NOTE')).content, /case-sensitive body/);
});

test('failed atomic move leaves the source intact and emits no mutation', async () => {
  await store.writeNote('move-failure/source', 'source body');
  const events = [];
  const unregister = store.setMutationObserver((event) => events.push(event));
  const originalRename = fs.rename;
  fs.rename = async () => { throw new Error('injected move failure'); };

  try {
    await assert.rejects(
      store.moveNote('move-failure/source', 'move-failure/destination'),
      /injected move failure/,
    );
  } finally {
    fs.rename = originalRename;
    unregister();
  }

  assert.match((await store.readNote('move-failure/source')).content, /source body/);
  assert.equal(await store.noteExists('move-failure/destination'), false);
  assert.deepEqual(events, []);
});

test('atomic write exposes cleanup failure without losing the write error', async () => {
  const originalRename = fs.rename;
  const originalUnlink = fs.unlink;
  let tempPath;
  fs.rename = async (from) => {
    tempPath = from;
    throw new Error('primary rename failure');
  };
  fs.unlink = async () => { throw new Error('temp cleanup failure'); };

  try {
    await assert.rejects(
      store.writeNote('atomic/cleanup-error', 'body'),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /primary rename failure/);
        assert.match(error.errors[1].message, /temp cleanup failure/);
        return true;
      },
    );
  } finally {
    fs.rename = originalRename;
    fs.unlink = originalUnlink;
    if (tempPath) await fs.rm(tempPath, { force: true });
  }
});

test('successful writes invalidate note and search caches immediately', async () => {
  await store.writeNote('cache/immediate', 'old unique phrase', {
    frontmatter: { title: 'Old' },
  });
  await store.getAllNotes();
  assert.equal((await store.searchNotes('"old unique phrase"')).length, 1);

  const abs = store.resolveNotePath('cache/immediate');
  const oldMtime = (await stat(abs)).mtimeMs;
  const originalStat = fs.stat;
  fs.stat = async (target, ...args) => {
    const result = await originalStat(target, ...args);
    return target === abs ? { ...result, mtimeMs: oldMtime } : result;
  };

  try {
    await store.writeNote('cache/immediate', 'new unique phrase', {
      frontmatter: { title: 'New' },
    });
    const notes = await store.getAllNotes();
    const note = notes.find(({ path: p }) => p === 'cache/immediate.md');
    assert.equal(note.data.title, 'New');
    assert.match(note.content, /new unique phrase/);
    assert.equal((await store.searchNotes('"old unique phrase"')).length, 0);
    assert.equal((await store.searchNotes('"new unique phrase"')).length, 1);
  } finally {
    fs.stat = originalStat;
  }
});

test('a stale concurrent search cannot refill note or search caches after mutation', async () => {
  await store.writeNote('cache/concurrent', 'old stale phrase');
  const abs = store.resolveNotePath('cache/concurrent');
  const fixedMtime = (await stat(abs)).mtimeMs;
  const originalReadFile = fs.readFile;
  const originalStat = fs.stat;
  const staleReadStarted = deferred();
  const releaseStaleRead = deferred();
  let intercepted = false;

  fs.stat = async (target, ...args) => {
    const result = await originalStat(target, ...args);
    return target === abs ? { ...result, mtimeMs: fixedMtime } : result;
  };
  fs.readFile = async (target, ...args) => {
    const result = await originalReadFile(target, ...args);
    if (target === abs && !intercepted) {
      intercepted = true;
      staleReadStarted.resolve();
      await releaseStaleRead.promise;
    }
    return result;
  };

  try {
    const staleSearch = store.searchNotes('"old stale phrase"');
    await withTimeout(staleReadStarted.promise, 'stale cache read never started');
    await store.writeNote('cache/concurrent', 'new fresh phrase');
    releaseStaleRead.resolve();
    await staleSearch;

    assert.equal((await store.searchNotes('"old stale phrase"')).length, 0);
    assert.equal((await store.searchNotes('"new fresh phrase"')).length, 1);
  } finally {
    releaseStaleRead.resolve();
    fs.readFile = originalReadFile;
    fs.stat = originalStat;
  }
});

test('local mutations notify the sole observer without breaking completed writes', async () => {
  const events = [];
  const unregister = store.setMutationObserver((event) => {
    events.push(event);
    if (event.type === 'upsert' && event.path === 'observer/error.md') {
      throw new Error('observer failed');
    }
  });

  try {
    await store.writeNote('observer/note', 'one');
    await store.updateFrontmatter('observer/note', { title: 'Updated' });
    await store.moveNote('observer/note', 'observer/moved');
    await store.deleteNote('observer/moved');
    await store.writeNote('observer/error', 'still written');
  } finally {
    unregister();
  }

  assert.deepEqual(events.slice(0, 4), [
    { type: 'upsert', path: 'observer/note.md', origin: 'local' },
    { type: 'upsert', path: 'observer/note.md', origin: 'local' },
    {
      type: 'move',
      from: 'observer/note.md',
      path: 'observer/moved.md',
      origin: 'local',
    },
    { type: 'delete', path: 'observer/moved.md', origin: 'local' },
  ]);
  assert.equal(await store.noteExists('observer/error'), true);
});

test('observer Promise rejection cannot break a completed write', async () => {
  const unregister = store.setMutationObserver(
    async () => { throw new Error('async observer failed'); },
  );
  try {
    await store.writeNote('observer/async-error', 'still durable');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    unregister();
  }
  assert.equal(await store.noteExists('observer/async-error'), true);
});

test('new observer replaces the old and old unregister cannot clear it', async () => {
  const oldEvents = [];
  const newEvents = [];
  const unregisterOld = store.setMutationObserver((event) => oldEvents.push(event));
  const unregisterNew = store.setMutationObserver((event) => newEvents.push(event));
  unregisterOld();

  try {
    await store.writeNote('observer/replaced', 'body');
  } finally {
    unregisterNew();
  }

  assert.deepEqual(oldEvents, []);
  assert.deepEqual(newEvents, [
    { type: 'upsert', path: 'observer/replaced.md', origin: 'local' },
  ]);
});

test('sync raw apply/delete preserves bytes and never loops into local observer', async () => {
  const events = [];
  const unregister = store.setMutationObserver((event) => events.push(event));
  const raw = '---\ntitle: Remote\n---\nExact remote bytes\n';

  try {
    const applied = await store.applyRawNote('sync/raw', raw);
    assert.deepEqual(applied, { path: 'sync/raw.md', origin: 'sync' });
    assert.equal(await readFile(store.resolveNotePath('sync/raw'), 'utf8'), raw);
    const deleted = await store.deleteRawNote('sync/raw');
    assert.deepEqual(deleted, { path: 'sync/raw.md', origin: 'sync' });
  } finally {
    unregister();
  }

  assert.deepEqual(events, []);
  assert.equal(await store.noteExists('sync/raw'), false);
});

test('sync raw CAS checks expected bytes and expected absence without modifying user files', async () => {
  const original = Buffer.from('original bytes');
  const originalHash = (await import('node:crypto'))
    .createHash('sha256')
    .update(original)
    .digest('hex');
  await store.applyRawNote('sync/cas', original, { expectedContentHash: null });
  await assert.rejects(
    store.applyRawNote('sync/cas', 'remote replacement', { expectedContentHash: null }),
    (error) => error.code === 'LOCAL_CHANGED_DURING_SYNC',
  );
  assert.deepEqual(await readFile(store.resolveNotePath('sync/cas')), original);
  await assert.rejects(
    store.deleteRawNote('sync/cas', { expectedContentHash: '0'.repeat(64) }),
    (error) => error.code === 'LOCAL_CHANGED_DURING_SYNC',
  );
  assert.deepEqual(await readFile(store.resolveNotePath('sync/cas')), original);
  await store.deleteRawNote('sync/cas', { expectedContentHash: originalHash });
  await store.deleteRawNote('sync/cas', { expectedContentHash: null });
});

test('store CAS rechecks after temporary write and preserves an external target change', async () => {
  const target = store.resolveNotePath('sync/cas-window');
  const original = Buffer.from('scan snapshot');
  const external = Buffer.from('external write during temporary write');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, original);
  const expectedContentHash = (await import('node:crypto'))
    .createHash('sha256')
    .update(original)
    .digest('hex');
  const originalWriteFile = fs.writeFile;
  let injected = false;
  fs.writeFile = async (file, ...args) => {
    const result = await originalWriteFile(file, ...args);
    if (!injected && file !== target && path.dirname(file) === path.dirname(target)) {
      injected = true;
      await originalWriteFile(target, external);
    }
    return result;
  };

  try {
    await assert.rejects(
      store.applyRawNote('sync/cas-window', 'remote replacement', { expectedContentHash }),
      (error) => error.code === 'LOCAL_CHANGED_DURING_SYNC',
    );
  } finally {
    fs.writeFile = originalWriteFile;
  }

  assert.deepEqual(await fs.readFile(target), external);
  assert.deepEqual(
    (await fs.readdir(path.dirname(target))).filter((name) => name.includes('cas-window')),
    ['cas-window.md'],
  );
});

test('store CAS rechecks immediately before unlink and preserves an external target change', async () => {
  const target = store.resolveNotePath('sync/delete-window');
  const original = Buffer.from('scan snapshot');
  const external = Buffer.from('external write before unlink');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, original);
  const expectedContentHash = (await import('node:crypto'))
    .createHash('sha256')
    .update(original)
    .digest('hex');
  const originalReadFile = fs.readFile;
  const originalWriteFile = fs.writeFile;
  let injected = false;
  fs.readFile = async (file, ...args) => {
    const value = await originalReadFile(file, ...args);
    if (!injected && file === target) {
      injected = true;
      await originalWriteFile(target, external);
    }
    return value;
  };

  try {
    await assert.rejects(
      store.deleteRawNote('sync/delete-window', { expectedContentHash }),
      (error) => error.code === 'LOCAL_CHANGED_DURING_SYNC',
    );
  } finally {
    fs.readFile = originalReadFile;
  }

  assert.deepEqual(await fs.readFile(target), external);
});

test('noteVersion hashes the exact persisted file bytes', async () => {
  const raw = Buffer.from('---\ntitle: café\n---\nbody\r\n', 'utf8');
  const expected = (await import('node:crypto'))
    .createHash('sha256')
    .update(raw)
    .digest('hex');
  assert.equal(store.noteVersion(raw), expected);
});

test('versioned writes reject stale versions and preserve the original bytes', async () => {
  const target = store.resolveNotePath('versions/stale');
  const original = Buffer.from('---\ntitle: Old\n---\noriginal\n');
  const external = Buffer.from('---\ntitle: External\n---\nexternal change\n');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, original);

  await assert.rejects(
    store.writeNoteVersioned('versions/stale', 'local draft', {
      frontmatter: { title: 'Local' },
      baseVersion: store.noteVersion(Buffer.from('not the current file')),
    }),
    (error) => error.code === 'NOTE_VERSION_CONFLICT'
      && error.currentVersion === store.noteVersion(original),
  );
  assert.deepEqual(await fs.readFile(target), original);

  const originalWriteFile = fs.writeFile;
  let injected = false;
  fs.writeFile = async (file, ...args) => {
    const result = await originalWriteFile(file, ...args);
    if (!injected && file !== target && path.dirname(file) === path.dirname(target)) {
      injected = true;
      await originalWriteFile(target, external);
    }
    return result;
  };

  try {
    await assert.rejects(
      store.writeNoteVersioned('versions/stale', 'local draft', {
        frontmatter: { title: 'Local' },
        baseVersion: store.noteVersion(original),
      }),
      (error) => error.code === 'NOTE_VERSION_CONFLICT'
        && error.currentVersion === store.noteVersion(external),
    );
  } finally {
    fs.writeFile = originalWriteFile;
  }

  assert.deepEqual(await fs.readFile(target), external);
});
