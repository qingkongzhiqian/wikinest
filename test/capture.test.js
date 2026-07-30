import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir;
let capture;
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
  dir = await mkdtemp(path.join(tmpdir(), 'wiki-capture-'));
  process.env.WIKI_CONTENT_DIR = dir;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
  store = await import('../src/core/store.js');
  capture = await import('../src/core/capture.js');
  ({ createApp } = await import('../src/web/server.js'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('capture URL normalization removes fragments and tracking parameters', () => {
  assert.equal(
    capture.normalizeCaptureUrl('HTTPS://Example.COM/path/?b=2&utm_source=x&a=1#part'),
    'https://example.com/path?a=1&b=2',
  );
  assert.throws(() => capture.normalizeCaptureUrl('file:///tmp/private'), /HTTP or HTTPS/);
});

test('bookmarks use an independent kind and dedupe canonical URLs', async () => {
  const first = await capture.saveBookmark({
    url: 'https://example.com/read?utm_source=newsletter',
    title: 'Read later',
    description: 'A useful page',
  }, { now: new Date('2026-07-27T03:00:00.000Z') });
  const duplicate = await capture.saveBookmark({
    url: 'https://example.com/read',
    title: 'Same page',
  }, { now: new Date('2026-07-27T04:00:00.000Z') });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.path, first.path);
  const note = await store.readNote(first.path);
  assert.equal(note.data.kind, 'bookmark');
  assert.equal(note.data.canonicalUrl, 'https://example.com/read');
  assert.deepEqual(await store.listCategories(), []);
  assert.match(note.content, /https:\/\/example\.com\/read/);
});

test('web clips preserve original content and optional generated sections', async () => {
  const result = await capture.saveWebClip({
    sourceUrl: 'https://example.com/article#section',
    sourceTitle: 'Source article',
    captureMode: 'selection',
    originalMarkdown: 'Original claim.',
    translation: '翻译内容。',
    translatedTo: 'Simplified Chinese',
    summary: 'Short summary.',
    keyPoints: '- Point one',
    userNote: 'Remember this.',
  }, { now: new Date('2026-07-27T05:00:00.000Z') });
  const duplicate = await capture.saveWebClip({
    sourceUrl: 'https://example.com/article',
    sourceTitle: 'Renamed source',
    captureMode: 'selection',
    originalMarkdown: 'Original claim.',
  });

  assert.equal(result.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  const note = await store.readNote(result.path);
  assert.equal(note.data.kind, 'web_clip');
  assert.equal(note.data.captureMode, 'selection');
  assert.match(note.content, /## 原文[\s\S]*Original claim\./);
  assert.match(note.content, /## 翻译[\s\S]*翻译内容。/);
  assert.match(note.content, /## 我的备注[\s\S]*Remember this\./);
});

test('capture APIs expose kinds separately and extension origins receive CORS', async () => {
  const server = await startApp();
  try {
    const response = await fetch(urlFor(server, '/api/bookmarks'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'chrome-extension://abcdefghijklmnop',
      },
      body: JSON.stringify({
        url: 'https://wikinest.example/docs',
        title: 'Wikinest docs',
      }),
    });
    assert.equal(response.status, 201);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      'chrome-extension://abcdefghijklmnop',
    );

    const indexResponse = await fetch(urlFor(server, '/api/index'));
    const index = await indexResponse.json();
    assert.ok(index.some((item) => item.kind === 'bookmark' && item.domain === 'wikinest.example'));

    const aiResponse = await fetch(urlFor(server, '/api/clips/translate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', targetLanguage: 'Chinese' }),
    });
    assert.equal(aiResponse.status, 400);
    assert.equal((await aiResponse.json()).code, 'LLM_NOT_CONFIGURED');

    const askResponse = await fetch(urlFor(server, '/api/clips/ask'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'quoted text', question: 'What does this mean?' }),
    });
    assert.equal(askResponse.status, 400);
    assert.equal((await askResponse.json()).code, 'LLM_NOT_CONFIGURED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

const FAKE_LLM = { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' };

// Answer only the chat completion call so the express requests keep working.
async function withStubbedChat(reply, run) {
  const original = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(FAKE_LLM.baseUrl)) return original(input, init);
    prompts.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: reply } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    return { result: await run(), prompts };
  } finally {
    globalThis.fetch = original;
  }
}

test('bookmarks get a generated summary and tags without user input', async () => {
  const { path: saved } = await capture.saveBookmark({
    url: 'https://research.example/attention-is-all-you-need',
    title: 'Attention Is All You Need',
    description: 'The transformer paper.',
  });

  const { result, prompts } = await withStubbedChat(
    JSON.stringify({
      summary: 'The paper that introduced the transformer architecture.',
      tags: ['机器学习', '论文', '机器学习', ' ', 'a', 'b', 'c', 'd'],
    }),
    () => capture.enrichBookmark(saved, { llm: FAKE_LLM }),
  );

  assert.equal(result.summary, 'The paper that introduced the transformer architecture.');
  assert.deepEqual(result.tags, ['机器学习', '论文', 'a', 'b', 'c']);
  assert.match(prompts[0].messages[1].content, /Attention Is All You Need/);

  const note = await store.readNote(saved);
  assert.equal(note.data.summary, result.summary);
  assert.deepEqual(note.data.tags, result.tags);
  // Enrichment is idempotent: an already labelled bookmark is left alone.
  assert.deepEqual(
    await capture.enrichBookmark(saved, { llm: FAKE_LLM }),
    { summary: result.summary, tags: result.tags },
  );
  assert.ok(
    (await capture.listBookmarkTags()).some((t) => t.name === '论文' && t.count === 1),
  );
});

test('generated bookmark labels are offered to the model and reach search', async () => {
  const { path: saved } = await capture.saveBookmark({
    url: 'https://research.example/second-paper',
    title: 'Another paper',
  });
  const { prompts } = await withStubbedChat(
    JSON.stringify({ summary: 'A follow-up study.', tags: ['论文'] }),
    () => capture.enrichBookmark(saved, { llm: FAKE_LLM }),
  );
  assert.match(prompts[0].messages[1].content, /Existing tags:.*论文/);

  const hits = await store.searchNotes('论文');
  assert.ok(hits.some((hit) => hit.path === saved));
});

test('bookmark enrichment stays best-effort when no model is configured', async () => {
  const { path: saved } = await capture.saveBookmark({
    url: 'https://research.example/no-model',
    title: 'No model here',
  });
  assert.equal(await capture.autoEnrichBookmark(saved), null);
  assert.equal((await store.readNote(saved)).data.summary, undefined);
});

test('the index exposes bookmark tags and prefers the generated summary', async () => {
  const server = await startApp();
  try {
    const index = await (await fetch(urlFor(server, '/api/index'))).json();
    const item = index.find((i) => i.url === 'https://research.example/attention-is-all-you-need');
    assert.deepEqual(item.tags, ['机器学习', '论文', 'a', 'b', 'c']);
    assert.equal(item.desc, 'The paper that introduced the transformer architecture.');

    const tags = await (await fetch(urlFor(server, '/api/bookmarks/tags'))).json();
    assert.ok(tags.some((t) => t.name === '论文' && t.count === 2));

    const enrich = await fetch(urlFor(server, '/api/bookmarks/enrich'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: item.path }),
    });
    assert.equal(enrich.status, 400);
    assert.equal((await enrich.json()).code, 'LLM_NOT_CONFIGURED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('categories reject bookmark and clip files', async () => {
  const bookmark = (await capture.saveBookmark({
    url: 'https://example.net',
    title: 'No categories',
  })).path;
  await assert.rejects(
    store.setNoteCategories(bookmark, ['research']),
    /only available for knowledge notes/,
  );
});
