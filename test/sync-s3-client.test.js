import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createS3Adapter } from '../src/core/sync/s3-client.js';

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push({ name: command.constructor.name, input: command.input });
      return handler(command, calls.length);
    },
  };
}

test('S3 list follows every page and returns keys relative to normalized prefix', async () => {
  const client = fakeClient((command) => {
    if (command.input.ContinuationToken === undefined) {
      return {
        Contents: [{ Key: 'sync/v1/a' }, { Key: 'sync/v1/nested/b' }],
        IsTruncated: true,
        NextContinuationToken: 'next',
      };
    }
    return {
      Contents: [{ Key: 'sync/v1/c' }, { Key: 'outside/key' }],
      IsTruncated: false,
    };
  });
  const s3 = createS3Adapter({ bucket: 'bucket', prefix: '/sync/v1///' }, { client });
  assert.equal(s3.prefix, 'sync/v1/');
  assert.deepEqual(await s3.list(), ['a', 'nested/b', 'c']);
  assert.deepEqual(client.calls.map((call) => call.input.ContinuationToken), [undefined, 'next']);
  assert.ok(client.calls.every((call) => call.input.Bucket === 'bucket'));
  assert.ok(client.calls.every((call) => call.input.Prefix === 'sync/v1/'));
});

test('S3 adapter namespaceId includes endpoint, region, bucket and normalized prefix but not credentials', () => {
  const client = fakeClient(() => ({}));
  const first = createS3Adapter({
    endpoint: 'HTTPS://S3.EXAMPLE.COM/',
    region: 'us-east-1',
    bucket: 'bucket',
    prefix: '/sync/v1///',
    credentials: { accessKeyId: 'old', secretAccessKey: 'secret-one' },
  }, { client });
  const second = createS3Adapter({
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'bucket',
    prefix: 'sync/v1',
    credentials: { accessKeyId: 'new', secretAccessKey: 'secret-two' },
  }, { client });
  const otherEndpoint = createS3Adapter({
    endpoint: 'https://other.example.com',
    region: 'us-east-1',
    bucket: 'bucket',
    prefix: 'sync/v1',
  }, { client });

  assert.equal(first.namespaceId, second.namespaceId);
  assert.notEqual(first.namespaceId, otherEndpoint.namespaceId);
  assert.match(first.namespaceId, /s3\.example\.com.*us-east-1.*bucket.*sync\/v1/u);
  assert.doesNotMatch(first.namespaceId, /old|new|secret/u);
});

test('S3 list filters responses outside the requested relative prefix', async () => {
  const client = fakeClient(() => ({
    Contents: [
      { Key: 'sync/v1/nested/a' },
      { Key: 'sync/v1/nested/deeper/b' },
      { Key: 'sync/v1/other/leak' },
    ],
    IsTruncated: false,
  }));
  const s3 = createS3Adapter({ bucket: 'bucket', prefix: 'sync/v1' }, { client });
  assert.deepEqual(await s3.list('nested'), ['nested/a', 'nested/deeper/b']);
  assert.equal(client.calls[0].input.Prefix, 'sync/v1/nested/');
});

test('S3 get supports transformToByteArray and Node streams', async () => {
  const transformed = fakeClient(() => ({
    Body: { transformToByteArray: async () => Uint8Array.from([1, 2, 3]) },
  }));
  const first = createS3Adapter({ bucket: 'bucket', prefix: 'sync' }, { client: transformed });
  assert.deepEqual(await first.get('objects/a'), Buffer.from([1, 2, 3]));

  const streamed = fakeClient(() => ({ Body: Readable.from([Buffer.from('ab'), Buffer.from('cd')]) }));
  const second = createS3Adapter({ bucket: 'bucket' }, { client: streamed });
  assert.equal((await second.get('objects/b')).toString(), 'abcd');
});

test('S3 put, head, and delete use prefixed keys', async () => {
  const client = fakeClient((command) => ({ etag: command.input.Key }));
  const s3 = createS3Adapter({ bucket: 'bucket', prefix: 'sync/' }, { client });
  await s3.put('blobs/hash', Buffer.from('body'), { contentType: 'application/octet-stream' });
  await s3.head('blobs/hash');
  await s3.delete('blobs/hash');
  assert.deepEqual(client.calls.map(({ name, input }) => [name, input.Key]), [
    ['PutObjectCommand', 'sync/blobs/hash'],
    ['HeadObjectCommand', 'sync/blobs/hash'],
    ['DeleteObjectCommand', 'sync/blobs/hash'],
  ]);
  assert.equal(client.calls[0].input.ContentType, 'application/octet-stream');
});

