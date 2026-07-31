import { randomUUID } from 'node:crypto';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
}

function safeParts(value, { allowEmpty = false, label = 'key' } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value)) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.startsWith('/') || value.includes('\\') || value.includes('//')) {
    throw new Error(`${label} must be a safe relative key`);
  }
  const parts = value ? value.split('/') : [];
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must not escape its prefix`);
  }
  return parts;
}

function normalizePrefix(value = '') {
  if (typeof value !== 'string') throw new Error('prefix must be a string');
  const stripped = value.replace(/^\/+|\/+$/g, '');
  const collapsed = stripped.replace(/\/+/g, '/');
  safeParts(collapsed, { allowEmpty: true, label: 'prefix' });
  return collapsed ? `${collapsed}/` : '';
}

function normalizeEndpoint(value) {
  if (value == null || value === '') return 'aws';
  nonEmptyString(value, 'endpoint');
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error('endpoint must be a valid URL', { cause: error });
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
  return parsed.toString().replace(/\/$/u, '');
}

async function bodyToBuffer(body) {
  if (!body) throw new Error('S3 object has no body');
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new Error('unsupported S3 body type');
}

function isPreconditionFailed(error) {
  return error?.name === 'PreconditionFailed'
    || error?.code === 'PreconditionFailed'
    || error?.$metadata?.httpStatusCode === 412;
}

export function createS3Adapter(config, { client: injectedClient } = {}) {
  if (!config || typeof config !== 'object') throw new Error('S3 config is required');
  nonEmptyString(config.bucket, 'bucket');
  const prefix = normalizePrefix(config.prefix);
  const endpointIdentity = normalizeEndpoint(config.endpoint);
  const region = config.region ?? 'auto';
  const client = injectedClient ?? new S3Client({
    endpoint: config.endpoint,
    region,
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: config.credentials,
  });

  function objectKey(relativeKey) {
    safeParts(relativeKey);
    return `${prefix}${relativeKey}`;
  }

  function listPrefix(relativePrefix = '') {
    const parts = safeParts(relativePrefix, { allowEmpty: true });
    return `${prefix}${parts.join('/')}${parts.length ? '/' : ''}`;
  }

  async function list(relativePrefix = '') {
    const requestedPrefix = listPrefix(relativePrefix);
    const keys = [];
    let continuationToken;
    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: requestedPrefix,
        ContinuationToken: continuationToken,
      }));
      for (const item of page.Contents ?? []) {
        if (
          typeof item.Key === 'string'
          && item.Key.startsWith(requestedPrefix)
          && item.Key !== requestedPrefix
        ) {
          keys.push(item.Key.slice(prefix.length));
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !continuationToken) {
        throw new Error('S3 truncated list response is missing continuation token');
      }
    } while (continuationToken);
    return keys;
  }

  async function get(relativeKey) {
    const response = await client.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: objectKey(relativeKey),
    }));
    return bodyToBuffer(response.Body);
  }

  async function put(relativeKey, body, { contentType } = {}) {
    return client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey(relativeKey),
      Body: Buffer.from(body),
      ...(contentType ? { ContentType: contentType } : {}),
    }));
  }

  async function putIfAbsent(relativeKey, body, { contentType } = {}) {
    try {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: objectKey(relativeKey),
        Body: Buffer.from(body),
        IfNoneMatch: '*',
        ...(contentType ? { ContentType: contentType } : {}),
      }));
      return true;
    } catch (error) {
      if (isPreconditionFailed(error)) return false;
      throw error;
    }
  }

  async function head(relativeKey) {
    return client.send(new HeadObjectCommand({
      Bucket: config.bucket,
      Key: objectKey(relativeKey),
    }));
  }

  async function remove(relativeKey) {
    return client.send(new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: objectKey(relativeKey),
    }));
  }

  async function testConnection() {
    const key = `_probe/${randomUUID()}`;
    const expected = Buffer.from(randomUUID());
    let failure;
    try {
      await put(key, expected, { contentType: 'application/octet-stream' });
      const actual = await get(key);
      if (!actual.equals(expected)) throw new Error('S3 probe content mismatch');
      const visible = await list('_probe');
      if (!visible.includes(key)) {
        throw new Error('S3 probe is not visible through ListObjects');
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await remove(key);
      } catch (deleteError) {
        if (!failure) failure = deleteError;
      }
    }
    if (failure) throw failure;
    return true;
  }

  return {
    prefix,
    namespaceId: `s3:${endpointIdentity}:${region}:${config.bucket}:${prefix}`,
    list,
    get,
    put,
    putIfAbsent,
    head,
    delete: remove,
    testConnection,
  };
}
