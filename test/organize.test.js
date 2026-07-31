import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { tidyMarkdown } from '../src/core/organize.js';

test('tidyMarkdown organizes every part of an article longer than one request', async () => {
  const calls = [];
  const content = `${'甲'.repeat(15_900)}\n\n${'乙'.repeat(15_900)}\n\n文章结尾`;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      calls.push(payload.messages);
      const output = payload.messages.at(-1).content.split('\nRaw content:\n').at(-1);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const previous = {
    baseUrl: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
  };
  process.env.LLM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_MODEL = 'test-model';
  try {
    const result = await tidyMarkdown({ title: '长文', content });

    assert.ok(calls.length >= 6);
    for (const messages of calls) {
      const raw = messages.at(-1).content.split('\nRaw content:\n').at(-1);
      assert.ok(raw.length <= 6_000);
    }
    assert.match(result, /文章结尾$/);
    assert.equal(result.replace(/\n+/g, ''), content.replace(/\n+/g, ''));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries({
      LLM_BASE_URL: previous.baseUrl,
      LLM_API_KEY: previous.apiKey,
      LLM_MODEL: previous.model,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