test('S3 adapter rejects escaping keys without sending requests', async () => {
  const client = fakeClient(() => ({}));
  const s3 = createS3Adapter({ bucket: 'bucket', prefix: 'sync' }, { client });
  for (const key of ['', '/absolute', '../escape', 'a/../../escape', 'a\\windows']) {
    await assert.rejects(s3.get(key), /key/i);
  }
  assert.equal(client.calls.length, 0);
});

test('testConnection writes, reads, lists visible probe, and deletes it', async () => {
  let stored;
  let storedKey;
  const client = fakeClient((command) => {
    if (command.constructor.name === 'PutObjectCommand') {
      stored = Buffer.from(command.input.Body);
      storedKey = command.input.Key;
      return {};
    }
    if (command.constructor.name === 'GetObjectCommand') {
      return { Body: { transformToByteArray: async () => stored } };
    }
    if (command.constructor.name === 'ListObjectsV2Command') {
      return { Contents: [{ Key: storedKey }], IsTruncated: false };
    }
    if (command.constructor.name === 'DeleteObjectCommand') return {};
    throw new Error('unexpected command');
  });
  const s3 = createS3Adapter({ bucket: 'bucket', prefix: 'sync' }, { client });
  assert.equal(await s3.testConnection(), true);
  assert.deepEqual(client.calls.map((call) => call.name), [
    'PutObjectCommand', 'GetObjectCommand', 'ListObjectsV2Command', 'DeleteObjectCommand',
  ]);
  assert.equal(client.calls[0].input.Key, client.calls[3].input.Key);
  assert.match(client.calls[0].input.Key, /^sync\/_probe\//);
});

test('testConnection rejects when ListObjects cannot see the probe', async () => {
  let stored;
  const client = fakeClient((command) => {
    if (command.constructor.name === 'PutObjectCommand') {
      stored = Buffer.from(command.input.Body);
      return {};
    }
    if (command.constructor.name === 'GetObjectCommand') {
      return { Body: { transformToByteArray: async () => stored } };
    }
    if (command.constructor.name === 'ListObjectsV2Command') {
      return { Contents: [], IsTruncated: false };
    }
    if (command.constructor.name === 'DeleteObjectCommand') return {};
    throw new Error('unexpected command');
  });
  const s3 = createS3Adapter({ bucket: 'bucket', prefix: 'sync' }, { client });
  await assert.rejects(s3.testConnection(), /list|visible|probe/i);
  assert.equal(client.calls.at(-1).name, 'DeleteObjectCommand');
});

test('testConnection deletes its probe after read failure and surfaces errors', async () => {
  const client = fakeClient((command) => {
    if (command.constructor.name === 'PutObjectCommand') return {};
    if (command.constructor.name === 'GetObjectCommand') throw new Error('read denied');
    if (command.constructor.name === 'DeleteObjectCommand') return {};
    return {};
  });
  const s3 = createS3Adapter({ bucket: 'bucket' }, { client });
  await assert.rejects(s3.testConnection(), /read denied/);
  assert.deepEqual(client.calls.map((call) => call.name), [
    'PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand',
  ]);

  const listing = createS3Adapter(
    { bucket: 'bucket' },
    { client: fakeClient(() => { throw new Error('list denied'); }) },
  );
  await assert.rejects(listing.list(), /list denied/);
});

test('testConnection best-effort deletes the same probe after a PUT timeout', async () => {
  const client = fakeClient((command) => {
    if (command.constructor.name === 'PutObjectCommand') throw new Error('put timed out');
    if (command.constructor.name === 'DeleteObjectCommand') throw new Error('cleanup denied');
    throw new Error('unexpected command');
  });
  const s3 = createS3Adapter({ bucket: 'bucket', prefix: 'sync' }, { client });
  await assert.rejects(s3.testConnection(), /put timed out/);
  assert.deepEqual(client.calls.map((call) => call.name), [
    'PutObjectCommand', 'DeleteObjectCommand',
  ]);
  assert.equal(client.calls[0].input.Key, client.calls[1].input.Key);
  assert.match(client.calls[0].input.Key, /^sync\/_probe\/[0-9a-f-]+$/);
});
