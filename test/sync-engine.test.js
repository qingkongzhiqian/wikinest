import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSyncEngine,
  createMemoryStateStore,
  createJsonFileStateStore,
  createFileLocalAdapter,
} from '../src/core/sync/engine.js';
import { createSegment, encodeSegment } from '../src/core/sync/protocol.js';
import { encodeBlob, openSyncMeta } from '../src/core/sync/crypto.js';

function notFound(key) {
  const error = new Error(`NoSuchKey: ${key}`);
  error.name = 'NoSuchKey';
  error.code = 'NotFound';
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

function createMemoryRemote() {
  const objects = new Map();
  let offline = false;
  let delay;
  return {
    objects,
    setOffline(value) { offline = value; },
    setDelay(value) { delay = value; },
    async list(prefix = '') {
      if (offline) throw new Error('offline');
      if (delay) await delay;
      const normalized = prefix ? `${prefix.replace(/\/+$/u, '')}/` : '';
      return [...objects.keys()].filter((key) => key.startsWith(normalized)).sort();
    },
    async get(key) {
      if (offline) throw new Error('offline');
      if (!objects.has(key)) throw notFound(key);
      return Buffer.from(objects.get(key));
    },
    async put(key, body) {
      if (offline) throw new Error('offline');
      objects.set(key, Buffer.from(body));
    },
    async head(key) {
      if (offline) throw new Error('offline');
      if (!objects.has(key)) throw notFound(key);
      return {};
    },
  };
}

async function makeDevice(remote, {
  vaultId = 'vault-test',
  password = '',
  deviceId,
  stateDir,
  onStatus,
  omitVaultId = false,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wikinest-sync-local-'));
  const ownStateDir = stateDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'wikinest-sync-state-'));
  const stateStore = createJsonFileStateStore({ stateDir: ownStateDir });
  const local = createFileLocalAdapter({ root });
  const engine = createSyncEngine({
    ...(!omitVaultId ? { vaultId } : {}),
    password,
    deviceId,
    remote,
    local,
    stateStore,
    onStatus,
  });
  return { root, stateDir: ownStateDir, stateStore, local, engine };
}

async function write(device, relPath, contents) {
  const absolute = path.join(device.root, ...relPath.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents);
}

async function read(device, relPath) {
  return fs.readFile(path.join(device.root, ...relPath.split('/')), 'utf8');
}

async function exists(device, relPath) {
  try {
    await fs.access(path.join(device.root, ...relPath.split('/')));
    return true;
  } catch {
    return false;
  }
}

function segmentKeys(remote) {
  return [...remote.objects.keys()].filter((key) => key.startsWith('v1/log/')).sort();
}

function blobKeys(remote) {
  return [...remote.objects.keys()].filter((key) => key.startsWith('v1/blobs/')).sort();
}

function remoteRevision({
  fileId,
  revisionId,
  parents = [],
  path: notePath,
  deviceId = 'remote-device',
  blob,
}) {
  return {
    kind: 'put',
    fileId,
    revisionId,
    parents,
    path: notePath,
    deviceId,
    timestamp: '2026-07-20T00:00:00.000Z',
    blob,
  };
}

function addPlainSegment(remote, revisions, {
  deviceId = 'remote-device',
  sequence = 0,
  suffix = 'fixture',
} = {}) {
  const segment = createSegment({ deviceId, sequence, revisions });
  remote.objects.set(
    `v1/log/${deviceId}/${String(sequence).padStart(10, '0')}-${suffix}.json`,
    encodeSegment(segment, { key: null, vaultId: 'vault-test' }),
  );
}

test('空远端初始化并首传，blob 先于 segment 且日志键不可变', async () => {
  const remote = createMemoryRemote();
  const order = [];
  const originalPut = remote.put;
  remote.put = async (key, body) => {
    order.push(key);
    return originalPut.call(remote, key, body);
  };
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  await write(a, 'notes/a.md', '# A');

  const result = await a.engine.sync();

  assert.equal(result.uploadedSegments, 1);
  assert.ok(remote.objects.has('v1/meta.json'));
  assert.equal(blobKeys(remote).length, 1);
  assert.match(segmentKeys(remote)[0], /^v1\/log\/device-a\/0000000000-[^/]+\.json$/u);
  assert.ok(order.indexOf(blobKeys(remote)[0]) < order.indexOf(segmentKeys(remote)[0]));
});

test('第二设备加入并拉取首台设备内容', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  await write(a, 'a.md', 'from a');
  await a.engine.sync();
  const b = await makeDevice(remote, { deviceId: 'device-b' });

  const result = await b.engine.sync();

  assert.equal(await read(b, 'a.md'), 'from a');
  assert.equal(result.downloadedSegments, 1);
});

test('增量修改沿用 fileId 且父修订是上次物化 head', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  await write(a, 'a.md', 'v1');
  await a.engine.sync();
  const before = await a.stateStore.load();
  const fileId = before.tracked['a.md'].fileId;
  const parent = before.tracked['a.md'].head;
  await write(a, 'a.md', 'v2');

  await a.engine.sync();

  const after = await a.stateStore.load();
  const revision = Object.values(after.revisions).find((item) => item.blob === after.tracked['a.md'].hash);
  assert.equal(after.tracked['a.md'].fileId, fileId);
  assert.deepEqual(revision.parents, [parent]);
});

