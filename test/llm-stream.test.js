import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { classifyAiError } from '../src/core/ai-errors.js';
import { chatStream } from '../src/core/llm.js';

const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const originalEnv = {
  baseUrl: process.env.LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY,
  model: process.env.LLM_MODEL,
};

function streamResponse(chunks, { status = 200 } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

beforeEach(() => {
  process.env.LLM_BASE_URL = 'https://llm.example/v1/';
  process.env.LLM_API_KEY = 'secret';
  process.env.LLM_MODEL = 'test-model';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries({
    LLM_BASE_URL: originalEnv.baseUrl,
    LLM_API_KEY: originalEnv.apiKey,
    LLM_MODEL: originalEnv.model,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('chatStream yields text deltas across split SSE chunks', async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return streamResponse([
      'data: {"choices":[{"delta":{"content":"你',
      '好"}}]}\n\ndata: [DONE]\n\n',
    ]);
  };

  const result = await collect(chatStream(
    [{ role: 'user', content: 'x' }],
    { temperature: 0.7 },
  ));

  assert.deepEqual(result, ['你好']);
  assert.equal(request.url, 'https://llm.example/v1/chat/completions');
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'test-model',
    temperature: 0.7,
    enable_thinking: false,
    messages: [{ role: 'user', content: 'x' }],
    stream: true,
  });
});

test('chatStream parses multiple data events from one chunk and stops at DONE', async () => {
  globalThis.fetch = async () => streamResponse([
    'data: {"choices":[{"delta":{"content":"A"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"B"}}]}\n\n'
      + 'data: [DONE]\n\n'
      + 'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
  ]);

  assert.deepEqual(
    await collect(chatStream([{ role: 'user', content: 'x' }])),
    ['A', 'B'],
  );
});

test('chatStream extracts only whitelisted provider error metadata', async () => {
  const secrets = 'sk-secret PRIVATE_VAULT https://private.example Error: leaked stack';
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      code: 'limit_requests',
      message: secrets,
      stack: secrets,
    },
    raw: secrets,
  }), {
    status: 429,
    headers: { 'retry-after': '12' },
  });

  await assert.rejects(
    async () => collect(chatStream([{ role: 'user', content: 'x' }])),
    (error) => {
      assert.deepEqual(classifyAiError(error), {
        code: 'RATE_LIMITED',
        status: 429,
        retryAfterSeconds: 12,
      });
      assert.deepEqual(Object.keys(error).sort(), [
        'kind',
        'providerCode',
        'retryAfterSeconds',
        'status',
      ]);
      assert.doesNotMatch(JSON.stringify(error), /sk-secret|PRIVATE_VAULT|private\.example|leaked stack/);
      return true;
    },
  );
});

test('chatStream caps provider error bodies at 64 KiB and cancels the reader', async () => {
  const body = JSON.stringify({
    error: {
      code: 'rate_limit_exceeded',
      message: `PRIVATE_VAULT ${'x'.repeat(80 * 1024)}`,
    },
  });
  const chunks = [
    encoder.encode(body.slice(0, 40 * 1024)),
    encoder.encode(body.slice(40 * 1024)),
  ];
  let index = 0;
  let cancelled = false;
  let released = false;
  let textCalled = false;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    headers: { get: () => null },
    text: async () => {
      textCalled = true;
      return body;
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index < chunks.length) return { done: false, value: chunks[index++] };
            return { done: true, value: undefined };
          },
          async cancel() {
            cancelled = true;
            throw new Error('bounded cancel failed');
          },
          releaseLock() {
            released = true;
          },
        };
      },
    },
  });

  await assert.rejects(
    async () => collect(chatStream([{ role: 'user', content: 'x' }])),
    (error) => {
      assert.deepEqual(classifyAiError(error), {
        code: 'AI_FAILED',
        status: 503,
      });
      assert.doesNotMatch(
        [error.message, error.stack, error.cause, ...Object.values(error)].join('\n'),
        /PRIVATE_VAULT/,
      );
      return true;
    },
  );
  assert.equal(textCalled, false);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('chatStream ignores non-whitelisted nesting and truncated provider JSON codes', async (t) => {
  const cases = [
    ['metadata.code', JSON.stringify({ metadata: { code: 'rate_limit_exceeded' } })],
    ['message.code', JSON.stringify({ message: { code: 'rate_limit_exceeded' } })],
    ['truncated error.code', '{"error":{"code":"rate_limit_exceeded","message":"cut off'],
  ];
  for (const [name, body] of cases) {
    await t.test(name, async () => {
      globalThis.fetch = async () => new Response(body, { status: 503 });
      await assert.rejects(
        async () => collect(chatStream([{ role: 'user', content: 'x' }])),
        (error) => {
          assert.deepEqual(classifyAiError(error), {
            code: 'AI_FAILED',
            status: 503,
          });
          return true;
        },
      );
    });
  }
});

