import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { startServer } from '../src/web/server.js';

const execFileAsync = promisify(execFile);

async function withServer(run, options = {}) {
  const server = await startServer({ port: 0, host: '127.0.0.1', ...options });
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postOversizedImage(base, bytes) {
  const script = `
    const response = await fetch(${JSON.stringify(`${base}/api/upload`)}, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'large.png' },
      body: new Uint8Array(${bytes}),
    });
    process.stdout.write(JSON.stringify({
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: await response.json(),
    }));
  `;
  return execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    maxBuffer: 64 * 1024,
  }).then(({ stdout }) => JSON.parse(stdout));
}

async function rejectsOversizedBody() {
  await withServer(async (base) => {
    const response = await postOversizedImage(base, 15 * 1024 * 1024 + 1);
    assert.equal(response.status, 413);
    assert.match(response.contentType || '', /^application\/json/);
    assert.deepEqual(response.body, {
      code: 'UPLOAD_TOO_LARGE',
      error: '图片文件过大',
    });
  });
}

async function checksSafeUploadErrors() {
  await withServer(async (base) => {
    const invalidResponse = await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-filename': encodeURIComponent('../../private/secret.txt'),
      },
      body: 'not an image',
    });
    const invalidBody = await invalidResponse.json();
    assert.equal(invalidResponse.status, 400);
    assert.match(invalidBody.error, /不支持的图片类型/);
    assert.doesNotMatch(invalidBody.error, /secret|private|\.\./);

    const upstreamResponse = await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'safe.png' },
      body: new Uint8Array([137, 80, 78, 71]),
    });
    const upstreamBody = await upstreamResponse.json();
    assert.equal(upstreamResponse.status, 502);
    assert.deepEqual(upstreamBody, {
      code: 'UPLOAD_FAILED',
      error: '图片上传失败，请稍后重试',
    });
    assert.doesNotMatch(JSON.stringify(upstreamBody), /test-secret|test-key|127\.0\.0\.1|test-bucket/);
  }, {
    isStorageConfigured: () => true,
    uploadImage: async () => {
      throw new Error('http://127.0.0.1:1/test-bucket?secret=test-secret&key=test-key');
    },
  });
}

test('upload route responses', async (t) => {
  await t.test('rejects oversized bodies before storage', rejectsOversizedBody);
  await t.test('uses safe invalid-image and upstream errors', checksSafeUploadErrors);
});
