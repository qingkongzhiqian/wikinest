import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSyncMeta,
  openSyncMeta,
  seal,
  open,
  encodeBlob,
  decodeBlob,
} from '../src/core/sync/crypto.js';

const VAULT = 'vault-alpha';

test('sync meta supports plaintext and encrypted vaults', async () => {
  const plaintext = await createSyncMeta({
    vaultId: VAULT,
    password: '',
    createdAt: '2026-07-20T00:00:00.000Z',
  });
  assert.deepEqual(plaintext, {
    product: 'Wikinest Sync',
    version: 1,
    vaultId: VAULT,
    createdAt: '2026-07-20T00:00:00.000Z',
    encrypted: false,
  });
  assert.equal((await openSyncMeta(plaintext, '')).key, null);

  const encrypted = await createSyncMeta({ vaultId: VAULT, password: 'secret' });
  assert.equal(encrypted.product, 'Wikinest Sync');
  assert.equal(encrypted.version, 1);
  assert.equal(encrypted.vaultId, VAULT);
  assert.equal(encrypted.encrypted, true);
  assert.deepEqual(encrypted.kdf, {
    salt: encrypted.kdf.salt,
    N: 131_072,
    r: 8,
    p: 1,
  });
  assert.ok(encrypted.verifier.nonce);
  assert.ok(encrypted.verifier.ciphertext);
  assert.ok(encrypted.verifier.tag);
  const opened = await openSyncMeta(encrypted, 'secret');
  assert.equal(opened.key.length, 32);
});

test('sync meta rejects wrong passwords, tampering, and unknown fields', async () => {
  const meta = await createSyncMeta({ vaultId: VAULT, password: 'secret' });
  await assert.rejects(openSyncMeta(meta, 'wrong'), /password|tampered/i);

  const tampered = structuredClone(meta);
  tampered.verifier.tag = `${tampered.verifier.tag.slice(0, -2)}AA`;
  await assert.rejects(openSyncMeta(tampered, 'secret'), /password|tampered/i);

  await assert.rejects(openSyncMeta({ ...meta, extra: true }, 'secret'), /field/i);
  await assert.rejects(openSyncMeta({ ...meta, version: 2 }, 'secret'), /version/i);
  await assert.rejects(openSyncMeta(meta, ''), /password/i);
});

test('sync meta rejects invalid timestamps and unsafe IDs', async () => {
  await assert.rejects(
    createSyncMeta({ vaultId: VAULT, password: '', createdAt: 'not-a-date' }),
    /createdAt|ISO/i,
  );
  await assert.rejects(createSyncMeta({ vaultId: '   ', password: '' }), /vaultId/i);
  await assert.rejects(createSyncMeta({ vaultId: 'vault id', password: '' }), /vaultId/i);
  await assert.rejects(createSyncMeta({ vaultId: 'vault\u0000id', password: '' }), /vaultId/i);

  const plaintext = await createSyncMeta({ vaultId: VAULT, password: '' });
  await assert.rejects(openSyncMeta({ ...plaintext, createdAt: '2026-07-20' }, ''), /createdAt|ISO/i);
});

test('AES-GCM AAD prevents cross-vault and cross-type decryption', async () => {
  const { key } = await openSyncMeta(
    await createSyncMeta({ vaultId: VAULT, password: 'secret' }),
    'secret',
  );
  const envelope = seal(Buffer.from('private'), key, { vaultId: VAULT, type: 'segment' });
  assert.equal(open(envelope, key, { vaultId: VAULT, type: 'segment' }).toString(), 'private');
  assert.throws(() => open(envelope, key, { vaultId: 'vault-beta', type: 'segment' }));
  assert.throws(() => open(envelope, key, { vaultId: VAULT, type: 'blob' }));
});

test('blob encoding hashes stored bytes and roundtrips plaintext and ciphertext', async () => {
  const source = Buffer.from('# Title\nsecret body');
  const plaintext = encodeBlob(source, { key: null, vaultId: VAULT });
  assert.deepEqual(plaintext.body, source);
  assert.match(plaintext.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(decodeBlob(plaintext.body, { key: null, vaultId: VAULT }), source);

  const { key } = await openSyncMeta(
    await createSyncMeta({ vaultId: VAULT, password: 'secret' }),
    'secret',
  );
  const first = encodeBlob(source, { key, vaultId: VAULT });
  const second = encodeBlob(source, { key, vaultId: VAULT });
  assert.notDeepEqual(first.body, source);
  assert.notDeepEqual(first.body, second.body);
  assert.equal(first.hash.length, 64);
  assert.deepEqual(decodeBlob(first.body, { key, vaultId: VAULT }), source);

  const tampered = Buffer.from(first.body);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decodeBlob(tampered, { key, vaultId: VAULT }));
  assert.throws(() => decodeBlob(first.body, { key, vaultId: 'vault-beta' }));
});

test('encrypted blob roundtrips an empty body', async () => {
  const { key } = await openSyncMeta(
    await createSyncMeta({ vaultId: VAULT, password: 'secret' }),
    'secret',
  );
  const encoded = encodeBlob(Buffer.alloc(0), { key, vaultId: VAULT });
  assert.match(encoded.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(decodeBlob(encoded.body, { key, vaultId: VAULT }), Buffer.alloc(0));
});

test('createSyncMeta accepts a caller-provided 16-byte salt for compatible initialization', async () => {
  const salt = Buffer.from('0123456789abcdef');
  const first = await createSyncMeta({
    vaultId: VAULT,
    password: 'secret',
    salt,
    createdAt: '2026-07-20T00:00:00.000Z',
  });
  const second = await createSyncMeta({
    vaultId: VAULT,
    password: 'secret',
    salt,
    createdAt: '2026-07-20T00:00:01.000Z',
  });

  assert.equal(first.kdf.salt, salt.toString('base64'));
  assert.equal(second.kdf.salt, first.kdf.salt);
  assert.deepEqual((await openSyncMeta(first, 'secret')).key, (await openSyncMeta(second, 'secret')).key);
  await assert.rejects(
    createSyncMeta({ vaultId: VAULT, password: 'secret', salt: Buffer.alloc(15) }),
    /salt|16/i,
  );
});
