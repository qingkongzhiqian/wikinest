import { describe, expect, it } from 'vitest';
import { HttpWikiClient, WikiClientError, readJsonTextWithLimit } from '../src/wiki-client';

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function createReaderResponse(readerOverrides: {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel?: () => Promise<void>;
  releaseLock?: () => void;
}): Response {
  return {
    ok: false,
    status: 500,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    body: {
      getReader() {
        return {
          read: readerOverrides.read,
          cancel: readerOverrides.cancel || (async () => {}),
          releaseLock: readerOverrides.releaseLock || (() => {}),
        };
      },
      locked: true,
    },
  } as Response;
}

describe('HttpWikiClient', () => {
  it('maps note and upload APIs without exposing fetch to components', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const client = new HttpWikiClient(async (url, init) => {
      calls.push([url, init]);

      if (url === '/api/upload') {
        return new Response(JSON.stringify({ ok: true, url: 'https://cdn.example.test/image.png' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        path: 'notes/a.md',
        content: '# A',
        data: { title: 'A' },
        version: 'a'.repeat(64),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const note = await client.readNote('notes/a.md');
    expect(note).toEqual({
      path: 'notes/a.md',
      markdown: '# A',
      frontmatter: { title: 'A' },
      version: 'a'.repeat(64),
    });
    expect(calls[0][0]).toBe('/api/note?path=notes%2Fa.md');

    const abort = new AbortController();
    const upload = await client.uploadImage(new File(['image-bytes'], 'image.png', { type: 'image/png' }), abort.signal);
    expect(upload).toEqual({ url: 'https://cdn.example.test/image.png' });
    expect(calls[1][0]).toBe('/api/upload');
    expect(calls[1][1]?.method).toBe('POST');
    expect(calls[1][1]?.headers).toMatchObject({
      'content-type': 'image/png',
      'x-filename': 'image.png',
    });
    expect(calls[1][1]?.signal).toBe(abort.signal);
  });

  it('sends a first unique draft save without baseVersion and versions the next request', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = new HttpWikiClient(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        path: bodies.length === 1 ? 'notes/draft-1.md' : 'notes/draft-1-2.md',
        version: bodies.length === 1 ? 'b'.repeat(64) : 'c'.repeat(64),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const first = await client.saveNote({
      path: 'notes/draft-1.md',
      markdown: 'first',
      unique: true,
    });
    await client.saveNote({
      path: first.path,
      markdown: 'second',
      baseVersion: first.version,
    });
    expect(bodies).toEqual([
      { path: 'notes/draft-1.md', markdown: 'first', unique: true },
      { path: 'notes/draft-1.md', markdown: 'second', baseVersion: 'b'.repeat(64) },
    ]);
  });

  it('throws sanitized wiki client errors without retaining raw bodies', async () => {
    const client = new HttpWikiClient(async () => new Response('raw upstream body', {
      status: 409,
      headers: { 'Content-Type': 'text/plain' },
    }));

    await expect(client.saveNote({
      path: 'notes/a.md',
      markdown: '# A',
      baseVersion: 'a'.repeat(64),
    })).rejects.toMatchObject({
      status: 409,
      code: 'HTTP_409',
    });

    await client.saveNote({
      path: 'notes/a.md',
      markdown: '# A',
      baseVersion: 'a'.repeat(64),
    }).catch((error) => {
      expect(error).toBeInstanceOf(WikiClientError);
      expect(error.message).not.toContain('raw upstream body');
      expect(error.rawBody).toBeUndefined();
      expect(error.conflictPath).toBeUndefined();
      expect(error.currentVersion).toBeUndefined();
    });
  });

  it('uses a fixed safe message and preserves only valid conflict metadata', async () => {
    const secretUrl = 'https://vault.example.test?apiKey=super-secret';
    const client = new HttpWikiClient(async () => new Response(JSON.stringify({
      code: 'NOTE_VERSION_CONFLICT',
      error: `leak ${secretUrl} and Vault token`,
      conflictPath: 'notes/conflict.md',
      currentVersion: 'b'.repeat(64),
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));

    await client.saveNote({
      path: 'notes/a.md',
      markdown: '# A',
      baseVersion: 'a'.repeat(64),
    }).catch((error) => {
      expect(error).toBeInstanceOf(WikiClientError);
      expect(error.message).toBe('Wiki request failed (NOTE_VERSION_CONFLICT)');
      expect(error.status).toBe(409);
      expect(error.code).toBe('NOTE_VERSION_CONFLICT');
      expect(error.conflictPath).toBe('notes/conflict.md');
      expect(error.currentVersion).toBe('b'.repeat(64));
      expect(error.stack).not.toContain(secretUrl);
      expect(error.stack).not.toContain('Vault');
      expect(Object.keys(error)).toEqual(['status', 'code', 'conflictPath', 'currentVersion']);
      expect(JSON.stringify({
        message: error.message,
        stack: error.stack,
        ownProps: Object.fromEntries(Object.keys(error).map((key) => [key, error[key as keyof WikiClientError]])),
      })).not.toContain(secretUrl);
    });
  });

  it('drops malicious code and conflict metadata from JSON errors', async () => {
    const client = new HttpWikiClient(async () => new Response(JSON.stringify({
      code: '../../BAD\nCODE',
      error: 'apiKey=secret',
      conflictPath: '../secrets.txt',
      currentVersion: 'not-a-version',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));

    await client.saveNote({
      path: 'notes/a.md',
      markdown: '# A',
      baseVersion: 'a'.repeat(64),
    }).catch((error) => {
      expect(error).toBeInstanceOf(WikiClientError);
      expect(error.message).toBe('Wiki request failed (HTTP_500)');
      expect(error.code).toBe('HTTP_500');
      expect(error.conflictPath).toBeUndefined();
      expect(error.currentVersion).toBeUndefined();
      expect(error.message).not.toContain('apiKey');
      expect(error.stack).not.toContain('apiKey');
    });
  });

  it('accepts only canonical POSIX relative Markdown conflict paths', async () => {
    const invalidPaths = [
      'C:conflict.md',
      'notes\\conflict.md',
      '/notes/conflict.md',
      'notes/conflict.md/',
      'notes//conflict.md',
      'notes/./conflict.md',
      'notes/../conflict.md',
      'notes/conflict.txt',
      'notes/\u0000conflict.md',
    ];

    for (const conflictPath of invalidPaths) {
      const client = new HttpWikiClient(async () => new Response(JSON.stringify({
        code: 'NOTE_VERSION_CONFLICT',
        conflictPath,
        currentVersion: 'a'.repeat(64),
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }));
      await client.saveNote({
        path: 'notes/a.md',
        markdown: '# A',
        baseVersion: 'a'.repeat(64),
      }).catch((error) => {
        expect(error).toBeInstanceOf(WikiClientError);
        expect(error.conflictPath).toBeUndefined();
      });
    }

    const client = new HttpWikiClient(async () => new Response(JSON.stringify({
      code: 'NOTE_VERSION_CONFLICT',
      conflictPath: 'notes/conflict-local.md',
      currentVersion: 'a'.repeat(64),
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));
    await client.saveNote({
      path: 'notes/a.md',
      markdown: '# A',
      baseVersion: 'a'.repeat(64),
    }).catch((error) => {
      expect(error.conflictPath).toBe('notes/conflict-local.md');
    });
  });

  it('releases the reader lock on normal EOF and unlocks real responses', async () => {
    const events = { cancel: 0, release: 0 };
    const text = await readJsonTextWithLimit(createReaderResponse({
      read: (() => {
        let step = 0;
        return async () => {
          step += 1;
          if (step === 1) {
            return { done: false, value: encodeText('{"code":"NOTE_CONFLICT"}') };
          }
          return { done: true, value: undefined };
        };
      })(),
      cancel: async () => { events.cancel += 1; },
      releaseLock: () => { events.release += 1; },
    }), 1024);

    expect(text).toBe('{"code":"NOTE_CONFLICT"}');
    expect(events).toEqual({ cancel: 0, release: 1 });

    const response = new Response('{"code":"NOTE_CONFLICT"}', {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.body?.locked).toBe(false);
    const realText = await readJsonTextWithLimit(response, 1024);
    expect(realText).toBe('{"code":"NOTE_CONFLICT"}');
    expect(response.body?.locked).toBe(false);
  });

  it('cancels on size limit, releases the lock, and unlocks real responses', async () => {
    const events = { cancel: 0, release: 0 };
    const text = await readJsonTextWithLimit(createReaderResponse({
      read: async () => ({ done: false, value: encodeText('{"code":"NOTE_CONFLICT"}') }),
      cancel: async () => { events.cancel += 1; },
      releaseLock: () => { events.release += 1; },
    }), 4);

    expect(text).toBeNull();
    expect(events).toEqual({ cancel: 1, release: 1 });

    const response = new Response('{"code":"NOTE_CONFLICT"}', {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
    const realText = await readJsonTextWithLimit(response, 4);
    expect(realText).toBeNull();
    expect(response.body?.locked).toBe(false);
  });

  it('best-effort cancels and releases when reader.read throws', async () => {
    const events = { cancel: 0, release: 0 };
    const client = new HttpWikiClient(async () => createReaderResponse({
      read: async () => { throw new Error('read failed'); },
      cancel: async () => { events.cancel += 1; },
      releaseLock: () => { events.release += 1; },
    }));

    await client.saveNote({
      path: 'notes/a.md',
      markdown: '# A',
      baseVersion: 'a'.repeat(64),
    }).catch((error) => {
      expect(error).toBeInstanceOf(WikiClientError);
      expect(error.code).toBe('HTTP_500');
      expect(error.message).toBe('Wiki request failed (HTTP_500)');
    });

    expect(events).toEqual({ cancel: 1, release: 1 });
  });

  it('releases the lock even when reader.cancel throws', async () => {
    const events = { cancel: 0, release: 0 };
    const client = new HttpWikiClient(async () => createReaderResponse({
      read: async () => ({ done: false, value: encodeText('{"code":"NOTE_CONFLICT"}') }),
      cancel: async () => {
        events.cancel += 1;
        throw new Error('cancel failed');
      },
      releaseLock: () => { events.release += 1; },
    }));

    await client.saveNote({
      path: 'notes/a.md',
      markdown: '# A',
      baseVersion: 'a'.repeat(64),
    }).catch((error) => {
      expect(error).toBeInstanceOf(WikiClientError);
      expect(error.code).toBe('HTTP_500');
      expect(error.message).toBe('Wiki request failed (HTTP_500)');
    });

    expect(events).toEqual({ cancel: 1, release: 1 });
  });
});
