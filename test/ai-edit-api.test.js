import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { createApp, writeSseEvent } from '../src/web/server.js';

const ENV_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_TIMEOUT_MS'];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(previous) {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function startTestServer() {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

function urlFor(server, pathname = '') {
  return `http://127.0.0.1:${server.address().port}${pathname}`;
}

function validBody(overrides = {}) {
  return {
    mode: 'selection',
    messages: [{ role: 'user', content: '重写' }],
    selection: '原文',
    noteContent: '# 标题\n原文',
    includeNote: false,
    ...overrides,
  };
}

function configuredFor(upstream, apiKey = 'test-secret') {
  process.env.LLM_BASE_URL = urlFor(upstream, '/v1');
  process.env.LLM_API_KEY = apiKey;
  process.env.LLM_MODEL = 'test-model';
  process.env.LLM_TIMEOUT_MS = '2000';
}

function createFakeSseResponse(writeResult) {
  const res = new EventEmitter();
  const writes = [];
  let destroyed = false;
  let writableEnded = false;
  res.write = (chunk) => {
    writes.push(chunk);
    return typeof writeResult === 'function' ? writeResult(chunk) : writeResult;
  };
  res.end = () => {
    writableEnded = true;
  };
  Object.defineProperty(res, 'destroyed', {
    get: () => destroyed,
    set: (value) => { destroyed = value; },
  });
  Object.defineProperty(res, 'writableEnded', {
    get: () => writableEnded,
    set: (value) => { writableEnded = value; },
  });
  return { res, writes };
}