test('无变化的后续同步不上传新 segment', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  await write(a, 'a.md', 'same');
  await a.engine.sync();
  const count = segmentKeys(remote).length;

  const result = await a.engine.sync();

  assert.equal(result.uploadedSegments, 0);
  assert.equal(segmentKeys(remote).length, count);
});

test('本地删除形成 delete 并在另一设备物化', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  const b = await makeDevice(remote, { deviceId: 'device-b' });
  await write(a, 'gone.md', 'remove me');
  await a.engine.sync();
  await b.engine.sync();
  await fs.unlink(path.join(a.root, 'gone.md'));

  await a.engine.sync();
  await b.engine.sync();

  assert.equal(await exists(b, 'gone.md'), false);
});

test('外部 rename 按相同原始 hash 沿用 fileId 而非 delete+new', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  await write(a, 'old.md', 'same bytes');
  await a.engine.sync();
  const oldState = await a.stateStore.load();
  await fs.rename(path.join(a.root, 'old.md'), path.join(a.root, 'new.md'));

  await a.engine.sync();

  const state = await a.stateStore.load();
  assert.equal(state.tracked['new.md'].fileId, oldState.tracked['old.md'].fileId);
  assert.equal(state.tracked['old.md'], undefined);
  const latest = state.revisions[state.tracked['new.md'].head];
  assert.equal(latest.kind, 'put');
  assert.deepEqual(latest.parents, [oldState.tracked['old.md'].head]);
});

test('两端并发编辑在所有设备生成相同稳定冲突路径', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  const b = await makeDevice(remote, { deviceId: 'device-b' });
  await write(a, 'note.md', 'base');
  await a.engine.sync();
  await b.engine.sync();
  await write(a, 'note.md', 'edit a');
  await write(b, 'note.md', 'edit b');

  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();

  const namesA = (await fs.readdir(a.root)).sort();
  const namesB = (await fs.readdir(b.root)).sort();
  assert.deepEqual(namesA, namesB);
  assert.equal(namesA.length, 2);
  assert.ok(namesA.some((name) => /^note-conflict-[a-z0-9]+\.md$/u.test(name)));
  assert.deepEqual(
    (await Promise.all(namesA.map((name) => read(a, name)))).sort(),
    ['edit a', 'edit b'],
  );
  assert.deepEqual(
    (await Promise.all(namesB.map((name) => read(b, name)))).sort(),
    ['edit a', 'edit b'],
  );
});

test('delete 与 edit 并发时保留 put 内容', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  const b = await makeDevice(remote, { deviceId: 'device-b' });
  await write(a, 'note.md', 'base');
  await a.engine.sync();
  await b.engine.sync();
  await fs.unlink(path.join(a.root, 'note.md'));
  await write(b, 'note.md', 'survivor');

  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();

  assert.equal(await read(a, 'note.md'), 'survivor');
  assert.equal(await read(b, 'note.md'), 'survivor');
});

test('不同 fileId 争用同一路径时确定性生成冲突副本', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  const b = await makeDevice(remote, { deviceId: 'device-b' });
  await write(a, 'same.md', 'file a');
  await write(b, 'same.md', 'file b');

  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();

  const namesA = (await fs.readdir(a.root)).sort();
  const namesB = (await fs.readdir(b.root)).sort();
  assert.deepEqual(namesA, namesB);
  assert.equal(namesA.length, 2);
  assert.deepEqual((await Promise.all(namesA.map((name) => read(a, name)))).sort(), ['file a', 'file b']);
});

test('重复 segment 和重复 revision 幂等，不制造冲突或回传', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  await write(a, 'a.md', 'once');
  await a.engine.sync();
  const originalKey = segmentKeys(remote)[0];
  remote.objects.set(originalKey.replace(/-[^/]+\.json$/u, '-duplicate.json'), remote.objects.get(originalKey));
  const b = await makeDevice(remote, { deviceId: 'device-b' });

  await b.engine.sync();
  const before = segmentKeys(remote).length;
  await b.engine.sync();

  assert.equal(await read(b, 'a.md'), 'once');
  assert.equal((await fs.readdir(b.root)).length, 1);
  assert.equal(segmentKeys(remote).length, before);
});

test('坏 blob hash 与 segment 路由不匹配均拒绝且不应用', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  await write(a, 'a.md', 'valid');
  await a.engine.sync();
  const segmentKey = segmentKeys(remote)[0];
  remote.objects.set(
    segmentKey.replace('/device-a/0000000000-', '/device-z/0000000009-'),
    remote.objects.get(segmentKey),
  );
  const routed = await makeDevice(remote, { deviceId: 'device-b' });
  await assert.rejects(routed.engine.sync(), /routing|device|sequence/i);
  assert.equal(await exists(routed, 'a.md'), false);

  remote.objects.delete([...remote.objects.keys()].find((key) => key.includes('/device-z/')));
  const blobKey = blobKeys(remote)[0];
  remote.objects.set(blobKey, Buffer.from('corrupt'));
  const corrupt = await makeDevice(remote, { deviceId: 'device-c' });
  await assert.rejects(corrupt.engine.sync(), /hash|sha-?256/i);
  assert.equal(await exists(corrupt, 'a.md'), false);
});