test('chatStream normalizes Retry-After dates with a fixed clock and rejects unsafe values', async (t) => {
  const originalDateNow = Date.now;
  const now = Date.parse('2026-07-22T10:00:00Z');
  Date.now = () => now;
  try {
    const cases = [
      ['valid HTTP date', new Date(now + 60_000).toUTCString(), 60],
      ['invalid date', 'not-a-date', undefined],
      ['over seven days', new Date(now + (7 * 24 * 60 * 60 + 1) * 1000).toUTCString(), undefined],
    ];
    for (const [name, retryAfter, expected] of cases) {
      await t.test(name, async () => {
        globalThis.fetch = async () => new Response(
          JSON.stringify({ error: { code: 'limit_requests' } }),
          { status: 429, headers: { 'retry-after': retryAfter } },
        );
        await assert.rejects(
          async () => collect(chatStream([{ role: 'user', content: 'x' }])),
          (error) => {
            assert.equal(classifyAiError(error).retryAfterSeconds, expected);
            return true;
          },
        );
      });
    }
  } finally {
    Date.now = originalDateNow;
  }
});

test('chatStream never retains provider error details after parsing', async () => {
  const apiKey = 'sk-real.secret+$';
  process.env.LLM_API_KEY = apiKey;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      code: 'invalid_api_key',
      message: `invalid key ${apiKey}; vault=PRIVATE_NOTE; endpoint=https://private.example`,
    }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );

  await assert.rejects(
    async () => collect(chatStream([{ role: 'user', content: 'x' }])),
    (error) => {
      assert.deepEqual(classifyAiError(error), {
        code: 'AUTH_FAILED',
        status: 401,
      });
      assert.doesNotMatch(JSON.stringify(error), /sk-real|PRIVATE_NOTE|private\.example|invalid key/);
      return true;
    },
  );
});

test('chatStream preserves caller cancellation as an abort path', async () => {
  const caller = new AbortController();
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
    caller.abort();
  });

  await assert.rejects(
    async () => collect(chatStream(
      [{ role: 'user', content: 'x' }],
      { timeoutMs: 1234, signal: caller.signal },
    )),
    { name: 'AbortError' },
  );
});

test('caller cancellation stays an abort even if transport rejection is delayed past timeout', async () => {
  const caller = new AbortController();
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      setTimeout(() => {
        reject(Object.assign(new Error('delayed abort'), { name: 'AbortError' }));
      }, 15);
    }, { once: true });
    caller.abort();
  });

  await assert.rejects(
    async () => collect(chatStream(
      [{ role: 'user', content: 'x' }],
      { timeoutMs: 5, signal: caller.signal },
    )),
    { name: 'AbortError' },
  );
});

test('chatStream distinguishes its timeout from caller cancellation', async () => {
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('provider timeout details'), { name: 'AbortError' }));
    }, { once: true });
  });

  await assert.rejects(
    async () => collect(chatStream(
      [{ role: 'user', content: 'x' }],
      { timeoutMs: 5 },
    )),
    (error) => {
      assert.deepEqual(classifyAiError(error), { code: 'UPSTREAM_TIMEOUT' });
      assert.doesNotMatch(JSON.stringify(error), /provider timeout details/);
      return true;
    },
  );
});

test('chatStream classifies network failures without retaining transport messages', async () => {
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED https://private.example key=sk-secret');
  };

  await assert.rejects(
    async () => collect(chatStream([{ role: 'user', content: 'x' }])),
    (error) => {
      assert.deepEqual(classifyAiError(error), { code: 'NETWORK_ERROR' });
      assert.doesNotMatch(JSON.stringify(error), /private\.example|sk-secret|ECONNREFUSED/);
      return true;
    },
  );
});

test('chatStream ignores malformed and non-content SSE events', async () => {
  globalThis.fetch = async () => streamResponse([
    ': keepalive\n\n'
      + 'event: ping\n\n'
      + 'data: not-json\n\n'
      + 'data: {"choices":[]}\n\n'
      + 'data: {"choices":[{"delta":{"content":42}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
      + 'data: [DONE]\n\n',
  ]);

  assert.deepEqual(
    await collect(chatStream([{ role: 'user', content: 'x' }])),
    ['ok'],
  );
});

test('chatStream allows exactly 1,000,000 streamed characters before DONE', async () => {
  const exact = 'x'.repeat(1_000_000);
  globalThis.fetch = async () => streamResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: exact } }] })}\n\n`,
    'data: [DONE]\n\n',
  ]);

  const result = await collect(chatStream([{ role: 'user', content: 'x' }]));
  assert.equal(result.length, 1);
  assert.equal(result[0].length, 1_000_000);
});

test('chatStream interrupts and cancels when streamed output exceeds 1,000,000 characters by one', async () => {
  const oversized = 'x'.repeat(1_000_001);
  let cancelled = false;
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        let read = false;
        return {
          async read() {
            if (read) return { done: true, value: undefined };
            read = true;
            return {
              done: false,
              value: encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: oversized } }] })}\n\n`,
              ),
            };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    },
  });

  await assert.rejects(
    async () => collect(chatStream([{ role: 'user', content: 'x' }])),
    (error) => {
      assert.deepEqual(classifyAiError(error), { code: 'STREAM_INTERRUPTED' });
      return true;
    },
  );
  assert.equal(cancelled, true);
});

