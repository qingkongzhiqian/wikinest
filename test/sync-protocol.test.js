import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncMeta, openSyncMeta } from '../src/core/sync/crypto.js';
import {
  createRevision,
  validateRevision,
  createSegment,
  validateSegment,
  encodeSegment,
  decodeSegment,
} from '../src/core/sync/protocol.js';

const BASE = {
  fileId: 'file-private-identifier-7d65d827-0d68-4d51-91af-546de598cf32',
  revisionId: 'rev-1',
  parents: [],
  path: 'notes/ultra-unique-private-title-astronomy-482901.md',
  deviceId: 'device-a',
  timestamp: '2026-07-20T01:02:03.000Z',
};
const BLOB_HASH = 'a'.repeat(64);
const PUT = { ...BASE, kind: 'put', blob: BLOB_HASH };
const DEL = { ...BASE, kind: 'delete' };

test('revision helpers create strict immutable put and delete snapshots', () => {
  assert.deepEqual(createRevision(PUT), PUT);
  assert.deepEqual(createRevision(DEL), DEL);
  assert.equal(validateRevision(PUT), true);
  assert.equal(validateRevision(DEL), true);
  assert.throws(() => validateRevision({ ...PUT, kind: 'rename' }), /kind/i);
  assert.throws(() => validateRevision({ ...PUT, blob: undefined }), /blob/i);
  assert.throws(() => validateRevision({ ...DEL, blob: BLOB_HASH }), /field|blob/i);
  assert.throws(() => validateRevision({ ...PUT, extra: true }), /field/i);
  assert.throws(() => validateRevision({ ...PUT, parents: ['rev-0', 'rev-0'] }), /parent/i);
  for (const blob of ['abc123', 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(63)} `]) {
    assert.throws(() => validateRevision({ ...PUT, blob }), /blob|sha/i);
  }
});

test('create helpers return deeply frozen snapshots independent of their inputs', () => {
  const revisionInput = { ...PUT, parents: ['rev-parent'] };
  const revision = createRevision(revisionInput);
  revisionInput.path = 'notes/changed.md';
  revisionInput.parents[0] = 'changed-parent';
  assert.equal(revision.path, PUT.path);
  assert.deepEqual(revision.parents, ['rev-parent']);
  assert.ok(Object.isFrozen(revision));
  assert.ok(Object.isFrozen(revision.parents));

  const segmentInput = {
    deviceId: PUT.deviceId,
    sequence: 9,
    revisions: [{ ...PUT, parents: ['rev-parent'] }],
  };
  const segment = createSegment(segmentInput);
  segmentInput.revisions[0].path = 'notes/changed-again.md';
  segmentInput.revisions[0].parents[0] = 'changed-again';
  segmentInput.revisions.push(DEL);
  assert.equal(segment.revisions.length, 1);
  assert.equal(segment.revisions[0].path, PUT.path);
  assert.deepEqual(segment.revisions[0].parents, ['rev-parent']);
  assert.ok(Object.isFrozen(segment));
  assert.ok(Object.isFrozen(segment.revisions));
  assert.ok(Object.isFrozen(segment.revisions[0]));
  assert.ok(Object.isFrozen(segment.revisions[0].parents));
});

test('revision and segment IDs reject blank values and control characters', () => {
  for (const field of ['fileId', 'revisionId', 'deviceId']) {
    assert.throws(() => validateRevision({ ...PUT, [field]: ' \t ' }), new RegExp(field, 'i'));
    assert.throws(() => validateRevision({ ...PUT, [field]: 'safe unsafe' }), new RegExp(field, 'i'));
    assert.throws(() => validateRevision({ ...PUT, [field]: `safe\u0000unsafe` }), new RegExp(field, 'i'));
  }
  assert.throws(() => validateRevision({ ...PUT, parents: [' \n '] }), /parent/i);
  assert.throws(() => validateRevision({ ...PUT, parents: ['rev\u001fid'] }), /parent/i);
  assert.throws(
    () => validateSegment({ version: 1, deviceId: ' \t ', sequence: 1, revisions: [] }),
    /deviceId/i,
  );
});

test('deviceId rejects routing separators in revisions and segments', () => {
  for (const deviceId of ['device/child', 'device\\child', 'device\u0000child']) {
    assert.throws(
      () => validateRevision({ ...PUT, deviceId }),
      /deviceId|route|separator/i,
    );
    assert.throws(
      () => validateSegment({ version: 1, deviceId, sequence: 1, revisions: [] }),
      /deviceId|route|separator/i,
    );
  }
});

test('revision paths are safe POSIX relative markdown paths outside dot directories', () => {
  const invalid = [
    '', '/absolute.md', '../escape.md', 'a/../escape.md', 'a\\windows.md',
    '.hidden.md', '.git/note.md', 'notes/.private/note.md', 'notes/readme.txt',
    'notes//double.md', 'notes/./same.md',
  ];
  for (const path of invalid) {
    assert.throws(() => validateRevision({ ...PUT, path }), /path/i, path);
  }
  assert.equal(validateRevision({ ...PUT, path: '日记/今天.md' }), true);
});

test('segment helpers validate sequence, revisions, fields, and version', () => {
  const segment = createSegment({ deviceId: 'device-a', sequence: 7, revisions: [PUT, DEL] });
  assert.deepEqual(segment, { version: 1, deviceId: 'device-a', sequence: 7, revisions: [PUT, DEL] });
  assert.equal(validateSegment(segment), true);
  assert.throws(() => validateSegment({ ...segment, version: 2 }), /version/i);
  assert.throws(() => validateSegment({ ...segment, sequence: -1 }), /sequence/i);
  assert.throws(() => validateSegment({ ...segment, unknown: true }), /field/i);
  assert.throws(
    () => validateSegment({ ...segment, revisions: [{ ...PUT, deviceId: 'other-device' }] }),
    /device/i,
  );
});

test('plaintext segment roundtrips as readable JSON', () => {
  const segment = createSegment({ deviceId: 'device-a', sequence: 1, revisions: [PUT] });
  const bytes = encodeSegment(segment, { key: null, vaultId: 'vault-a' });
  const text = bytes.toString('utf8');
  assert.ok(text.includes(PUT.path));
  assert.ok(text.includes(PUT.fileId));
  assert.deepEqual(decodeSegment(bytes, { key: null, vaultId: 'vault-a' }), segment);
});

test('decoded plaintext and encrypted segments are deeply frozen snapshots', async () => {
  const segment = createSegment({
    deviceId: 'device-a',
    sequence: 11,
    revisions: [{ ...PUT, parents: ['rev-parent'] }],
  });
  const { key } = await openSyncMeta(
    await createSyncMeta({ vaultId: 'vault-a', password: 'secret' }),
    'secret',
  );
  const decodedSegments = [
    decodeSegment(
      encodeSegment(segment, { key: null, vaultId: 'vault-a' }),
      { key: null, vaultId: 'vault-a' },
    ),
    decodeSegment(
      encodeSegment(segment, { key, vaultId: 'vault-a' }),
      { key, vaultId: 'vault-a' },
    ),
  ];

  for (const decoded of decodedSegments) {
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.revisions));
    assert.ok(Object.isFrozen(decoded.revisions[0]));
    assert.ok(Object.isFrozen(decoded.revisions[0].parents));
    assert.throws(() => { decoded.sequence = 12; }, TypeError);
    assert.throws(() => decoded.revisions.push(DEL), TypeError);
    assert.throws(() => { decoded.revisions[0].path = 'notes/changed.md'; }, TypeError);
    assert.throws(() => decoded.revisions[0].parents.push('rev-other'), TypeError);
  }
});

test('encrypted segment exposes only routing fields and hides revision data', async () => {
  const { key } = await openSyncMeta(
    await createSyncMeta({ vaultId: 'vault-a', password: 'secret' }),
    'secret',
  );
  const segment = createSegment({ deviceId: 'device-a', sequence: 2, revisions: [PUT] });
  const bytes = encodeSegment(segment, { key, vaultId: 'vault-a' });
  const text = bytes.toString('utf8');
  const outer = JSON.parse(text);
  assert.deepEqual(Object.keys(outer).sort(), [
    'deviceId', 'encrypted', 'envelope', 'sequence', 'version',
  ]);
  for (const secret of [PUT.path, PUT.fileId, BLOB_HASH]) {
    assert.equal(text.includes(secret), false, `encrypted bytes leaked ${secret}`);
  }
  assert.deepEqual(decodeSegment(bytes, { key, vaultId: 'vault-a' }), segment);

  const tamperedOuter = structuredClone(outer);
  const tag = Buffer.from(tamperedOuter.envelope.tag, 'base64');
  tag[0] ^= 1;
  tamperedOuter.envelope.tag = tag.toString('base64');
  const tampered = Buffer.from(JSON.stringify(tamperedOuter));
  assert.throws(() => decodeSegment(tampered, { key, vaultId: 'vault-a' }));
  const rerouted = JSON.parse(text);
  rerouted.sequence = 999;
  assert.throws(
    () => decodeSegment(Buffer.from(JSON.stringify(rerouted)), { key, vaultId: 'vault-a' }),
    /routing|tamper/i,
  );
  assert.throws(() => decodeSegment(bytes, { key, vaultId: 'vault-b' }));
});

test('segment decoder rejects encryption mismatch and unknown versions', () => {
  const segment = createSegment({ deviceId: 'device-a', sequence: 3, revisions: [] });
  const bytes = encodeSegment(segment, { key: null, vaultId: 'vault-a' });
  assert.throws(() => decodeSegment(bytes, { key: Buffer.alloc(32), vaultId: 'vault-a' }), /encrypt/i);
  const unknown = Buffer.from(JSON.stringify({
    version: 2,
    encrypted: false,
    deviceId: 'device-a',
    sequence: 3,
    revisions: [],
  }));
  assert.throws(() => decodeSegment(unknown, { key: null, vaultId: 'vault-a' }), /version/i);
});