test('明文和加密 vault 均可同步，加密远端不泄漏正文', async () => {
  for (const password of ['', 'correct horse battery staple']) {
    const remote = createMemoryRemote();
    const a = await makeDevice(remote, { deviceId: `a-${password.length}`, password });
    const b = await makeDevice(remote, { deviceId: `b-${password.length}`, password });
    await write(a, 'secret.md', 'ultra-secret-body-92017');
    await a.engine.sync();
    await b.engine.sync();
    assert.equal(await read(b, 'secret.md'), 'ultra-secret-body-92017');
    const remoteText = Buffer.concat([...remote.objects.values()]).toString('utf8');
    assert.equal(remoteText.includes('ultra-secret-body-92017'), password === '');
  }
});

test('错误密码和明加密模式不匹配失败', async () => {
  const encryptedRemote = createMemoryRemote();
  const owner = await makeDevice(encryptedRemote, { password: 'right', deviceId: 'owner' });
  await owner.engine.sync();
  const wrong = await makeDevice(encryptedRemote, { password: 'wrong', deviceId: 'wrong' });
  await assert.rejects(wrong.engine.sync(), /password|metadata|encrypt/i);

  const plainRemote = createMemoryRemote();
  const plain = await makeDevice(plainRemote, { deviceId: 'plain' });
  await plain.engine.sync();
  const unexpectedPassword = await makeDevice(plainRemote, { password: 'not-used', deviceId: 'other' });
  await assert.rejects(unexpectedPassword.engine.sync(), /plaintext|password/i);
});

test('meta 初始化后重读，检测并发初始化串库', async () => {
  const remote = createMemoryRemote();
  const originalPut = remote.put;
  remote.put = async (key, body) => {
    await originalPut.call(remote, key, body);
    if (key === 'v1/meta.json') {
      const foreign = JSON.parse(Buffer.from(body).toString('utf8'));
      foreign.vaultId = 'foreign-vault';
      remote.objects.set(key, Buffer.from(JSON.stringify(foreign)));
    }
  };
  const a = await makeDevice(remote, { vaultId: 'our-vault', deviceId: 'device-a' });
  await assert.rejects(a.engine.sync(), /vault|metadata|concurrent/i);
});

test('离线失败保留可重试状态，恢复后成功', async () => {
  const remote = createMemoryRemote();
  const statuses = [];
  const a = await makeDevice(remote, {
    deviceId: 'device-a',
    onStatus: (status) => statuses.push(status.state),
  });
  await write(a, 'a.md', 'retry me');
  remote.setOffline(true);
  await assert.rejects(a.engine.sync(), /offline/);
  assert.equal(a.engine.getStatus().state, 'error');
  assert.equal(segmentKeys(remote).length, 0);

  remote.setOffline(false);
  await a.engine.sync();

  assert.equal(a.engine.getStatus().state, 'synced');
  assert.deepEqual(statuses, ['syncing', 'error', 'syncing', 'synced']);
  assert.equal(segmentKeys(remote).length, 1);
});

test('并发 sync 单飞并共享同一 Promise', async () => {
  const remote = createMemoryRemote();
  let release;
  remote.setDelay(new Promise((resolve) => { release = resolve; }));
  const a = await makeDevice(remote, { deviceId: 'device-a' });

  const first = a.engine.sync();
  const second = a.engine.sync();
  assert.equal(first, second);
  release();
  await first;
});

test('JSON state 原子持久化，重启后恢复且不重复上传', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  await write(a, 'a.md', 'persisted');
  await a.engine.sync();
  const count = segmentKeys(remote).length;
  const restarted = createSyncEngine({
    vaultId: 'vault-test',
    remote,
    local: createFileLocalAdapter({ root: a.root }),
    stateStore: createJsonFileStateStore({ stateDir: a.stateDir }),
  });

  const result = await restarted.sync();

  assert.equal(result.uploadedSegments, 0);
  assert.equal(segmentKeys(remote).length, count);
  assert.equal((await restarted.getState()).deviceId, 'device-a');
});

