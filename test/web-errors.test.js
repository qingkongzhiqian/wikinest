import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  mkdir, mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import { createApp, startServer } from '../src/web/server.js';
import { rateLimit } from '../src/web/ratelimit.js';

test('unconfigured classification exposes a stable public error code', async () => {
  const keys = [
    'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
    'EMBED_BASE_URL', 'EMBED_API_KEY', 'EMBED_MODEL',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/classify/all`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, 'LLM_NOT_CONFIGURED');
    assert.equal(typeof body.error, 'string');

    const tidy = await fetch(`http://127.0.0.1:${port}/api/tidy/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'note' }),
    });
    assert.equal((await tidy.json()).code, 'LLM_NOT_CONFIGURED');

    const ask = await fetch(`http://127.0.0.1:${port}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'test' }),
    });
    assert.equal((await ask.json()).code, 'RAG_NOT_CONFIGURED');

    const aiEdit = await fetch(`http://127.0.0.1:${port}/api/ai/edit/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '重写' }],
        selection: '原文',
        noteContent: '原文',
        includeNote: false,
      }),
    });
    assert.equal(aiEdit.status, 400);
    assert.match(aiEdit.headers.get('content-type'), /^application\/json\b/);
    assert.equal((await aiEdit.json()).code, 'LLM_NOT_CONFIGURED');

    const invalidSave = await fetch(`http://127.0.0.1:${port}/api/note`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '', content: 'note' }),
    });
    assert.equal((await invalidSave.json()).code, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('rate limiter exposes a stable public error code', () => {
  const middleware = rateLimit({ windowMs: 1000, max: 0, key: () => 'test' });
  let status;
  let body;
  const res = {
    set() {},
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  middleware({ ip: '127.0.0.1' }, res, () => assert.fail('request should be limited'));
  assert.equal(status, 429);
  assert.equal(body.code, 'RATE_LIMITED');
  assert.equal(typeof body.error, 'string');
});

test('missing notes retain the stable 404 response without echoing an absolute Vault path', async () => {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const vaultPath = '/Users/tester/Vault/secret-note.md';
  try {
    const read = await fetch(`http://127.0.0.1:${server.address().port}/api/note?path=${encodeURIComponent(vaultPath)}`);
    const readBody = await read.json();
    assert.equal(read.status, 404);
    assert.deepEqual(readBody, { error: 'not found' });
    assert.equal(JSON.stringify(readBody).includes(vaultPath), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('note filesystem failures return fixed safe JSON without absolute paths or secrets', async () => {
  const contentDir = path.join(process.cwd(), 'content');
  const readFailure = path.join(contentDir, 'read-failure.md');
  const saveFailure = path.join(contentDir, 'save-failure.md');
  await mkdir(readFailure, { recursive: true });
  await mkdir(saveFailure, { recursive: true });
  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const read = await fetch(`http://127.0.0.1:${server.address().port}/api/note?path=read-failure.md`);
    const readBody = await read.json();
    assert.equal(read.status, 400);
    assert.deepEqual(readBody, { code: 'NOTE_READ_FAILED', error: 'Unable to read note' });

    const save = await fetch(`http://127.0.0.1:${server.address().port}/api/note`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'save-failure.md', markdown: 'super-secret' }),
    });
    const saveBody = await save.json();
    assert.equal(save.status, 400);
    assert.deepEqual(saveBody, { code: 'NOTE_SAVE_FAILED', error: 'Unable to save note' });
    for (const body of [readBody, saveBody]) {
      assert.equal(JSON.stringify(body).includes(contentDir), false);
      assert.equal(JSON.stringify(body).includes('super-secret'), false);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(readFailure, { recursive: true, force: true });
    await rm(saveFailure, { recursive: true, force: true });
  }
});

test('editor assets are served only from the injected dist directory', async () => {
  const editorDistDir = await mkdtemp(path.join(os.tmpdir(), 'wikinest-editor-dist-'));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'wikinest-editor-outside-'));
  await writeFile(path.join(editorDistDir, 'editor.js'), 'console.log("editor");');
  await writeFile(path.join(editorDistDir, '.secret'), 'hidden');
  await writeFile(path.join(outsideRoot, 'secret.txt'), 'secret');

  const app = createApp({ editorDistDir });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const { port } = server.address();
    const served = await fetch(`http://127.0.0.1:${port}/editor-assets/editor.js`);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), 'console.log("editor");');

    const traversed = await fetch(`http://127.0.0.1:${port}/editor-assets/${encodeURIComponent('../secret.txt')}`);
    assert.equal(traversed.status, 404);

    const missing = await fetch(`http://127.0.0.1:${port}/editor-assets/missing.js`);
    assert.equal(missing.status, 404);

    const dotfile = await fetch(`http://127.0.0.1:${port}/editor-assets/.secret`);
    assert.ok(dotfile.status === 403 || dotfile.status === 404);
    assert.equal(await dotfile.text(), '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('default editor asset directory resolves inside the repository', async () => {
  const editorDistDir = path.resolve(process.cwd(), 'web-dist/editor');
  const assetName = `default-route-${process.pid}.js`;
  const assetPath = path.join(editorDistDir, assetName);
  await mkdir(editorDistDir, { recursive: true });
  await writeFile(assetPath, 'export const loaded = true;');

  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/editor-assets/${assetName}`,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'export const loaded = true;');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(assetPath, { force: true });
  }
});
