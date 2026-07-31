import { seal, open } from './crypto.js';

const VERSION = 1;

function exactFields(value, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has invalid fields`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`);
}

function validateId(value, label) {
  if (
    typeof value !== 'string'
    || !value
    || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`${label} must contain no whitespace or control characters`);
  }
}

export function validateDeviceId(value) {
  validateId(value, 'deviceId');
  if (value.includes('/') || value.includes('\\')) {
    throw new Error('deviceId must not contain routing separators');
  }
  return true;
}

function validatePath(value) {
  nonEmptyString(value, 'path');
  if (
    value.startsWith('/')
    || value.includes('\\')
    || value.includes('//')
    || !/\.md$/iu.test(value)
  ) {
    throw new Error('path must be a safe POSIX relative .md path');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('path must not traverse or contain dot directories');
  }
}

export function validateRevision(revision) {
  const kind = revision?.kind;
  if (kind !== 'put' && kind !== 'delete') throw new Error('revision kind must be put or delete');
  const fields = [
    'kind', 'fileId', 'revisionId', 'parents', 'path', 'deviceId', 'timestamp',
    ...(kind === 'put' ? ['blob'] : []),
  ];
  exactFields(revision, fields, 'revision');
  validateId(revision.fileId, 'fileId');
  validateId(revision.revisionId, 'revisionId');
  validateDeviceId(revision.deviceId);
  validatePath(revision.path);
  if (!Array.isArray(revision.parents)) {
    throw new Error('parents must be an array of revision IDs');
  }
  for (const parent of revision.parents) validateId(parent, 'parent revision ID');
  if (new Set(revision.parents).size !== revision.parents.length) {
    throw new Error('parents must not contain duplicates');
  }
  nonEmptyString(revision.timestamp, 'timestamp');
  const parsedTimestamp = new Date(revision.timestamp);
  if (Number.isNaN(parsedTimestamp.valueOf()) || parsedTimestamp.toISOString() !== revision.timestamp) {
    throw new Error('timestamp must be an ISO instant');
  }
  if (kind === 'put' && !/^[a-f0-9]{64}$/.test(revision.blob)) {
    throw new Error('put blob must be a lowercase SHA-256 hash');
  }
  return true;
}

export function createRevision(revision) {
  validateRevision(revision);
  return Object.freeze({
    ...revision,
    parents: Object.freeze([...revision.parents]),
  });
}

export function validateSegment(segment) {
  exactFields(segment, ['version', 'deviceId', 'sequence', 'revisions'], 'segment');
  if (segment.version !== VERSION) throw new Error('unsupported segment version');
  validateDeviceId(segment.deviceId);
  if (!Number.isSafeInteger(segment.sequence) || segment.sequence < 0) {
    throw new Error('sequence must be a non-negative safe integer');
  }
  if (!Array.isArray(segment.revisions)) throw new Error('revisions must be an array');
  for (const revision of segment.revisions) {
    validateRevision(revision);
    if (revision.deviceId !== segment.deviceId) {
      throw new Error('revision deviceId must match segment deviceId');
    }
  }
  return true;
}

export function createSegment({ deviceId, sequence, revisions }) {
  const segment = {
    version: VERSION,
    deviceId,
    sequence,
    revisions: Array.isArray(revisions)
      ? Object.freeze(revisions.map(createRevision))
      : revisions,
  };
  validateSegment(segment);
  return Object.freeze(segment);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error(`invalid ${label} JSON`);
  }
}

export function encodeSegment(segment, { key = null, vaultId }) {
  validateSegment(segment);
  if (!key) {
    return Buffer.from(JSON.stringify({
      version: VERSION,
      encrypted: false,
      deviceId: segment.deviceId,
      sequence: segment.sequence,
      revisions: segment.revisions,
    }));
  }
  const payload = Buffer.from(JSON.stringify({
    deviceId: segment.deviceId,
    sequence: segment.sequence,
    revisions: segment.revisions,
  }));
  return Buffer.from(JSON.stringify({
    version: VERSION,
    encrypted: true,
    deviceId: segment.deviceId,
    sequence: segment.sequence,
    envelope: seal(payload, key, { vaultId, type: 'segment' }),
  }));
}

export function decodeSegment(bytes, { key = null, vaultId }) {
  const outer = parseJson(bytes, 'segment');
  if (outer?.version !== VERSION) throw new Error('unsupported segment version');
  if (typeof outer.encrypted !== 'boolean') throw new Error('segment encrypted flag is required');
  if (outer.encrypted !== Boolean(key)) throw new Error('segment encryption mode does not match key');

  let segment;
  if (!outer.encrypted) {
    exactFields(
      outer,
      ['version', 'encrypted', 'deviceId', 'sequence', 'revisions'],
      'plaintext segment',
    );
    segment = {
      version: outer.version,
      deviceId: outer.deviceId,
      sequence: outer.sequence,
      revisions: outer.revisions,
    };
  } else {
    exactFields(
      outer,
      ['version', 'encrypted', 'deviceId', 'sequence', 'envelope'],
      'encrypted segment',
    );
    const plaintext = open(outer.envelope, key, { vaultId, type: 'segment' });
    const payload = parseJson(plaintext, 'segment payload');
    exactFields(payload, ['deviceId', 'sequence', 'revisions'], 'segment payload');
    if (payload.deviceId !== outer.deviceId || payload.sequence !== outer.sequence) {
      throw new Error('encrypted segment routing fields were tampered with');
    }
    segment = {
      version: outer.version,
      deviceId: outer.deviceId,
      sequence: outer.sequence,
      revisions: payload.revisions,
    };
  }
  return createSegment(segment);
}