test('file adapter 在临时文件写入期间目标变化时拒绝 rename 并保留外部内容', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wikinest-file-cas-'));
  const target = path.join(root, 'note.md');
  const original = Buffer.from('scan snapshot');
  const external = Buffer.from('external write during temp write');
  await fs.writeFile(target, original);
  const expectedContentHash = (await import('node:crypto'))
    .createHash('sha256')
    .update(original)
    .digest('hex');
  let injected = false;
  const injectedFs = {
    ...fs,
    async writeFile(file, ...args) {
      const result = await fs.writeFile(file, ...args);
      if (!injected && file !== target && path.dirname(file) === root) {
        injected = true;
        await fs.writeFile(target, external);
      }
      return result;
    },
  };
  const local = createFileLocalAdapter({ root, fs: injectedFs });

  await assert.rejects(
    local.applyRaw('note.md', 'remote replacement', { expectedContentHash }),
    (error) => error.code === 'LOCAL_CHANGED_DURING_SYNC',
  );
  assert.deepEqual(await fs.readFile(target), external);
  assert.deepEqual((await fs.readdir(root)).sort(), ['note.md']);
});

test('file adapter 在初次校验后目标变化时拒绝 unlink', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wikinest-file-delete-cas-'));
  const target = path.join(root, 'note.md');
  const original = Buffer.from('scan snapshot');
  const external = Buffer.from('external write before unlink');
  await fs.writeFile(target, original);
  const expectedContentHash = (await import('node:crypto'))
    .createHash('sha256')
    .update(original)
    .digest('hex');
  let injected = false;
  const injectedFs = {
    ...fs,
    async readFile(file, ...args) {
      const value = await fs.readFile(file, ...args);
      if (!injected && file === target) {
        injected = true;
        await fs.writeFile(target, external);
      }
      return value;
    },
  };
  const local = createFileLocalAdapter({ root, fs: injectedFs });

  await assert.rejects(
    local.deleteRaw('note.md', { expectedContentHash }),
    (error) => error.code === 'LOCAL_CHANGED_DURING_SYNC',
  );
  assert.deepEqual(await fs.readFile(target), external);
});

test('冲突副本被写入 tracked，下一轮不作为新文件上传', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  const b = await makeDevice(remote, { deviceId: 'device-b' });
  await write(a, 'note.md', 'base');
  await a.engine.sync();
  await b.engine.sync();
  await write(a, 'note.md', 'a');
  await write(b, 'note.md', 'b');
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  const count = segmentKeys(remote).length;

  const result = await a.engine.sync();

  assert.equal(result.uploadedSegments, 0);
  assert.equal(segmentKeys(remote).length, count);
});

test('内存 state store 可注入并返回隔离快照', async () => {
  const store = createMemoryStateStore({ deviceId: 'x', nested: { value: 1 } });
  const first = await store.load();
  first.nested.value = 2;
  assert.equal((await store.load()).nested.value, 1);
  await store.save({ deviceId: 'y', nested: { value: 3 } });
  assert.equal((await store.load()).deviceId, 'y');
});

test('加密 segment 在状态保存失败后重试仍保持不可变字节', async () => {
  const remote = createMemoryRemote();
  const writes = [];
  const originalPut = remote.put;
  remote.put = async (key, body) => {
    if (key.startsWith('v1/log/')) writes.push(Buffer.from(body));
    return originalPut.call(remote, key, body);
  };
  const backing = createMemoryStateStore();
  let failOnce = true;
  const stateStore = {
    load: () => backing.load(),
    async save(state) {
      if (failOnce && state.nextSequence === 1 && state.pending === null) {
        failOnce = false;
        throw new Error('state disk full');
      }
      await backing.save(state);
    },
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wikinest-sync-local-'));
  const engine = createSyncEngine({
    vaultId: 'immutable-vault',
    password: 'secret',
    deviceId: 'device-a',
    remote,
    local: createFileLocalAdapter({ root }),
    stateStore,
  });
  await fs.writeFile(path.join(root, 'a.md'), 'immutable');

  await assert.rejects(engine.sync(), /disk full/);
  await engine.sync();

  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
});

test('pending 上传期间继续编辑会以上传 revision 为父继续上传且不回滚正文', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  await write(a, 'note.md', 'captured');
  const originalPut = remote.put;
  let edited = false;
  remote.put = async (key, body) => {
    await originalPut.call(remote, key, body);
    if (!edited && key.startsWith('v1/log/')) {
      edited = true;
      await write(a, 'note.md', 'edited-after-capture');
    }
  };

  const result = await a.engine.sync();

  assert.equal(result.uploadedSegments, 2);
  assert.equal(await read(a, 'note.md'), 'edited-after-capture');
  const state = await a.stateStore.load();
  const revisions = Object.values(state.revisions);
  assert.equal(revisions.length, 2);
  const first = revisions.find((revision) => revision.parents.length === 0);
  const second = revisions.find((revision) => revision.parents.length === 1);
  assert.deepEqual(second.parents, [first.revisionId]);
  assert.equal(state.tracked['note.md'].head, second.revisionId);
});

