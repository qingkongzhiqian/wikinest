import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  createSyncMeta,
  openSyncMeta,
  encodeBlob,
  decodeBlob,
} from './crypto.js';
import {
  createRevision,
  createSegment,
  encodeSegment,
  decodeSegment,
  validateDeviceId,
} from './protocol.js';

const META_KEY = 'v1/meta.json';
const LOG_PREFIX = 'v1/log';
const BLOB_PREFIX = 'v1/blobs';
const STATE_VERSION = 1;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isNotFound(error) {
  return error?.code === 'NotFound'
    || error?.code === 'NoSuchKey'
    || error?.name === 'NotFound'
    || error?.name === 'NoSuchKey'
    || error?.$metadata?.httpStatusCode === 404
    || error?.statusCode === 404;
}

function localChangedDuringSyncError() {
  const error = new Error('local note changed during sync materialization');
  error.code = 'LOCAL_CHANGED_DURING_SYNC';
  return error;
}

function assertSafePath(value) {
  if (
    typeof value !== 'string'
    || !value
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes('//')
    || !/\.md$/iu.test(value)
  ) {
    throw new Error(`unsafe Markdown path: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error(`unsafe Markdown path: ${value}`);
  }
}

function emptyState(deviceId) {
  return {
    version: STATE_VERSION,
    deviceId,
    vaultId: null,
    nextSequence: 0,
    seenSegments: {},
    revisions: {},
    tracked: {},
    pending: null,
    materializing: null,
  };
}

function normalizeState(value, requestedDeviceId) {
  if (value == null) return emptyState(requestedDeviceId ?? randomUUID());
  if (!value || typeof value !== 'object' || value.version !== STATE_VERSION) {
    throw new Error('unsupported sync state');
  }
  if (requestedDeviceId && value.deviceId !== requestedDeviceId) {
    throw new Error('state deviceId does not match configured deviceId');
  }
  if (typeof value.deviceId !== 'string' || !value.deviceId) {
    throw new Error('sync state deviceId is required');
  }
  validateDeviceId(value.deviceId);
  return {
    ...emptyState(value.deviceId),
    ...clone(value),
    seenSegments: clone(value.seenSegments ?? {}),
    revisions: clone(value.revisions ?? {}),
    tracked: clone(value.tracked ?? {}),
  };
}

export function createMemoryStateStore(initial = null) {
  let value = clone(initial);
  return {
    async load() {
      return clone(value);
    },
    async save(next) {
      value = clone(next);
    },
  };
}

export function createJsonFileStateStore({
  stateDir,
  filename = 'sync-state.json',
} = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new Error('stateDir is required');
  const statePath = path.join(stateDir, filename);
  return {
    statePath,
    async load() {
      try {
        return JSON.parse(await fs.readFile(statePath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) throw new Error('invalid sync state JSON', { cause: error });
        throw error;
      }
    },
    async save(next) {
      await fs.mkdir(stateDir, { recursive: true });
      const temporary = path.join(
        stateDir,
        `.${filename}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        await fs.writeFile(temporary, `${JSON.stringify(next)}\n`);
        await fs.rename(temporary, statePath);
      } catch (error) {
        try {
          await fs.unlink(temporary);
        } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') {
            throw new AggregateError([error, cleanupError], 'failed to persist sync state');
          }
        }
        throw error;
      }
    },
  };
}

async function scanDirectory(root, directory = root, output = [], io = fs) {
  await io.mkdir(root, { recursive: true });
  const entries = await io.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => compareStrings(a.name, b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(root, absolute, output, io);
    } else if (entry.isFile() && /\.md$/iu.test(entry.name)) {
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      assertSafePath(relative);
      output.push({ path: relative, raw: await io.readFile(absolute) });
    }
  }
  return output;
}

function resolveLocalPath(root, relative) {
  assertSafePath(relative);
  const absolute = path.resolve(root, ...relative.split('/'));
  const back = path.relative(root, absolute);
  if (back.startsWith('..') || path.isAbsolute(back)) throw new Error(`path escapes local root: ${relative}`);
  return absolute;
}

