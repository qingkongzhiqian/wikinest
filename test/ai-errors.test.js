import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyAiError,
  createAiUpstreamError,
  toPublicAiError,
} from '../src/core/ai-errors.js';

const SECRETS = [
  'sk-live-super-secret',
  'PRIVATE_VAULT_TEXT',
  'https://provider.internal.example/v1/chat/completions?tenant=secret',
  'at privateFunction (/private/provider.js:42:7)',
];

function assertSafe(value) {
  const serialized = JSON.stringify(value);
  for (const secret of SECRETS) assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(Object.hasOwn(value, 'message'), false);
  assert.equal(Object.hasOwn(value, 'body'), false);
  assert.equal(Object.hasOwn(value, 'raw'), false);
  assert.equal(Object.hasOwn(value, 'stack'), false);
}

function assertNoSecretOnAnySurface(value) {
  const surfaces = [
    value?.message,
    value?.stack,
    value?.cause,
    ...Object.getOwnPropertyNames(value || {}),
    ...Object.getOwnPropertyNames(value || {}).map((name) => value[name]),
  ];
  const inspected = surfaces.map((item) => {
    if (typeof item === 'string') return item;
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  }).join('\n');
  for (const secret of SECRETS) {
    assert.doesNotMatch(
      inspected,
      new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
}

test('classifies rate limits with whitelisted retry metadata', () => {
  assert.deepEqual(
    classifyAiError(createAiUpstreamError('http', {
      status: 429,
      providerCode: 'limit_requests',
      retryAfterSeconds: 12,
    })),
    { code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 12 },
  );
});

test('classifies authentication, model, request, transport, stream and unknown failures', async (t) => {
  const cases = [
    ['401 authentication', createAiUpstreamError('http', { status: 401 }), 'AUTH_FAILED'],
    ['403 authentication', createAiUpstreamError('http', { status: 403 }), 'AUTH_FAILED'],
    ['model provider code', createAiUpstreamError('http', {
      status: 404,
      providerCode: 'model_not_found',
    }), 'MODEL_NOT_FOUND'],
    ['invalid request', createAiUpstreamError('http', { status: 400 }), 'REQUEST_INVALID'],
    ['timeout', createAiUpstreamError('timeout'), 'UPSTREAM_TIMEOUT'],
    ['network', createAiUpstreamError('network'), 'NETWORK_ERROR'],
    ['interrupted stream', createAiUpstreamError('interrupted'), 'STREAM_INTERRUPTED'],
    ['unknown', new Error('private provider message'), 'AI_FAILED'],
  ];

  for (const [name, error, code] of cases) {
    await t.test(name, () => assert.equal(classifyAiError(error).code, code));
  }
});

test('structured and public errors retain no provider body, message, URL, key or stack', () => {
  const error = createAiUpstreamError('http', {
    status: 429,
    providerCode: 'limit_requests',
    retryAfterSeconds: 4,
    message: SECRETS.join(' '),
    body: SECRETS.join(' '),
    raw: SECRETS.join(' '),
    stack: SECRETS.join(' '),
    url: SECRETS[2],
    apiKey: SECRETS[0],
  });
  const classified = classifyAiError(error);
  const publicError = toPublicAiError(error, 'req-safe-123');

  assert.deepEqual(Object.keys(error).sort(), [
    'kind',
    'providerCode',
    'retryAfterSeconds',
    'status',
  ]);
  assertNoSecretOnAnySurface(error);
  assertNoSecretOnAnySurface(classified);
  assertNoSecretOnAnySurface(publicError);
  assert.equal(error.cause, undefined);
  assertSafe(classified);
  assertSafe(publicError);
  assert.deepEqual(publicError, {
    code: 'RATE_LIMITED',
    requestId: 'req-safe-123',
    retryAfterSeconds: 4,
  });
});

test('invalid metadata is dropped instead of entering public errors', () => {
  const error = createAiUpstreamError('http', {
    status: '429',
    providerCode: `${SECRETS.join('-')}${'x'.repeat(300)}`,
    retryAfterSeconds: -1,
  });

  assert.deepEqual(classifyAiError(error), { code: 'AI_FAILED' });
  assert.deepEqual(toPublicAiError(error, 'request-1'), {
    code: 'AI_FAILED',
    requestId: 'request-1',
  });
});