test('物化前拒绝 self-parent、已知 cycle 和跨 file parent，且不改本地', async () => {
  for (const [label, revisions] of [
    ['self', [
      remoteRevision({
        fileId: 'file-a', revisionId: 'self', parents: ['self'], path: 'remote.md', blob: 'a'.repeat(64),
      }),
    ]],
    ['cycle', [
      remoteRevision({
        fileId: 'file-a', revisionId: 'one', parents: ['two'], path: 'remote.md', blob: 'a'.repeat(64),
      }),
      remoteRevision({
        fileId: 'file-a', revisionId: 'two', parents: ['one'], path: 'remote.md', blob: 'a'.repeat(64),
      }),
    ]],
    ['cross-file', [
      remoteRevision({
        fileId: 'file-a', revisionId: 'parent', path: 'a.md', blob: 'a'.repeat(64),
      }),
      remoteRevision({
        fileId: 'file-b', revisionId: 'child', parents: ['parent'], path: 'b.md', blob: 'a'.repeat(64),
      }),
    ]],
  ]) {
    const remote = createMemoryRemote();
    const device = await makeDevice(remote, { deviceId: `device-${label}` });
    await device.engine.sync();
    await write(device, 'local.md', 'keep me');
    addPlainSegment(remote, revisions);
    const badKey = segmentKeys(remote).find((key) => key.includes('/remote-device/'));

    await assert.rejects(device.engine.sync(), /parent|cycle|graph|file/i, label);
    assert.equal(await read(device, 'local.md'), 'keep me');
    assert.equal(await exists(device, 'remote.md'), false);
    const failedState = await device.stateStore.load();
    assert.equal(failedState.seenSegments[badKey], undefined);
    for (const revision of revisions) {
      assert.equal(failedState.revisions[revision.revisionId], undefined);
    }

    remote.objects.delete(badKey);
    await device.engine.sync();
    assert.equal(await read(device, 'local.md'), 'keep me');
  }
});

test('未知 parent 可暂存，后续到达的跨 file parent 原子拒绝且可恢复', async () => {
  const remote = createMemoryRemote();
  const device = await makeDevice(remote, { deviceId: 'device-local' });
  await device.engine.sync();
  const orphanBlob = encodeBlob(Buffer.from('orphan child'), {
    key: null,
    vaultId: 'vault-test',
  });
  remote.objects.set(`v1/blobs/${orphanBlob.hash}`, orphanBlob.body);
  addPlainSegment(remote, [
    remoteRevision({
      fileId: 'file-child',
      revisionId: 'child',
      parents: ['late-parent'],
      path: 'orphan.md',
      blob: orphanBlob.hash,
    }),
  ], { sequence: 0, suffix: 'orphan' });

  await device.engine.sync();
  assert.equal(await read(device, 'orphan.md'), 'orphan child');
  assert.ok((await device.stateStore.load()).revisions.child);

  const parentBlob = encodeBlob(Buffer.from('foreign parent'), {
    key: null,
    vaultId: 'vault-test',
  });
  remote.objects.set(`v1/blobs/${parentBlob.hash}`, parentBlob.body);
  addPlainSegment(remote, [
    remoteRevision({
      fileId: 'file-parent',
      revisionId: 'late-parent',
      path: 'parent.md',
      blob: parentBlob.hash,
    }),
  ], { sequence: 1, suffix: 'late-parent' });
  const parentKey = segmentKeys(remote).find((key) => key.endsWith('-late-parent.json'));

  await assert.rejects(device.engine.sync(), /parent|different file/i);
  const failedState = await device.stateStore.load();
  assert.equal(failedState.revisions['late-parent'], undefined);
  assert.equal(failedState.seenSegments[parentKey], undefined);

  remote.objects.delete(parentKey);
  await device.engine.sync();
  assert.equal(await read(device, 'orphan.md'), 'orphan child');
});

test('非法 deviceId 在任何远端请求前拒绝', async () => {
  for (const deviceId of ['bad/device', 'bad\\device', 'bad\u0000device']) {
    const remote = createMemoryRemote();
    let requests = 0;
    for (const method of ['list', 'get', 'put']) {
      const original = remote[method];
      remote[method] = async (...args) => {
        requests += 1;
        return original.apply(remote, args);
      };
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wikinest-sync-local-'));
    assert.throws(
      () => createSyncEngine({
        vaultId: 'vault-test',
        deviceId,
        remote,
        local: createFileLocalAdapter({ root }),
      }),
      /deviceId|route|separator/i,
    );
    assert.equal(requests, 0);
  }
});

test('case 与 Unicode NFC 等价路径稳定碰撞并保留全部内容', async () => {
  for (const [firstPath, secondPath] of [
    ['Note.md', 'note.md'],
    ['café.md', 'cafe\u0301.md'],
  ]) {
    const remote = createMemoryRemote();
    const a = await makeDevice(remote, { deviceId: 'device-a' });
    const b = await makeDevice(remote, { deviceId: 'device-b' });
    await write(a, firstPath, 'from-a');
    await write(b, secondPath, 'from-b');
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    const stateA = await a.stateStore.load();
    const stateB = await b.stateStore.load();
    assert.deepEqual(Object.keys(stateA.tracked).sort(), Object.keys(stateB.tracked).sort());
    assert.equal(Object.keys(stateA.tracked).length, 2);
    const bodies = await Promise.all(Object.keys(stateA.tracked).map((name) => read(a, name)));
    assert.deepEqual(bodies.sort(), ['from-a', 'from-b']);
  }
});

test('文件与目录祖先碰撞时将冲突文件稳定放入 sync-conflicts', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  const b = await makeDevice(remote, { deviceId: 'device-b' });
  await write(a, 'guide.md', 'flat-file');
  await write(b, 'guide.md/note.md', 'nested-file');
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();

  const paths = Object.keys((await a.stateStore.load()).tracked);
  assert.equal(paths.length, 2);
  assert.ok(paths.some((value) => value.startsWith('sync-conflicts/')));
  assert.deepEqual((await Promise.all(paths.map((value) => read(a, value)))).sort(), [
    'flat-file',
    'nested-file',
  ]);
});

