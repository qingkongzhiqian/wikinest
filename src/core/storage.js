import crypto from 'node:crypto';
import path from 'node:path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

// S3-compatible object storage for images. Works with AWS S3, Cloudflare R2,
// 阿里云 OSS, MinIO, etc. — you only change environment variables, not code.
//
// Required env:
//   S3_BUCKET            bucket name
//   S3_ACCESS_KEY_ID     access key
//   S3_SECRET_ACCESS_KEY secret key
// Recommended:
//   S3_PUBLIC_BASE_URL   public URL prefix for reading files (CDN or bucket domain)
// Provider-specific:
//   S3_ENDPOINT          custom endpoint (R2/OSS/MinIO need this; AWS can omit)
//   S3_REGION            region (default: "auto")
//   S3_KEY_PREFIX        key prefix inside the bucket (default: "wiki-images/")
//   S3_FORCE_PATH_STYLE  "true" for MinIO / path-style endpoints

const ALLOWED = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

export const MAX_UPLOAD_BYTES = Number(process.env.S3_MAX_UPLOAD_BYTES || 15 * 1024 * 1024);

function cfg() {
  return {
    bucket: process.env.S3_BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'auto',
    publicBase: (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    keyPrefix: (process.env.S3_KEY_PREFIX ?? 'wiki-images/').replace(/^\/+/, ''),
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true',
  };
}

/** True when the minimum credentials/bucket are present. */
export function isStorageConfigured() {
  const c = cfg();
  return Boolean(c.bucket && c.accessKeyId && c.secretAccessKey);
}

let _client;
function client(c) {
  if (_client) return _client;
  _client = new S3Client({
    region: c.region,
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
  return _client;
}

/**
 * Drop the cached S3 client so the next upload/delete rebuilds it from the
 * current env. Call this after live-updating the S3_* settings (desktop app)
 * so the change takes effect without a restart.
 */
export function resetStorageClient() {
  _client = undefined;
}

// A short, filesystem/URL-safe slug from the original name (sans extension).
function slugify(name) {
  const base = path.basename(name || '', path.extname(name || ''));
  const slug = base
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-') // keep word chars + CJK
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'image';
}

function buildKey(c, filename, ext) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const rand = crypto.randomBytes(4).toString('hex');
  return `${c.keyPrefix}${yyyy}/${mm}/${slugify(filename)}-${rand}.${ext}`;
}

function publicUrl(c, key) {
  if (c.publicBase) return `${c.publicBase}/${key}`;
  // Fall back to endpoint + bucket. Path-style: endpoint/bucket/key.
  if (c.endpoint) {
    const ep = c.endpoint.replace(/\/+$/, '');
    return c.forcePathStyle ? `${ep}/${c.bucket}/${key}` : `${ep}/${key}`;
  }
  // Native AWS virtual-hosted style.
  const region = c.region && c.region !== 'auto' ? `.${c.region}` : '';
  return `https://${c.bucket}.s3${region}.amazonaws.com/${key}`;
}

/**
 * Upload an image buffer to the configured bucket.
 * @returns {Promise<{ url: string, key: string }>}
 */
export async function uploadImage(buffer, { filename = 'image', contentType } = {}) {
  if (!isStorageConfigured()) {
    throw new Error('对象存储未配置:请设置 S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY 等环境变量');
  }
  const ext = ALLOWED[contentType];
  if (!ext) {
    throw new Error(`不支持的图片类型: ${contentType || '(未知)'}`);
  }
  if (!buffer || !buffer.length) throw new Error('空文件');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`文件过大 (>${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`);
  }

  const c = cfg();
  const key = buildKey(c, filename, ext);
  await client(c).send(new PutObjectCommand({
    Bucket: c.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return { url: publicUrl(c, key), key };
}

// Reverse of publicUrl: return the object key if `url` points at an image we
// uploaded (under our key prefix), else null. The prefix check is a safety
// guard so we never delete unrelated objects that merely share the domain.
export function ownedKeyFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const c = cfg();
  const prefixes = [];
  if (c.publicBase) prefixes.push(`${c.publicBase}/`);
  if (c.endpoint) {
    const ep = c.endpoint.replace(/\/+$/, '');
    prefixes.push(c.forcePathStyle ? `${ep}/${c.bucket}/` : `${ep}/`);
  }
  const region = c.region && c.region !== 'auto' ? `.${c.region}` : '';
  prefixes.push(`https://${c.bucket}.s3${region}.amazonaws.com/`);
  for (const pre of prefixes) {
    if (url.startsWith(pre)) {
      const key = decodeURIComponent(url.slice(pre.length).split(/[?#]/)[0]);
      if (c.keyPrefix && !key.startsWith(c.keyPrefix)) return null;
      return key || null;
    }
  }
  return null;
}

/** Delete an uploaded image by its public URL. Returns true if a delete ran. */
export async function deleteImageByUrl(url) {
  if (!isStorageConfigured()) return false;
  const key = ownedKeyFromUrl(url);
  if (!key) return false;
  const c = cfg();
  await client(c).send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
  return true;
}

/** Extract markdown image URLs from a note body. */
export function extractImageUrls(markdown) {
  const urls = new Set();
  const re = /!\[[^\]]*\]\(\s*(\S+?)\s*(?:"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(markdown || '')) !== null) urls.add(m[1]);
  return [...urls];
}
