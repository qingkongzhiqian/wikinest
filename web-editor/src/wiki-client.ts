import type {
  NoteDocument,
  SaveNoteInput,
  SaveNoteResult,
  WikiClient,
} from './types';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ErrorBody {
  code?: string;
  conflictPath?: string;
  currentVersion?: string;
}

const MAX_ERROR_JSON_BYTES = 64 * 1024;
const SAFE_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const SAFE_VERSION_RE = /^[a-f0-9]{64}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function safeCode(code: unknown, status: number): string {
  return typeof code === 'string' && SAFE_CODE_RE.test(code)
    ? code
    : `HTTP_${status}`;
}

function safeConflictPath(conflictPath: unknown): string | undefined {
  if (typeof conflictPath !== 'string' || !conflictPath.endsWith('.md')) return undefined;
  if (CONTROL_CHAR_RE.test(conflictPath)) return undefined;
  if (
    conflictPath.includes('\\')
    || conflictPath.includes(':')
    || conflictPath.startsWith('/')
    || conflictPath.endsWith('/')
  ) return undefined;
  if (conflictPath.split('/').some((segment) => (
    !segment || segment === '.' || segment === '..'
  ))) return undefined;
  return conflictPath;
}

function safeCurrentVersion(currentVersion: unknown): string | undefined {
  return typeof currentVersion === 'string' && SAFE_VERSION_RE.test(currentVersion)
    ? currentVersion
    : undefined;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore cancellation failures; the response is already terminal for callers.
  }
}

export async function readJsonTextWithLimit(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let total = 0;
  let shouldCancel = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        shouldCancel = true;
        return null;
      }
      chunks.push(value);
    }
  } catch {
    shouldCancel = true;
    return null;
  } finally {
    try {
      if (shouldCancel) {
        await reader.cancel();
      }
    } catch {
      // Cleanup is best-effort and must not change the original result.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Cleanup is best-effort and must not change the original result.
      }
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class WikiClientError extends Error {
  status: number;

  code: string;

  conflictPath?: string;

  currentVersion?: string;

  constructor(status: number, body: ErrorBody = {}) {
    const code = safeCode(body.code, status);
    super(`Wiki request failed (${code})`);
    Object.defineProperty(this, 'name', {
      value: 'WikiClientError',
      configurable: true,
      writable: true,
      enumerable: false,
    });
    this.status = status;
    this.code = code;

    const conflictPath = safeConflictPath(body.conflictPath);
    if (conflictPath !== undefined) this.conflictPath = conflictPath;

    const currentVersion = safeCurrentVersion(body.currentVersion);
    if (currentVersion !== undefined) this.currentVersion = currentVersion;
  }
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    await cancelBody(response);
    return {};
  }

  try {
    const text = await readJsonTextWithLimit(response, MAX_ERROR_JSON_BYTES);
    if (!text) return {};
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object') return {};
    return {
      code: safeCode((body as ErrorBody).code, response.status),
      conflictPath: safeConflictPath((body as ErrorBody).conflictPath),
      currentVersion: safeCurrentVersion((body as ErrorBody).currentVersion),
    };
  } catch {
    return {};
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  return body as T;
}

export class HttpWikiClient implements WikiClient {
  #fetchImpl: FetchLike;

  constructor(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.#fetchImpl = fetchImpl;
  }

  async readNote(path: string): Promise<NoteDocument> {
    const response = await this.#fetchImpl(`/api/note?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      throw new WikiClientError(response.status, await readErrorBody(response));
    }

    const body = await readJson<{
      path: string;
      content: string;
      data?: Record<string, unknown>;
      version: string;
    }>(response);

    return {
      path: body.path,
      markdown: body.content,
      frontmatter: body.data || {},
      version: body.version,
    };
  }

  async saveNote(input: SaveNoteInput): Promise<SaveNoteResult> {
    const response = await this.#fetchImpl('/api/note', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new WikiClientError(response.status, await readErrorBody(response));
    }

    return readJson<SaveNoteResult>(response);
  }

  async uploadImage(file: File, signal?: AbortSignal): Promise<{ url: string }> {
    const response = await this.#fetchImpl('/api/upload', {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-filename': file.name,
      },
      body: file,
      signal,
    });
    if (!response.ok) {
      throw new WikiClientError(response.status, await readErrorBody(response));
    }

    const body = await readJson<{ url: string }>(response);
    return { url: body.url };
  }
}

export type { WikiClient } from './types';