test('物化 apply 中途失败后按 journal 恢复且不回传 partial apply', async () => {
  const remote = createMemoryRemote();
  const owner = await makeDevice(remote, { deviceId: 'owner' });
  await write(owner, 'a.md', 'A');
  await write(owner, 'b.md', 'B');
  await owner.engine.sync();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wikinest-sync-local-'));
  const backing = createMemoryStateStore();
  const baseLocal = createFileLocalAdapter({ root });
  let applies = 0;
  const failingLocal = {
    ...baseLocal,
    async applyRaw(notePath, raw) {
      applies += 1;
      if (applies === 2) throw new Error('apply interrupted');
      return baseLocal.applyRaw(notePath, raw);
    },
  };
  const first = createSyncEngine({
    vaultId: 'vault-test', deviceId: 'recovering', remote, local: failingLocal, stateStore: backing,
  });
  await assert.rejects(first.sync(), /apply interrupted/);
  assert.ok((await backing.load()).materializing);
  await fs.writeFile(path.join(root, 'a.md'), 'user-edit-after-crash');

  const restarted = createSyncEngine({
    vaultId: 'vault-test', deviceId: 'recovering', remote, local: baseLocal, stateStore: backing,
  });
  const result = await restarted.sync();
  assert.equal(result.uploadedSegments, 1);
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'user-edit-after-crash');
  assert.equal(await fs.readFile(path.join(root, 'b.md'), 'utf8'), 'B');
  const ownerState = await owner.stateStore.load();
  const recoveredState = await backing.load();
  assert.equal(recoveredState.tracked['a.md'].fileId, ownerState.tracked['a.md'].fileId);
});

test('apply 完成但最终 state save 失败后恢复且不重复上传', async () => {
  const remote = createMemoryRemote();
  const owner = await makeDevice(remote, { deviceId: 'owner' });
  await write(owner, 'a.md', 'A');
  await owner.engine.sync();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wikinest-sync-local-'));
  const backing = createMemoryStateStore();
  let journalSaved = false;
  let failed = false;
  const stateStore = {
    load: () => backing.load(),
    async save(state) {
      if (state.materializing) journalSaved = true;
      if (journalSaved && !state.materializing && !failed) {
        failed = true;
        throw new Error('final state save failed');
      }
      await backing.save(state);
    },
  };
  const local = createFileLocalAdapter({ root });
  const engine = createSyncEngine({
    vaultId: 'vault-test', deviceId: 'recovering', remote, local, stateStore,
  });
  await assert.rejects(engine.sync(), /final state save failed/);
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'A');

  const restarted = createSyncEngine({
    vaultId: 'vault-test', deviceId: 'recovering', remote, local, stateStore,
  });
  const result = await restarted.sync();
  assert.equal(result.uploadedSegments, 0);
  assert.equal(segmentKeys(remote).filter((key) => key.includes('/recovering/')).length, 0);
});

test('物化扫描后用户编辑同一路径时 CAS 中止，重试后保留本地与远端版本', async () => {
  const remote = createMemoryRemote();
  const owner = await makeDevice(remote, { deviceId: 'owner' });
  const joining = await makeDevice(remote, { deviceId: 'joining' });
  await write(owner, 'note.md', 'base');
  await owner.engine.sync();
  await joining.engine.sync();
  await write(owner, 'note.md', 'remote edit');
  await owner.engine.sync();

  const baseLocal = joining.local;
  let raced = false;
  const racingLocal = {
    ...baseLocal,
    async applyRaw(notePath, raw, options) {
      if (!raced && notePath === 'note.md') {
        raced = true;
        await write(joining, notePath, 'local edit after scan');
      }
      return baseLocal.applyRaw(notePath, raw, options);
    },
  };
  const engine = createSyncEngine({
    vaultId: 'vault-test',
    deviceId: 'joining',
    remote,
    local: racingLocal,
    stateStore: joining.stateStore,
  });

  await assert.rejects(engine.sync(), (error) => error.code === 'LOCAL_CHANGED_DURING_SYNC');
  assert.equal(await read(joining, 'note.md'), 'local edit after scan');
  await engine.sync();

  const paths = Object.keys((await joining.stateStore.load()).tracked);
  assert.equal(paths.length, 2);
  assert.deepEqual((await Promise.all(paths.map((value) => read(joining, value)))).sort(), [
    'local edit after scan',
    'remote edit',
  ]);
});