async function atomicWrite(absolute, raw, io = fs, beforeRename) {
  await io.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await io.writeFile(temporary, raw);
    await beforeRename?.();
    await io.rename(temporary, absolute);
  } catch (error) {
    try {
      await io.unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'failed to apply synced note');
      }
    }
    throw error;
  }
}

const filePathLockTails = new Map();

async function withFilePathLock(absolute, operation) {
  const key = absolute.normalize('NFC').toLowerCase();
  const previous = filePathLockTails.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  filePathLockTails.set(key, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (filePathLockTails.get(key) === tail) filePathLockTails.delete(key);
  }
}

async function currentFileHash(absolute, io = fs) {
  try {
    return sha256(await io.readFile(absolute));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertExpectedLocalHash(actual, options) {
  if (!Object.hasOwn(options ?? {}, 'expectedContentHash')) return;
  if (actual === options.expectedContentHash) return;
  const error = new Error('local note changed during sync materialization');
  error.code = 'LOCAL_CHANGED_DURING_SYNC';
  throw error;
}

export function createFileLocalAdapter({ root, fs: injectedFs = fs } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('local root is required');
  if (!injectedFs || typeof injectedFs !== 'object') throw new Error('file system adapter is invalid');
  const resolvedRoot = path.resolve(root);
  return {
    async scan() {
      return scanDirectory(resolvedRoot, resolvedRoot, [], injectedFs);
    },
    async applyRaw(relative, raw, options = {}) {
      const absolute = resolveLocalPath(resolvedRoot, relative);
      await withFilePathLock(absolute, async () => {
        assertExpectedLocalHash(await currentFileHash(absolute, injectedFs), options);
        await atomicWrite(absolute, raw, injectedFs, async () => {
          assertExpectedLocalHash(await currentFileHash(absolute, injectedFs), options);
        });
      });
    },
    async deleteRaw(relative, options = {}) {
      const absolute = resolveLocalPath(resolvedRoot, relative);
      await withFilePathLock(absolute, async () => {
        assertExpectedLocalHash(await currentFileHash(absolute, injectedFs), options);
        assertExpectedLocalHash(await currentFileHash(absolute, injectedFs), options);
        try {
          await injectedFs.unlink(absolute);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      });
      let directory = path.dirname(absolute);
      while (directory !== resolvedRoot) {
        try {
          await injectedFs.rmdir(directory);
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
          break;
        }
        directory = path.dirname(directory);
      }
    },
  };
}

export function createStoreLocalAdapter(injectedStore = null) {
  let storePromise;
  async function getStore() {
    storePromise ??= injectedStore ? Promise.resolve(injectedStore) : import('../store.js');
    return storePromise;
  }
  return {
    async scan() {
      const store = await getStore();
      const paths = await store.listFlat();
      const notes = [];
      for (const notePath of paths.sort(compareStrings)) {
        assertSafePath(notePath);
        notes.push({ path: notePath, raw: Buffer.from((await store.readNote(notePath)).raw) });
      }
      return notes;
    },
    async applyRaw(notePath, raw, options) {
      return (await getStore()).applyRawNote(notePath, raw, options);
    },
    async deleteRaw(notePath, options) {
      try {
        return await (await getStore()).deleteRawNote(notePath, options);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      }
    },
  };
}

function segmentKey(deviceId, sequence, unique) {
  validateDeviceId(deviceId);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('segment sequence must be a non-negative safe integer');
  }
  if (typeof unique !== 'string' || !unique || unique.includes('/') || unique.includes('\\')) {
    throw new Error('segment unique ID is unsafe');
  }
  return `${LOG_PREFIX}/${deviceId}/${String(sequence).padStart(10, '0')}-${unique}.json`;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pathIdentity(value) {
  return value.normalize('NFC').toLowerCase();
}

function pathsCollide(first, second) {
  const a = pathIdentity(first);
  const b = pathIdentity(second);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function parseSegmentKey(key) {
  const match = /^v1\/log\/([^/]+)\/(\d{10})-([^/]+)\.json$/u.exec(key);
  if (!match) throw new Error(`invalid segment routing key: ${key}`);
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence)) throw new Error(`invalid segment sequence in key: ${key}`);
  validateDeviceId(match[1]);
  return { deviceId: match[1], sequence };
}

function conflictPath(original, revision) {
  const slash = original.lastIndexOf('/');
  const directory = slash === -1 ? '' : original.slice(0, slash + 1);
  const filename = slash === -1 ? original : original.slice(slash + 1);
  const stem = filename.slice(0, -3);
  const shortId = sha256(`${revision.deviceId}\0${revision.revisionId}`).slice(0, 8);
  return `${directory}${stem}-conflict-${shortId}.md`;
}

function rootConflictPath(original, revision, attempt = 1) {
  const filename = original.slice(original.lastIndexOf('/') + 1);
  const stem = filename.slice(0, -3);
  const shortId = sha256(`${revision.deviceId}\0${revision.revisionId}`).slice(0, 8);
  const suffix = attempt === 1 ? '' : `-${attempt}`;
  return `sync-conflicts/${stem}-conflict-${shortId}${suffix}.md`;
}

function compareRevision(a, b) {
  return compareStrings(a.deviceId, b.deviceId)
    || compareStrings(a.revisionId, b.revisionId)
    || compareStrings(a.fileId, b.fileId);
}

function leafPutsByFile(revisions) {
  const byFile = new Map();
  for (const revision of Object.values(revisions)) {
    const list = byFile.get(revision.fileId) ?? [];
    list.push(revision);
    byFile.set(revision.fileId, list);
  }
  const result = [];
  for (const [fileId, list] of byFile) {
    const parentIds = new Set(list.flatMap((revision) => revision.parents));
    const leaves = list.filter((revision) => !parentIds.has(revision.revisionId));
    const puts = leaves.filter((revision) => revision.kind === 'put').sort(compareRevision);
    if (puts.length) result.push({ fileId, puts });
  }
  return result.sort((a, b) => compareStrings(a.fileId, b.fileId));
}

function assignMaterializedPaths(revisions) {
  const candidates = [];
  for (const { fileId, puts } of leafPutsByFile(revisions)) {
    puts.forEach((revision, index) => {
      candidates.push({
        fileId,
        revision,
        preferred: index === 0 ? revision.path : conflictPath(revision.path, revision),
      });
    });
  }
  candidates.sort((a, b) => (
    compareStrings(pathIdentity(a.preferred), pathIdentity(b.preferred))
    || compareStrings(a.preferred, b.preferred)
    || compareRevision(a.revision, b.revision)
    || compareStrings(a.fileId, b.fileId)
  ));
  const used = [];
  const desired = new Map();
  for (const candidate of candidates) {
    let target = candidate.preferred;
    if (used.some((existing) => pathsCollide(existing, target))) {
      target = conflictPath(candidate.revision.path, candidate.revision);
    }
    let attempt = 1;
    while (used.some((existing) => pathsCollide(existing, target))) {
      target = rootConflictPath(candidate.revision.path, candidate.revision, attempt++);
    }
    used.push(target);
    desired.set(target, candidate);
  }
  return desired;
}

function createLocalRevision({
  kind,
  tracked,
  localPath,
  blob,
  deviceId,
  now,
  newFileId,
}) {
  return createRevision({
    kind,
    fileId: tracked?.fileId ?? newFileId,
    revisionId: randomUUID(),
    parents: tracked?.head ? [tracked.head] : [],
    path: localPath,
    deviceId,
    timestamp: now(),
    ...(kind === 'put' ? { blob } : {}),
  });
}

export function createSyncEngine({
  vaultId,
  password = '',
  deviceId,
  local,
  remote,
  stateStore = createMemoryStateStore(),
  onStatus,
  now = () => new Date().toISOString(),
} = {}) {
  if (vaultId !== undefined && (typeof vaultId !== 'string' || !vaultId)) {
    throw new Error('vaultId must be a non-empty string when provided');
  }
  if (deviceId !== undefined) validateDeviceId(deviceId);
  if (typeof password !== 'string') throw new Error('password must be a string');
  for (const [value, label, methods] of [
    [local, 'local adapter', ['scan', 'applyRaw', 'deleteRaw']],
    [remote, 'remote adapter', ['list', 'get', 'put']],
    [stateStore, 'state store', ['load', 'save']],
  ]) {
    if (!value || methods.some((method) => typeof value[method] !== 'function')) {
      throw new Error(`${label} is invalid`);
    }
  }

  let status = Object.freeze({ state: 'pending', error: null });
  let inFlight = null;
  let closed = false;

  function setStatus(state, error = null) {
    status = Object.freeze({ state, error });
    if (!onStatus) return;
    try {
      Promise.resolve(onStatus(status)).catch(() => {});
    } catch {
      // Status observers are informational and must not affect synchronization.
    }
  }

  async function loadState() {
    return normalizeState(await stateStore.load(), deviceId);
  }

  async function openRemote(state) {
    if (vaultId && state.vaultId && vaultId !== state.vaultId) {
      throw new Error('configured vaultId does not match state vaultId');
    }
    let bytes;
    let created = false;
    try {
      bytes = await remote.get(META_KEY);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const selectedVaultId = vaultId
        ?? state.vaultId
        ?? (remote.namespaceId ? sha256(String(remote.namespaceId)) : null);
      if (!selectedVaultId) {
        throw new Error('vaultId is required to initialize a remote without namespaceId');
      }
      const salt = createHash('sha256')
        .update(`Wikinest Sync\0${selectedVaultId}\0meta-salt`)
        .digest()
        .subarray(0, 16);
      const candidate = await createSyncMeta({ vaultId: selectedVaultId, password, salt });
      await remote.put(META_KEY, Buffer.from(JSON.stringify(candidate)), {
        contentType: 'application/json',
      });
      created = true;
      bytes = await remote.get(META_KEY);
    }
    let meta;
    try {
      meta = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (error) {
      throw new Error('invalid remote metadata JSON', { cause: error });
    }
    const opened = await openSyncMeta(meta, password);
    const expectedVaultId = vaultId ?? state.vaultId;
    if (expectedVaultId && opened.meta.vaultId !== expectedVaultId) {
      throw new Error(
        created
          ? 'concurrent remote initialization selected a different vault'
          : 'remote metadata vaultId does not match',
      );
    }
    if (state.vaultId !== opened.meta.vaultId) {
      state.vaultId = opened.meta.vaultId;
      await stateStore.save(state);
    }
    return opened;
  }

  async function assertRemoteMetaUnchanged(opened) {
    let latestMeta;
    try {
      latestMeta = JSON.parse(Buffer.from(await remote.get(META_KEY)).toString('utf8'));
    } catch (error) {
      throw new Error('remote metadata changed or became invalid during sync', { cause: error });
    }
    const latest = await openSyncMeta(latestMeta, password);
    const configuration = (meta) => JSON.stringify({
      vaultId: meta.vaultId,
      encrypted: meta.encrypted,
      kdf: meta.kdf ?? null,
    });
    if (configuration(latest.meta) !== configuration(opened.meta)) {
      throw new Error('remote metadata configuration changed during sync');
    }
  }

  function scanMap(scanned) {
    const current = new Map();
    const identities = new Map();
    for (const item of scanned) {
      assertSafePath(item.path);
      const identity = pathIdentity(item.path);
      const collision = identities.get(identity);
      if (collision) {
        throw new Error(`duplicate equivalent local paths: ${collision} and ${item.path}`);
      }
      identities.set(identity, item.path);
      const raw = Buffer.from(item.raw);
      current.set(item.path, { raw, contentHash: sha256(raw) });
    }
    return current;
  }

  async function reconcileMaterializing(state) {
    if (!state.materializing) return;
    const current = scanMap(await local.scan());
    const baseline = state.materializing.baseline ?? {};
    const desired = state.materializing.desired ?? {};
    const reconciled = {};
    for (const trackedPath of new Set([...Object.keys(baseline), ...Object.keys(desired)])) {
      const actualHash = current.get(trackedPath)?.contentHash;
      if (desired[trackedPath] && actualHash === desired[trackedPath].contentHash) {
        reconciled[trackedPath] = desired[trackedPath];
      } else if (baseline[trackedPath]) {
        if (desired[trackedPath] || actualHash !== undefined) {
          reconciled[trackedPath] = baseline[trackedPath];
        }
      } else if (
        desired[trackedPath]
        && actualHash !== undefined
        && !state.materializing.localChanged?.[trackedPath]
      ) {
        reconciled[trackedPath] = desired[trackedPath];
      }
    }
    state.tracked = reconciled;
    state.materializing = null;
    await stateStore.save(state);
  }

  async function formPending(state, cryptoContext) {
    if (state.pending) return;
    const current = scanMap(await local.scan());

    const removed = Object.entries(state.tracked)
      .filter(([trackedPath]) => !current.has(trackedPath))
      .sort(([a], [b]) => compareStrings(a, b));
    const added = [...current.entries()]
      .filter(([localPath]) => !state.tracked[localPath])
      .sort(([a], [b]) => compareStrings(a, b));
    const usedRemoved = new Set();
    const usedAdded = new Set();
    const localRevisions = [];
    const blobs = {};

    for (const [addedPath, addedFile] of added) {
      const matchIndex = removed.findIndex(([removedPath, tracked], index) => (
        !usedRemoved.has(index)
        && tracked.contentHash === addedFile.contentHash
        && removedPath !== addedPath
      ));
      if (matchIndex === -1) continue;
      const [, tracked] = removed[matchIndex];
      const encoded = encodeBlob(addedFile.raw, cryptoContext);
      const revision = createLocalRevision({
        kind: 'put',
        tracked,
        localPath: addedPath,
        blob: encoded.hash,
        deviceId: state.deviceId,
        now,
      });
      usedRemoved.add(matchIndex);
      usedAdded.add(addedPath);
      localRevisions.push(revision);
      blobs[encoded.hash] = encoded.body.toString('base64');
    }

    for (const [localPath, file] of current) {
      const tracked = state.tracked[localPath];
      if (!tracked || usedAdded.has(localPath)) continue;
      if (tracked.contentHash === file.contentHash) continue;
      const encoded = encodeBlob(file.raw, cryptoContext);
      const revision = createLocalRevision({
        kind: 'put',
        tracked,
        localPath,
        blob: encoded.hash,
        deviceId: state.deviceId,
        now,
      });
      localRevisions.push(revision);
      blobs[encoded.hash] = encoded.body.toString('base64');
    }

    for (const [localPath, file] of added) {
      if (usedAdded.has(localPath)) continue;
      const encoded = encodeBlob(file.raw, cryptoContext);
      const revision = createLocalRevision({
        kind: 'put',
        tracked: null,
        localPath,
        blob: encoded.hash,
        deviceId: state.deviceId,
        now,
        newFileId: randomUUID(),
      });
      localRevisions.push(revision);
      blobs[encoded.hash] = encoded.body.toString('base64');
    }

    removed.forEach(([localPath, tracked], index) => {
      if (usedRemoved.has(index)) return;
      localRevisions.push(createLocalRevision({
        kind: 'delete',
        tracked,
        localPath,
        deviceId: state.deviceId,
        now,
      }));
    });

    if (!localRevisions.length) return;
    const sequence = state.nextSequence;
    const unique = randomUUID();
    const segment = createSegment({
      deviceId: state.deviceId,
      sequence,
      revisions: localRevisions,
    });
    state.pending = {
      key: segmentKey(state.deviceId, sequence, unique),
      segment,
      segmentBody: encodeSegment(segment, cryptoContext).toString('base64'),
      blobs,
      capturedTracked: clone(state.tracked),
    };
    for (const revision of localRevisions) {
      if (revision.kind === 'delete') {
        for (const [trackedPath, tracked] of Object.entries(state.pending.capturedTracked)) {
          if (tracked.fileId === revision.fileId) delete state.pending.capturedTracked[trackedPath];
        }
        continue;
      }
      for (const [trackedPath, tracked] of Object.entries(state.pending.capturedTracked)) {
        if (tracked.fileId === revision.fileId && trackedPath !== revision.path) {
          delete state.pending.capturedTracked[trackedPath];
        }
      }
      state.pending.capturedTracked[revision.path] = {
        fileId: revision.fileId,
        head: revision.revisionId,
        hash: revision.blob,
        contentHash: current.get(revision.path).contentHash,
      };
    }
    for (const revision of localRevisions) state.revisions[revision.revisionId] = revision;
    await stateStore.save(state);
  }

  async function uploadPending(state, cryptoContext, opened) {
    if (!state.pending) return 0;
    await assertRemoteMetaUnchanged(opened);
    for (const [hash, base64] of Object.entries(state.pending.blobs)) {
      const body = Buffer.from(base64, 'base64');
      if (sha256(body) !== hash) throw new Error(`pending blob SHA-256 mismatch: ${hash}`);
      await remote.put(`${BLOB_PREFIX}/${hash}`, body, {
        contentType: 'application/octet-stream',
      });
    }
    await assertRemoteMetaUnchanged(opened);
    const encoded = Buffer.from(state.pending.segmentBody, 'base64');
    await remote.put(state.pending.key, encoded, { contentType: 'application/json' });
    const readBack = Buffer.from(await remote.get(state.pending.key));
    if (!readBack.equals(encoded)) {
      throw new Error(`segment read-back mismatch after PUT: ${state.pending.key}`);
    }
    if (!state.pending.capturedTracked) {
      state.pending.capturedTracked = clone(state.tracked);
      for (const revision of state.pending.segment.revisions) {
        for (const [trackedPath, tracked] of Object.entries(state.pending.capturedTracked)) {
          if (tracked.fileId === revision.fileId) delete state.pending.capturedTracked[trackedPath];
        }
        if (revision.kind === 'put') {
          const body = Buffer.from(state.pending.blobs[revision.blob], 'base64');
          state.pending.capturedTracked[revision.path] = {
            fileId: revision.fileId,
            head: revision.revisionId,
            hash: revision.blob,
            contentHash: sha256(decodeBlob(body, cryptoContext)),
          };
        }
      }
    }
    state.tracked = clone(state.pending.capturedTracked);
    state.seenSegments[state.pending.key] = true;
    state.nextSequence += 1;
    state.pending = null;
    await stateStore.save(state);
    return 1;
  }

  async function pullSegments(state, cryptoContext) {
    const keys = (await remote.list(LOG_PREFIX)).sort(compareStrings);
    let downloaded = 0;
    for (const key of keys) {
      if (state.seenSegments[key]) continue;
      const route = parseSegmentKey(key);
      const segment = decodeSegment(await remote.get(key), cryptoContext);
      if (route.deviceId !== segment.deviceId || route.sequence !== segment.sequence) {
        throw new Error(`segment routing mismatch for ${key}`);
      }
      const candidateRevisions = clone(state.revisions);
      for (const revision of segment.revisions) {
        const existing = candidateRevisions[revision.revisionId];
        if (existing && JSON.stringify(existing) !== JSON.stringify(revision)) {
          throw new Error(`revision ID collision: ${revision.revisionId}`);
        }
        candidateRevisions[revision.revisionId] = revision;
      }
      validateRevisionGraph(candidateRevisions);
      const candidateSeenSegments = { ...state.seenSegments, [key]: true };
      await stateStore.save({
        ...state,
        revisions: candidateRevisions,
        seenSegments: candidateSeenSegments,
      });
      state.revisions = candidateRevisions;
      state.seenSegments = candidateSeenSegments;
      downloaded += 1;
    }
    return downloaded;
  }

  function validateRevisionGraph(revisions) {
    for (const revision of Object.values(revisions)) {
      for (const parentId of revision.parents) {
        if (parentId === revision.revisionId) {
          throw new Error(`revision graph has self-parent: ${revision.revisionId}`);
        }
        const parent = revisions[parentId];
        if (parent && parent.fileId !== revision.fileId) {
          throw new Error(`revision parent belongs to a different file: ${parentId}`);
        }
      }
    }
    const visiting = new Set();
    const visited = new Set();
    function visit(revisionId) {
      if (visiting.has(revisionId)) throw new Error(`revision graph contains a cycle at ${revisionId}`);
      if (visited.has(revisionId)) return;
      visiting.add(revisionId);
      for (const parentId of revisions[revisionId].parents) {
        if (revisions[parentId]) visit(parentId);
      }
      visiting.delete(revisionId);
      visited.add(revisionId);
    }
    for (const revisionId of Object.keys(revisions).sort(compareStrings)) visit(revisionId);
  }

  async function materialize(state, cryptoContext) {
    validateRevisionGraph(state.revisions);
    const desired = assignMaterializedPaths(state.revisions);
    const prepared = new Map();
    for (const [target, candidate] of desired) {
      const stored = await remote.get(`${BLOB_PREFIX}/${candidate.revision.blob}`);
      const actualHash = sha256(stored);
      if (actualHash !== candidate.revision.blob) {
        throw new Error(
          `blob SHA-256 mismatch: expected ${candidate.revision.blob}, got ${actualHash}`,
        );
      }
      const raw = decodeBlob(stored, cryptoContext);
      prepared.set(target, { ...candidate, raw, contentHash: sha256(raw) });
    }

    const current = scanMap(await local.scan());
    const localHashes = new Map([...current].map(([notePath, item]) => [notePath, item.contentHash]));
    const baseline = clone(state.tracked);
    const desiredTracked = {};
    for (const [target, item] of prepared) {
      desiredTracked[target] = {
        fileId: item.fileId,
        head: item.revision.revisionId,
        hash: item.revision.blob,
        contentHash: item.contentHash,
      };
    }
    state.materializing = { baseline, desired: clone(desiredTracked), localChanged: {} };
    await stateStore.save(state);

    async function materializeMutation(notePath, operation) {
      try {
        return await operation();
      } catch (error) {
        if (error?.code === 'LOCAL_CHANGED_DURING_SYNC') {
          state.materializing.localChanged[notePath] = true;
          await stateStore.save(state);
        }
        throw error;
      }
    }

    const tracked = {};
    for (const oldPath of Object.keys(baseline).sort(compareStrings)) {
      if (prepared.has(oldPath)) continue;
      const actualHash = localHashes.get(oldPath);
      if (actualHash === undefined) continue;
      if (actualHash === baseline[oldPath].contentHash) {
        await materializeMutation(oldPath, () => local.deleteRaw(oldPath, {
          expectedContentHash: actualHash,
        }));
        localHashes.delete(oldPath);
      } else {
        tracked[oldPath] = baseline[oldPath];
      }
    }
    for (const [target, item] of prepared) {
      const actualHash = localHashes.get(target);
      const old = baseline[target];
      const safeToApply = actualHash === undefined || (old && actualHash === old.contentHash);
      if (actualHash === item.contentHash) {
        tracked[target] = desiredTracked[target];
      } else if (safeToApply) {
        await materializeMutation(target, () => local.applyRaw(target, item.raw, {
          expectedContentHash: actualHash ?? null,
        }));
        tracked[target] = desiredTracked[target];
      } else if (old) {
        tracked[target] = old;
      } else if (actualHash !== undefined) {
        await materializeMutation(target, async () => {
          throw localChangedDuringSyncError();
        });
      }
    }
    state.tracked = tracked;
    state.materializing = null;
    await stateStore.save(state);
  }

  async function run() {
    setStatus('syncing');
    try {
      const state = await loadState();
      const opened = await openRemote(state);
      const activeVaultId = opened.meta.vaultId;
      const cryptoContext = { key: opened.key, vaultId: activeVaultId };
      await reconcileMaterializing(state);
      let uploadedSegments = 0;
      for (let attempts = 0; attempts < 16; attempts += 1) {
        await formPending(state, cryptoContext);
        if (!state.pending) break;
        uploadedSegments += await uploadPending(state, cryptoContext, opened);
      }
      await formPending(state, cryptoContext);
      if (state.pending) {
        throw new Error('local changes did not stabilize during sync; pending upload retained');
      }
      const downloadedSegments = await pullSegments(state, cryptoContext);
      await materialize(state, cryptoContext);
      const result = Object.freeze({ uploadedSegments, downloadedSegments });
      setStatus('synced');
      return result;
    } catch (error) {
      setStatus('error', error);
      throw error;
    }
  }

  function sync() {
    if (closed) return Promise.reject(new Error('sync engine is closed'));
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    sync,
    getStatus() {
      return status;
    },
    getState: loadState,
    close() {
      closed = true;
    },
  };
}