test('chatStream interrupts when multiple legal frames cumulatively exceed 1,000,000 characters', async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'a'.repeat(400_000) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'b'.repeat(300_000) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'c'.repeat(300_000) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'd' } }] })}\n\n`,
  ];
  let index = 0;
  let cancelled = false;
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index < frames.length) {
              return { done: false, value: encoder.encode(frames[index++]) };
            }
            return { done: true, value: undefined };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    },
  });

  await assert.rejects(
    async () => collect(chatStream([{ role: 'user', content: 'x' }])),
    (error) => {
      assert.deepEqual(classifyAiError(error), { code: 'STREAM_INTERRUPTED' });
      return true;
    },
  );
  assert.equal(cancelled, true);
});

test('chatStream still interrupts and cancels when an oversized legal delta is followed by DONE', async () => {
  const oversized = 'x'.repeat(1_000_001);
  let cancelled = false;
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        let read = false;
        return {
          async read() {
            if (read) return { done: true, value: undefined };
            read = true;
            return {
              done: false,
              value: encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: oversized } }] })}\n\n`
                + 'data: [DONE]\n\n',
              ),
            };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    },
  });

  await assert.rejects(
    async () => collect(chatStream([{ role: 'user', content: 'x' }])),
    (error) => {
      assert.deepEqual(classifyAiError(error), { code: 'STREAM_INTERRUPTED' });
      return true;
    },
  );
  assert.equal(cancelled, true);
});

test('chatStream interrupts on an oversized final SSE frame without a trailing separator', async () => {
  const oversized = 'x'.repeat(1_000_001);
  let cancelled = false;
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        let read = false;
        return {
          async read() {
            if (read) return { done: true, value: undefined };
            read = true;
            return {
              done: false,
              value: encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: oversized } }] })}`,
              ),
            };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    },
  });

  await assert.rejects(
    async () => collect(chatStream([{ role: 'user', content: 'x' }])),
    (error) => {
      assert.deepEqual(classifyAiError(error), { code: 'STREAM_INTERRUPTED' });
      return true;
    },
  );
  assert.equal(cancelled, true);
});

test('chatStream interrupts and cancels when an unterminated SSE buffer exceeds 1 MiB', async () => {
  const chunks = Array.from({ length: 4 }, () => encoder.encode('x'.repeat(300 * 1024)));
  let index = 0;
  let cancelled = false;
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index < chunks.length) return { done: false, value: chunks[index++] };
            throw new Error('read beyond buffer limit');
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    },
  });

  await assert.rejects(
    async () => collect(chatStream([{ role: 'user', content: 'x' }])),
    (error) => {
      assert.deepEqual(classifyAiError(error), { code: 'STREAM_INTERRUPTED' });
      return true;
    },
  );
  assert.equal(cancelled, true);
});

test('chatStream interrupts a single SSE frame larger than 1 MiB before another read', async () => {
  const oversizedFrame = encoder.encode(`data: ${'x'.repeat(1024 * 1024 + 1)}\n\n`);
  let reads = 0;
  let cancelled = false;
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            reads += 1;
            if (reads === 1) return { done: false, value: oversizedFrame };
            throw new Error('read beyond frame limit');
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    },
  });

  await assert.rejects(
    async () => collect(chatStream([{ role: 'user', content: 'x' }])),
    (error) => {
      assert.deepEqual(classifyAiError(error), { code: 'STREAM_INTERRUPTED' });
      return true;
    },
  );
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
});

test('chatStream rejects a natural EOF without a completion signal', async () => {
  globalThis.fetch = async () => streamResponse([
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
  ]);

  await assert.rejects(
    async () => collect(chatStream([{ role: 'user', content: 'x' }])),
    (error) => {
      assert.deepEqual(classifyAiError(error), { code: 'STREAM_INTERRUPTED' });
      return true;
    },
  );
});

test('chatStream accepts a DONE tail frame split across chunks without a final separator', async () => {
  globalThis.fetch = async () => streamResponse([
    'data: {"choices":[{"delta":{"content":"complete"}}]}\n\n',
    'data: [DO',
    'NE]',
  ]);

  assert.deepEqual(
    await collect(chatStream([{ role: 'user', content: 'x' }])),
    ['complete'],
  );
});

test('chatStream accepts an explicit finish_reason completion signal', async () => {
  globalThis.fetch = async () => streamResponse([
    'data: {"choices":[{"delta":{"content":"complete"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  ]);

  assert.deepEqual(
    await collect(chatStream([{ role: 'user', content: 'x' }])),
    ['complete'],
  );
});

test('chatStream cancels the response reader when iteration ends early', async () => {
  let cancelled = false;
  let released = false;
  let read = false;
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (!read) {
              read = true;
              return {
                done: false,
                value: encoder.encode(
                  'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
                ),
              };
            }
            return new Promise(() => {});
          },
          async cancel() {
            cancelled = true;
            throw new Error('cancel failed');
          },
          releaseLock() {
            released = true;
          },
        };
      },
    },
  });

  for await (const value of chatStream([{ role: 'user', content: 'x' }])) {
    assert.equal(value, 'first');
    break;
  }

  assert.equal(cancelled, true);
  assert.equal(released, true);
});
