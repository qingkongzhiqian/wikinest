import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir;
let store;
let createApp;

async function startApp() {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlFor(server, pathname) {
  return `http://127.0.0.1:${server.address().port}${pathname}`;
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wiki-note-version-api-'));
  process.env.WIKI_CONTENT_DIR = dir;
  store = await import('../src/core/store.js');
  ({ createApp } = await import('../src/web/server.js'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('GET exposes a version based on persisted bytes', async () => {
  await store.writeNote('notes/read-version', 'first', { frontmatter: { title: 'First' } });
  const server = await startApp();
  try {
    const response = await fetch(urlFor(server, '/api/note?path=notes%2Fread-version.md'));
    const body = await response.json();
    const raw = await store.readNote('notes/read-version');
    assert.equal(response.status, 200);
    assert.equal(body.version, store.noteVersion(Buffer.from(raw.raw)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET hashes invalid UTF-8 bytes from the same read used for note content', async () => {
  const raw = Buffer.from('---\ntitle: Snapshot\n---\ninvalid byte: \xff\n', 'binary');
  const target = store.resolveNotePath('notes/invalid-utf8');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, raw);
  const server = await startApp();
  try {
    const response = await fetch(urlFor(server, '/api/note?path=notes%2Finvalid-utf8.md'));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.version, store.noteVersion(raw));
    assert.equal(body.content, 'invalid byte: �\n');
    assert.equal(body.data.title, 'Snapshot');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('save with categories and frontmatter hashes the final persisted raw bytes', async () => {
  const server = await startApp();
  try {
    const response = await fetch(urlFor(server, '/api/note'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'notes/categorized.md',
        markdown: 'body after category processing',
        frontmatter: {
          title: 'Categorized',
          categories: ['research'],
          source: 'regression',
        },
        autoClassify: false,
      }),
    });
    const body = await response.json();
    const persisted = await readFile(store.resolveNotePath(body.path));

    assert.equal(response.status, 200);
    assert.deepEqual(body.categories, ['research']);
    assert.equal(body.version, store.noteVersion(persisted));
    assert.match(persisted.toString('utf8'), /title: Categorized/);
    assert.match(persisted.toString('utf8'), /categories:\n\s+- research/);
    assert.match(persisted.toString('utf8'), /source: regression/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('stale saves retain the original and create a non-colliding local conflict copy', async () => {
  await store.writeNote('notes/conflict', 'original', { frontmatter: { title: 'Original' } });
  const server = await startApp();
  try {
    const loaded = await fetch(urlFor(server, '/api/note?path=notes%2Fconflict.md'));
    const { version } = await loaded.json();
    await store.writeNote('notes/conflict', 'external change', { frontmatter: { title: 'External' } });
    await store.writeNote('notes/conflict-conflict-local', 'existing conflict');

    const response = await fetch(urlFor(server, '/api/note'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'notes/conflict.md',
        markdown: 'local draft',
        baseVersion: version,
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.deepEqual(Object.keys(body).sort(), ['code', 'conflictPath', 'currentVersion']);
    assert.equal(body.code, 'NOTE_VERSION_CONFLICT');
    assert.equal(body.conflictPath, 'notes/conflict-conflict-local-2.md');
    assert.equal(body.currentVersion, store.noteVersion(Buffer.from((await store.readNote('notes/conflict')).raw)));
    assert.match((await store.readNote('notes/conflict')).content, /external change/);
    assert.match((await store.readNote(body.conflictPath)).content, /local draft/);
    assert.equal(JSON.stringify(body).includes(dir), false);
    assert.equal(JSON.stringify(body).includes('local draft'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('concurrent stale saves each retain a separate local conflict copy', async () => {
  await store.writeNote('notes/concurrent-conflict', 'original');
  const server = await startApp();
  try {
    const loaded = await fetch(urlFor(server, '/api/note?path=notes%2Fconcurrent-conflict.md'));
    const { version } = await loaded.json();
    await store.writeNote('notes/concurrent-conflict', 'external change');

    const responses = await Promise.all(['local draft one', 'local draft two'].map(async (markdown) => {
      const response = await fetch(urlFor(server, '/api/note'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: 'notes/concurrent-conflict.md',
          markdown,
          baseVersion: version,
        }),
      });
      return { status: response.status, body: await response.json() };
    }));

    assert.deepEqual(responses.map(({ status }) => status), [409, 409]);
    const conflictPaths = responses.map(({ body }) => body.conflictPath);
    assert.equal(new Set(conflictPaths).size, 2);
    const savedDrafts = await Promise.all(conflictPaths.map(async (conflictPath) => (
      (await store.readNote(conflictPath)).content.trim()
    )));
    assert.deepEqual(savedDrafts.sort(), ['local draft one', 'local draft two']);
    assert.match((await store.readNote('notes/concurrent-conflict')).content, /external change/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('malformed base versions return 400 without creating conflict copies', async () => {
  await store.writeNote('notes/invalid-version', 'original');
  const server = await startApp();
  try {
    const response = await fetch(urlFor(server, '/api/note'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'notes/invalid-version.md',
        markdown: 'local draft',
        baseVersion: 'not-a-sha256',
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(
      (await readdir(path.join(dir, 'notes')))
        .some((name) => name.startsWith('invalid-version-conflict-local')),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('legacy saves without a base version remain supported', async () => {
  const server = await startApp();
  try {
    const response = await fetch(urlFor(server, '/api/note'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'notes/legacy.md', markdown: 'legacy body' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.path, 'notes/legacy.md');
    assert.match((await store.readNote('notes/legacy')).content, /legacy body/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