test('物化扫描后用户新建同名文件时 CAS 中止，重试后形成无损冲突', async () => {
  const remote = createMemoryRemote();
  const owner = await makeDevice(remote, { deviceId: 'owner' });
  await write(owner, 'note.md', 'remote file');
  await owner.engine.sync();
  const joining = await makeDevice(remote, { deviceId: 'joining' });
  const baseLocal = joining.local;
  let raced = false;
  const racingLocal = {
    ...baseLocal,
    async applyRaw(notePath, raw, options) {
      if (!raced && notePath === 'note.md') {
        raced = true;
        await write(joining, notePath, 'new local file after scan');
      }
      return baseLocal.applyRaw(notePath, raw, options);
    },
  };
  const engine = createSyncEngine({
    vaultId: 'vault-test',
    deviceId: 'joining',
    remote,
    local: racingLocal,
    stateStore: joining.stateStore,
  });

  await assert.rejects(engine.sync(), (error) => error.code === 'LOCAL_CHANGED_DURING_SYNC');
  assert.equal(await read(joining, 'note.md'), 'new local file after scan');
  await engine.sync();

  const paths = Object.keys((await joining.stateStore.load()).tracked);
  assert.equal(paths.length, 2);
  assert.deepEqual((await Promise.all(paths.map((value) => read(joining, value)))).sort(), [
    'new local file after scan',
    'remote file',
  ]);
});

test('本地上传完成后、materialize scan 前新建同名文件时中止并在重试后形成冲突', async () => {
  const remote = createMemoryRemote();
  const owner = await makeDevice(remote, { deviceId: 'owner' });
  await write(owner, 'note.md', 'remote file');
  await owner.engine.sync();
  const joining = await makeDevice(remote, { deviceId: 'joining' });
  await write(joining, 'local.md', 'uploaded first');
  const originalList = remote.list;
  let created = false;
  remote.list = async (prefix) => {
    if (!created && prefix === 'v1/log') {
      created = true;
      await write(joining, 'note.md', 'created after upload before materialize scan');
    }
    return originalList.call(remote, prefix);
  };

  await assert.rejects(
    joining.engine.sync(),
    (error) => error.code === 'LOCAL_CHANGED_DURING_SYNC',
  );
  assert.equal(await read(joining, 'note.md'), 'created after upload before materialize scan');
  const journal = await joining.stateStore.load();
  assert.equal(journal.materializing.localChanged['note.md'], true);

  await joining.engine.sync();
  const paths = Object.keys((await joining.stateStore.load()).tracked);
  assert.equal(paths.length, 3);
  assert.deepEqual((await Promise.all(paths.map((value) => read(joining, value)))).sort(), [
    'created after upload before materialize scan',
    'remote file',
    'uploaded first',
  ]);
});

test('物化扫描后用户修改而远端删除时 CAS 中止，重试后用户内容存为 revision', async () => {
  const remote = createMemoryRemote();
  const owner = await makeDevice(remote, { deviceId: 'owner' });
  const joining = await makeDevice(remote, { deviceId: 'joining' });
  await write(owner, 'note.md', 'base');
  await owner.engine.sync();
  await joining.engine.sync();
  await fs.unlink(path.join(owner.root, 'note.md'));
  await owner.engine.sync();

  const baseLocal = joining.local;
  let raced = false;
  const racingLocal = {
    ...baseLocal,
    async deleteRaw(notePath, options) {
      if (!raced && notePath === 'note.md') {
        raced = true;
        await write(joining, notePath, 'local edit before remote delete');
      }
      return baseLocal.deleteRaw(notePath, options);
    },
  };
  const engine = createSyncEngine({
    vaultId: 'vault-test',
    deviceId: 'joining',
    remote,
    local: racingLocal,
    stateStore: joining.stateStore,
  });

  await assert.rejects(engine.sync(), (error) => error.code === 'LOCAL_CHANGED_DURING_SYNC');
  assert.equal(await read(joining, 'note.md'), 'local edit before remote delete');
  const result = await engine.sync();

  assert.equal(result.uploadedSegments, 1);
  assert.equal(await read(joining, 'note.md'), 'local edit before remote delete');
  const state = await joining.stateStore.load();
  assert.equal(state.revisions[state.tracked['note.md'].head].kind, 'put');
});

test('无 vaultId 可凭远端 metadata 加入并持久化 vaultId', async () => {
  const remote = createMemoryRemote();
  const owner = await makeDevice(remote, {
    vaultId: 'remote-vault', password: 'secret', deviceId: 'owner',
  });
  await write(owner, 'a.md', 'joined');
  await owner.engine.sync();
  const joining = await makeDevice(remote, {
    omitVaultId: true, password: 'secret', deviceId: 'joining',
  });

  await joining.engine.sync();

  assert.equal(await read(joining, 'a.md'), 'joined');
  assert.equal((await joining.stateStore.load()).vaultId, 'remote-vault');
});

