import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/web/server.js';
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