test('writeSseEvent waits for drain only when write returns false and cleans up listeners', async () => {
  let writes = 0;
  const { res } = createFakeSseResponse(() => {
    writes += 1;
    return writes === 1 ? false : true;
  });
  const controller = new AbortController();
  let upstreamAborts = 0;
  let settled = false;

  const pending = writeSseEvent(res, 'delta', { text: 'slow' }, {
    signal: controller.signal,
    onAbort: () => { upstreamAborts += 1; },
  }).then((value) => {
    settled = true;
    return value;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(res.listenerCount('drain'), 1);
  assert.equal(res.listenerCount('close'), 1);

  res.emit('drain');
  assert.equal(await pending, true);
  assert.equal(upstreamAborts, 0);
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('writeSseEvent does not treat undefined as backpressure', async () => {
  const { res } = createFakeSseResponse(undefined);
  const controller = new AbortController();
  let upstreamAborts = 0;

  assert.equal(await writeSseEvent(res, 'delta', { text: 'fast' }, {
    signal: controller.signal,
    onAbort: () => { upstreamAborts += 1; },
  }), true);
  assert.equal(upstreamAborts, 0);
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('writeSseEvent aborts a slow upstream write on response close or AbortSignal', async (t) => {
  await t.test('response close', async () => {
    const { res } = createFakeSseResponse(false);
    const controller = new AbortController();
    let upstreamAborts = 0;
    const pending = writeSseEvent(res, 'delta', { text: 'close' }, {
      signal: controller.signal,
      onAbort: () => { upstreamAborts += 1; },
    });

    res.emit('close');
    assert.equal(await pending, false);
    assert.equal(upstreamAborts, 1);
    assert.equal(res.listenerCount('drain'), 0);
    assert.equal(res.listenerCount('close'), 0);
  });

  await t.test('abort signal', async () => {
    const { res } = createFakeSseResponse(false);
    const controller = new AbortController();
    let upstreamAborts = 0;
    const pending = writeSseEvent(res, 'delta', { text: 'abort' }, {
      signal: controller.signal,
      onAbort: () => { upstreamAborts += 1; },
    });

    controller.abort();
    assert.equal(await pending, false);
    assert.equal(upstreamAborts, 1);
    assert.equal(res.listenerCount('drain'), 0);
    assert.equal(res.listenerCount('close'), 0);
  });
});

test('AI edit status reports disabled when LLM configuration is missing', async () => {
  const previous = snapshotEnv();
  for (const key of ENV_KEYS) delete process.env[key];
  const server = await startTestServer();

  try {
    const response = await fetch(urlFor(server, '/api/ai/edit/status'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: false });
  } finally {
    await closeServer(server);
    restoreEnv(previous);
  }
});

test('AI edit chat rejects invalid bodies as JSON before committing SSE headers', async (t) => {
  const previous = snapshotEnv();
  const upstream = await listen((_req, res) => {
    res.writeHead(500);
    res.end('must not be called');
  });
  configuredFor(upstream);
  const server = await startTestServer();

  try {
    const cases = [
      ['messages', validBody({ messages: null })],
      ['selection', validBody({ selection: '   ' })],
      ['document', validBody({ mode: 'document', selection: '', noteContent: '   ' })],
      ['mode', validBody({ mode: 'vault' })],
      ['contextMode', validBody({
        messages: [{ role: 'user', content: '重写', contextMode: 'vault' }],
      })],
      ['noteContent', validBody({ noteContent: null })],
      ['includeNote', validBody({ includeNote: 'yes' })],
    ];
    for (const [name, body] of cases) {
      await t.test(name, async () => {
        const response = await fetch(urlFor(server, '/api/ai/edit/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
        assert.match(response.headers.get('content-type'), /^application\/json\b/);
        assert.doesNotMatch(response.headers.get('content-type'), /text\/event-stream/);
        assert.equal(typeof (await response.json()).error, 'string');
      });
    }
  } finally {
    await closeServer(server);
    await closeServer(upstream);
    restoreEnv(previous);
  }
});

test('AI edit chat accepts document and general modes with mode-specific context', async () => {
  const previous = snapshotEnv();
  const requests = [];
  const upstream = await listen((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
  });
  configuredFor(upstream);
  const server = await startTestServer();

  try {
    for (const body of [
      validBody({
        mode: 'document',
        messages: [{ role: 'user', content: '总结这篇笔记' }],
        selection: '',
        noteContent: '# 标题\n正文',
      }),
      validBody({
        mode: 'general',
        messages: [
          { role: 'user', content: '选区问题', contextMode: 'selection' },
          { role: 'assistant', content: '选区回答', contextMode: 'selection' },
          { role: 'user', content: '通用问题', contextMode: 'general' },
          { role: 'assistant', content: '通用回答', contextMode: 'general' },
          { role: 'user', content: '解释 Markdown 表格', contextMode: 'document' },
        ],
        selection: 'PRIVATE_SELECTION',
        noteContent: 'PRIVATE_NOTE',
        includeNote: true,
      }),
    ]) {
      const response = await fetch(urlFor(server, '/api/ai/edit/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      assert.match(await response.text(), /event: done\ndata: {}\n\n$/);
    }

    const documentRequest = requests[0].messages.at(-1).content;
    assert.equal(documentRequest, '用户指令：\n总结这篇笔记\n\n当前文档：\n# 标题\n正文');
    const generalRequest = requests[1].messages.at(-1).content;
    assert.equal(generalRequest, '用户指令：\n解释 Markdown 表格');
    assert.doesNotMatch(generalRequest, /PRIVATE_SELECTION|PRIVATE_NOTE/);
    assert.deepEqual(requests[1].messages.slice(1, -1), [
      { role: 'user', content: '通用问题' },
      { role: 'assistant', content: '通用回答' },
    ]);
    assert.equal(
      requests[1].messages.some((message) => Object.hasOwn(message, 'contextMode')),
      false,
    );
  } finally {
    await closeServer(server);
    await closeServer(upstream);
    restoreEnv(previous);
  }
});

test('AI edit chat streams JSON-escaped deltas followed by exactly one done event', async () => {
  const previous = snapshotEnv();
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"重写\\n\\"结果\\""}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  configuredFor(upstream);
  const server = await startTestServer();

  try {
    const response = await fetch(urlFor(server, '/api/ai/edit/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
    });
    const wire = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.match(wire, /event: delta\ndata: {"text":"重写\\n\\"结果\\""}\n\n/);
    assert.equal((wire.match(/event: done/g) || []).length, 1);
    assert.match(wire, /event: done\ndata: {}\n\n$/);
  } finally {
    await closeServer(server);
    await closeServer(upstream);
    restoreEnv(previous);
  }
});

test('AI edit chat reports an interrupted upstream stream without sending done', async () => {
  const previous = snapshotEnv();
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  configuredFor(upstream);
  const server = await startTestServer();

  try {
    const response = await fetch(urlFor(server, '/api/ai/edit/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
    });
    const wire = await response.text();

    assert.match(wire, /event: delta\ndata: {"text":"partial"}\n\n/);
    assert.match(
      wire,
      /event: error\ndata: {"code":"STREAM_INTERRUPTED","requestId":"[^"]+"}\n\n$/,
    );
    assert.doesNotMatch(wire, /event: done/);
  } finally {
    await closeServer(server);
    await closeServer(upstream);
    restoreEnv(previous);
  }
});

test('AI edit chat sends error not done when an oversized legal delta is followed by DONE', async () => {
  const previous = snapshotEnv();
  const oversized = 'x'.repeat(1_000_001);
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: oversized } }] })}\n\n`
      + 'data: [DONE]\n\n',
    );
  });
  configuredFor(upstream);
  const server = await startTestServer();

  try {
    const response = await fetch(urlFor(server, '/api/ai/edit/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
    });
    const wire = await response.text();

    assert.match(
      wire,
      /event: error\ndata: {"code":"STREAM_INTERRUPTED","requestId":"[^"]+"}\n\n$/,
    );
    assert.doesNotMatch(wire, /event: done/);
  } finally {
    await closeServer(server);
    await closeServer(upstream);
    restoreEnv(previous);
  }
});

test('disconnecting an AI edit client aborts the upstream request', async () => {
  const previous = snapshotEnv();
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => { resolveUpstreamClosed = resolve; });
  const upstream = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    req.on('aborted', resolveUpstreamClosed);
    res.on('close', resolveUpstreamClosed);
  });
  configuredFor(upstream);
  const server = await startTestServer();
  const originalConsoleError = console.error;
  const diagnostics = [];
  console.error = (...args) => { diagnostics.push(args); };

  try {
    await new Promise((resolve, reject) => {
      const req = http.request(urlFor(server, '/api/ai/edit/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      req.on('error', (error) => {
        if (error.code === 'ECONNRESET') resolve();
        else reject(error);
      });
      req.on('response', (response) => {
        response.once('data', () => {
          response.destroy();
          resolve();
        });
      });
      req.end(JSON.stringify(validBody()));
    });

    await Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('upstream request was not aborted')),
        1000,
      )),
    ]);
    assert.deepEqual(diagnostics, []);
  } finally {
    console.error = originalConsoleError;
    await closeServer(server);
    await closeServer(upstream);
    restoreEnv(previous);
  }
});

test('AI edit SSE and diagnostics expose only whitelisted rate-limit fields', async () => {
  const previous = snapshotEnv();
  const apiKey = 'sk-live.secret+$';
  const providerUrl = 'https://provider.internal.example/v1/chat/completions';
  const vaultText = 'PRIVATE_VAULT_TEXT';
  const unsafeModels = [
    'sk-secret-like-model',
    vaultText,
    'file:/Users/private/model',
    'https://model.internal/private',
  ];
  const providerDetail = `quota exhausted for tenant private-customer-42 ${vaultText}`;
  const upstream = await listen((_req, res) => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '12',
    });
    res.end(JSON.stringify({
      error: {
        code: 'limit_requests',
        message: `${providerDetail}; key=${apiKey}; endpoint=${providerUrl}`,
        stack: `Error: ${providerDetail}\n at ${providerUrl}`,
      },
    }));
  });
  configuredFor(upstream, apiKey);
  const server = await startTestServer();
  const originalConsoleError = console.error;
  const diagnostics = [];
  console.error = (...args) => { diagnostics.push(args); };

  try {
    for (const model of unsafeModels) {
      process.env.LLM_MODEL = model;
      const response = await fetch(urlFor(server, '/api/ai/edit/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validBody()),
      });
      const wire = await response.text();

      assert.equal(response.status, 200);
      assert.match(
        wire,
        /^event: error\ndata: {"code":"RATE_LIMITED","requestId":"[^"]+","retryAfterSeconds":12}\n\n$/,
      );
      assert.doesNotMatch(wire, new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(wire, /provider\.internal\.example/);
      assert.doesNotMatch(wire, /quota exhausted|private-customer-42|PRIVATE_VAULT_TEXT|Error:/);
      assert.equal((wire.match(/event: error/g) || []).length, 1);
    }

    assert.equal(diagnostics.length, unsafeModels.length);
    for (const [label, diagnostic] of diagnostics) {
      assert.equal(label, 'AI edit upstream failure');
      assert.deepEqual(Object.keys(diagnostic).sort(), [
        'code',
        'model',
        'providerHost',
        'requestId',
        'status',
      ]);
      assert.equal(diagnostic.code, 'RATE_LIMITED');
      assert.equal(diagnostic.status, 429);
      assert.equal(diagnostic.model, '[configured]');
      assert.equal(diagnostic.providerHost, '127.0.0.1');
    }
    const serialized = JSON.stringify(diagnostics);
    assert.doesNotMatch(serialized, /sk-live|sk-secret-like|PRIVATE_VAULT_TEXT|file:\/|provider\.internal|model\.internal|quota exhausted|private-customer-42|Error:|at .*:\d+/);
  } finally {
    console.error = originalConsoleError;
    await closeServer(server);
    await closeServer(upstream);
    restoreEnv(previous);
  }
});