test('完整 remote namespace 隔离不同 endpoint 的 vaultId、salt、key 与 meta', async () => {
  const password = 'same password';
  const firstRemote = createMemoryRemote();
  const secondRemote = createMemoryRemote();
  firstRemote.namespaceId = 's3:https://one.example.com:us-east-1:bucket:prefix/';
  secondRemote.namespaceId = 's3:https://two.example.com:us-east-1:bucket:prefix/';
  const first = await makeDevice(firstRemote, {
    omitVaultId: true, password, deviceId: 'first',
  });
  const second = await makeDevice(secondRemote, {
    omitVaultId: true, password, deviceId: 'second',
  });

  await first.engine.sync();
  await second.engine.sync();

  const firstMeta = JSON.parse(firstRemote.objects.get('v1/meta.json').toString('utf8'));
  const secondMeta = JSON.parse(secondRemote.objects.get('v1/meta.json').toString('utf8'));
  const firstOpened = await openSyncMeta(firstMeta, password);
  const secondOpened = await openSyncMeta(secondMeta, password);
  assert.notEqual(firstMeta.vaultId, secondMeta.vaultId);
  assert.notEqual(firstMeta.kdf.salt, secondMeta.kdf.salt);
  assert.notDeepEqual(firstOpened.key, secondOpened.key);
  assert.notDeepEqual(firstMeta, secondMeta);
});

test('日志 PUT 后回读不一致时保留 pending 且不标记 seen', async () => {
  const remote = createMemoryRemote();
  const originalGet = remote.get;
  let corruptLogRead = true;
  remote.get = async (key) => {
    const value = await originalGet.call(remote, key);
    if (corruptLogRead && key.startsWith('v1/log/')) {
      corruptLogRead = false;
      return Buffer.from('different bytes');
    }
    return value;
  };
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  await write(a, 'a.md', 'retry');

  await assert.rejects(a.engine.sync(), /read.?back|mismatch|verify/i);

  const state = await a.stateStore.load();
  assert.ok(state.pending);
  assert.equal(state.seenSegments[state.pending.key], undefined);
});

test('formPending 后 meta 被覆盖时中止且不上传 segment', async () => {
  const remote = createMemoryRemote();
  const backing = createMemoryStateStore();
  let replaced = false;
  const stateStore = {
    load: () => backing.load(),
    async save(state) {
      await backing.save(state);
      if (state.pending && !replaced) {
        replaced = true;
        const meta = JSON.parse(remote.objects.get('v1/meta.json').toString('utf8'));
        meta.vaultId = 'foreign-vault';
        remote.objects.set('v1/meta.json', Buffer.from(JSON.stringify(meta)));
      }
    },
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wikinest-sync-local-'));
  await fs.writeFile(path.join(root, 'local.md'), 'must not upload');
  const engine = createSyncEngine({
    vaultId: 'vault-test',
    deviceId: 'device-a',
    remote,
    local: createFileLocalAdapter({ root }),
    stateStore,
  });

  await assert.rejects(engine.sync(), /meta|vault|changed|overwrit/i);
  assert.equal(segmentKeys(remote).length, 0);
});

test('blob PUT 期间 meta 被覆盖时在 segment PUT 紧前中止', async () => {
  const remote = createMemoryRemote();
  const originalPut = remote.put;
  let replaced = false;
  remote.put = async (key, body) => {
    await originalPut.call(remote, key, body);
    if (!replaced && key.startsWith('v1/blobs/')) {
      replaced = true;
      const meta = JSON.parse(remote.objects.get('v1/meta.json').toString('utf8'));
      meta.vaultId = 'foreign-vault';
      remote.objects.set('v1/meta.json', Buffer.from(JSON.stringify(meta)));
    }
  };
  const device = await makeDevice(remote, { deviceId: 'device-a' });
  await write(device, 'local.md', 'blob may upload but segment must not');

  await assert.rejects(device.engine.sync(), /meta|vault|changed|overwrit/i);
  assert.equal(segmentKeys(remote).length, 0);
});

test('status observer 同步抛错和 Promise rejection 均不改变同步结果或原始错误', async () => {
  for (const onStatus of [
    () => { throw new Error('observer sync failure'); },
    () => Promise.reject(new Error('observer async failure')),
  ]) {
    const remote = createMemoryRemote();
    const a = await makeDevice(remote, { deviceId: randomDeviceId(), onStatus });
    await write(a, 'a.md', 'ok');
    assert.equal((await a.engine.sync()).uploadedSegments, 1);
  }

  const remote = createMemoryRemote();
  const failing = await makeDevice(remote, {
    deviceId: 'failing',
    onStatus: () => { throw new Error('observer masked original'); },
  });
  remote.setOffline(true);
  await assert.rejects(failing.engine.sync(), /offline/);
});

test('文件扫描对 Markdown 后缀大小写不敏感', async () => {
  const remote = createMemoryRemote();
  const a = await makeDevice(remote, { deviceId: 'device-a' });
  await write(a, 'UPPER.MD', 'uppercase extension');

  await a.engine.sync();

  assert.ok((await a.stateStore.load()).tracked['UPPER.MD']);
});

function randomDeviceId() {
  return `device-${Math.random().toString(16).slice(2)}`;
}
