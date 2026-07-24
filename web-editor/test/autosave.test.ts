import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutosaveFlushError, createAutosaveController } from '../src/autosave';
import type { NoteDocument, SaveNoteInput, SaveNoteResult } from '../src/types';
import { WikiClientError } from '../src/wiki-client';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createDocument(overrides: Partial<NoteDocument> = {}): NoteDocument {
  return {
    path: 'notes/a.md',
    markdown: '# hello',
    frontmatter: {},
    version: 'a'.repeat(64),
    ...overrides,
  };
}

function createSaveResult(input: SaveNoteInput, version: string): SaveNoteResult {
  return {
    path: input.path,
    version,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createAutosaveController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits exactly 800ms before starting a save', async () => {
    const save = vi.fn(async (input: SaveNoteInput) => createSaveResult(input, 'b'.repeat(64)));
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({
      path: 'notes/a.md',
      markdown: '# one',
      baseVersion: 'a'.repeat(64),
    });
  });

  it('creates a new draft without baseVersion then chains its returned version', async () => {
    const save = vi.fn(async (input: SaveNoteInput) => createSaveResult(input, 'b'.repeat(64)));
    const controller = createAutosaveController({
      document: createDocument({
        path: 'notes/untitled.md',
        version: '',
        isNew: true,
      }),
      save,
    });

    controller.change('# first');
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenLastCalledWith({
      path: 'notes/untitled.md',
      markdown: '# first',
      unique: true,
    });

    controller.change('# second');
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenLastCalledWith({
      path: 'notes/untitled.md',
      markdown: '# second',
      baseVersion: 'b'.repeat(64),
    });
  });

  it('never schedules while composing and restarts 800ms from the final value', async () => {
    const save = vi.fn(async (input: SaveNoteInput) => createSaveResult(input, 'b'.repeat(64)));
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.setComposing(true);
    controller.change('# one');
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();

    controller.change('# two');
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();

    controller.setComposing(false);
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({
      path: 'notes/a.md',
      markdown: '# two',
      baseVersion: 'a'.repeat(64),
    });
  });

  it('rejects flush immediately while composing with dirty changes and never saves an intermediate composition value', async () => {
    const save = vi.fn(async (input: SaveNoteInput) => createSaveResult(input, 'b'.repeat(64)));
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.setComposing(true);
    controller.change('# pin');
    controller.change('# pinyin-final');

    await expect(controller.flush()).rejects.toMatchObject({
      code: 'COMPOSITION_ACTIVE',
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();

    controller.setComposing(false);
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      path: 'notes/a.md',
      markdown: '# pinyin-final',
      baseVersion: 'a'.repeat(64),
    });
  });

  it('resolves flush immediately while composing when nothing is dirty', async () => {
    const save = vi.fn(async (input: SaveNoteInput) => createSaveResult(input, 'b'.repeat(64)));
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.setComposing(true);
    await expect(controller.flush()).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps one in-flight save and only queues the latest revision', async () => {
    const first = createDeferred<SaveNoteResult>();
    const second = createDeferred<SaveNoteResult>();
    const saves = [first.promise, second.promise];
    let saveIndex = 0;
    const save = vi.fn((_input: SaveNoteInput) => saves[saveIndex++] as Promise<SaveNoteResult>);
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);

    controller.change('# two');
    controller.change('# three');
    expect(controller.snapshot().status).toBe('saving');

    first.resolve(createSaveResult(save.mock.calls[0][0], 'b'.repeat(64)));
    await flushMicrotasks();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toEqual({
      path: 'notes/a.md',
      markdown: '# three',
      baseVersion: 'b'.repeat(64),
    });

    second.resolve(createSaveResult(save.mock.calls[1][0], 'c'.repeat(64)));
    await controller.flush();

    expect(controller.snapshot()).toMatchObject({
      markdown: '# three',
      baseVersion: 'c'.repeat(64),
      revision: 3,
      savedRevision: 3,
      status: 'saved',
    });
  });

  it('prevents stale completion from marking a newer revision saved or overwriting markdown', async () => {
    const first = createDeferred<SaveNoteResult>();
    const second = createDeferred<SaveNoteResult>();
    const saves = [first.promise, second.promise];
    let saveIndex = 0;
    const save = vi.fn((_input: SaveNoteInput) => saves[saveIndex++] as Promise<SaveNoteResult>);
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    await vi.advanceTimersByTimeAsync(800);
    controller.change('# two');

    first.resolve(createSaveResult(save.mock.calls[0][0], 'b'.repeat(64)));
    await flushMicrotasks();

    expect(controller.snapshot()).toMatchObject({
      markdown: '# two',
      baseVersion: 'b'.repeat(64),
      revision: 2,
      savedRevision: 1,
      status: 'saving',
    });

    second.resolve(createSaveResult(save.mock.calls[1][0], 'c'.repeat(64)));
    await controller.flush();

    expect(controller.snapshot()).toMatchObject({
      markdown: '# two',
      baseVersion: 'c'.repeat(64),
      revision: 2,
      savedRevision: 2,
      status: 'saved',
    });
  });

  it('flush cancels the timer and waits until the latest queued revision is saved', async () => {
    const first = createDeferred<SaveNoteResult>();
    const second = createDeferred<SaveNoteResult>();
    const saves = [first.promise, second.promise];
    let saveIndex = 0;
    const save = vi.fn((_input: SaveNoteInput) => saves[saveIndex++] as Promise<SaveNoteResult>);
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    const flushPromise = controller.flush();
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(1);

    controller.change('# two');
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve(createSaveResult(save.mock.calls[0][0], 'b'.repeat(64)));
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toEqual({
      path: 'notes/a.md',
      markdown: '# two',
      baseVersion: 'b'.repeat(64),
    });

    second.resolve(createSaveResult(save.mock.calls[1][0], 'c'.repeat(64)));
    await flushPromise;

    expect(controller.snapshot()).toMatchObject({
      markdown: '# two',
      baseVersion: 'c'.repeat(64),
      revision: 2,
      savedRevision: 2,
      status: 'saved',
    });
  });

  it('rejects an existing flush waiter with BASELINE_REPLACED during composition', async () => {
    const first = createDeferred<SaveNoteResult>();
    const save = vi.fn((_input: SaveNoteInput) => first.promise);
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    await vi.advanceTimersByTimeAsync(800);
    const flushPromise = controller.flush();

    controller.setComposing(true);
    controller.change('# composing');
    controller.replaceBaseline(createDocument({
      path: 'notes/b.md',
      markdown: '# fresh',
      version: 'd'.repeat(64),
    }));

    await expect(flushPromise).rejects.toMatchObject({
      code: 'BASELINE_REPLACED',
    });
    expect(controller.snapshot()).toMatchObject({
      path: 'notes/b.md',
      markdown: '# fresh',
      baseVersion: 'd'.repeat(64),
      status: 'saved',
    });
  });

  it('rejects an existing flush waiter with DESTROYED during composition', async () => {
    const first = createDeferred<SaveNoteResult>();
    const save = vi.fn((_input: SaveNoteInput) => first.promise);
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    await vi.advanceTimersByTimeAsync(800);
    const flushPromise = controller.flush();

    controller.setComposing(true);
    controller.change('# composing');
    controller.destroy();

    await expect(flushPromise).rejects.toMatchObject({
      code: 'DESTROYED',
    });
  });

  it('enters error state without auto-retrying, and retry only retries the latest revision', async () => {
    const first = createDeferred<SaveNoteResult>();
    const boom = new Error('boom');
    let saveIndex = 0;
    const save = vi.fn((_input: SaveNoteInput) => {
      saveIndex += 1;
      return saveIndex === 1 ? Promise.reject(boom) : first.promise;
    });
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();

    expect(controller.snapshot()).toMatchObject({
      markdown: '# one',
      status: 'error',
      savedRevision: 0,
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);

    controller.change('# two');
    expect(controller.snapshot().status).toBe('error');

    const flushPromise = controller.flush();
    await expect(flushPromise).rejects.toBe(boom);
    expect(save).toHaveBeenCalledTimes(1);

    controller.retry();
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toEqual({
      path: 'notes/a.md',
      markdown: '# two',
      baseVersion: 'a'.repeat(64),
    });

    first.resolve(createSaveResult(save.mock.calls[1][0], 'b'.repeat(64)));
    await controller.flush();

    expect(controller.snapshot()).toMatchObject({
      markdown: '# two',
      baseVersion: 'b'.repeat(64),
      revision: 2,
      savedRevision: 2,
      status: 'saved',
    });
  });

  it('captures synchronous save throws from timer-driven saves and converges flush to error', async () => {
    const boom = new Error('boom');
    const save = vi.fn((_input: SaveNoteInput) => {
      throw boom;
    });
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();

    expect(controller.snapshot()).toMatchObject({
      markdown: '# one',
      baseVersion: 'a'.repeat(64),
      revision: 1,
      savedRevision: 0,
      status: 'error',
    });
    await expect(controller.flush()).rejects.toBe(boom);
  });

  it('captures synchronous save throws from queued follow-up saves without unhandled rejection', async () => {
    const first = createDeferred<SaveNoteResult>();
    const boom = new Error('boom');
    let saveIndex = 0;
    const save = vi.fn((input: SaveNoteInput) => {
      saveIndex += 1;
      if (saveIndex === 1) return first.promise;
      throw boom;
    });
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    await vi.advanceTimersByTimeAsync(800);
    const flushPromise = controller.flush();
    controller.change('# two');

    first.resolve(createSaveResult(save.mock.calls[0][0], 'b'.repeat(64)));
    await Promise.resolve();

    await expect(flushPromise).rejects.toBe(boom);
    expect(controller.snapshot()).toMatchObject({
      markdown: '# two',
      baseVersion: 'b'.repeat(64),
      revision: 2,
      savedRevision: 1,
      status: 'error',
    });
  });

  it('maps NOTE_VERSION_CONFLICT to conflict status and conflict path', async () => {
    const save = vi.fn(async () => {
      throw new WikiClientError(409, {
        code: 'NOTE_VERSION_CONFLICT',
        conflictPath: 'notes/conflict-copy.md',
      });
    });
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    await vi.advanceTimersByTimeAsync(800);
    await expect(controller.flush()).rejects.toMatchObject({
      code: 'NOTE_VERSION_CONFLICT',
      conflictPath: 'notes/conflict-copy.md',
    });

    expect(controller.snapshot()).toMatchObject({
      markdown: '# one',
      status: 'conflict',
      conflictPath: 'notes/conflict-copy.md',
      savedRevision: 0,
    });
  });

  it('replaceBaseline isolates generations so stale completions cannot pollute a new document', async () => {
    const first = createDeferred<SaveNoteResult>();
    const save = vi.fn((input: SaveNoteInput) => first.promise);
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    await vi.advanceTimersByTimeAsync(800);

    controller.replaceBaseline(createDocument({
      path: 'notes/b.md',
      markdown: '# fresh',
      version: 'd'.repeat(64),
    }));

    expect(controller.snapshot()).toMatchObject({
      path: 'notes/b.md',
      markdown: '# fresh',
      baseVersion: 'd'.repeat(64),
      revision: 0,
      savedRevision: 0,
      status: 'saved',
    });

    first.resolve({
      path: 'notes/a.md',
      version: 'b'.repeat(64),
    });
    await Promise.resolve();

    expect(controller.snapshot()).toMatchObject({
      path: 'notes/b.md',
      markdown: '# fresh',
      baseVersion: 'd'.repeat(64),
      revision: 0,
      savedRevision: 0,
      status: 'saved',
    });
  });

  it('destroy clears timers and makes later completions side-effect free', async () => {
    const pending = createDeferred<SaveNoteResult>();
    const save = vi.fn((input: SaveNoteInput) => pending.promise);
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    controller.change('# one');
    controller.destroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();

    const live = createAutosaveController({
      document: createDocument(),
      save,
    });
    live.change('# two');
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);

    live.destroy();
    pending.resolve(createSaveResult(save.mock.calls[0][0], 'b'.repeat(64)));
    await Promise.resolve();

    expect(live.snapshot()).toMatchObject({
      markdown: '# two',
      baseVersion: 'a'.repeat(64),
      revision: 1,
      savedRevision: 0,
      status: 'saving',
    });
  });

  it('returns frozen snapshots that callers cannot mutate', () => {
    const save = vi.fn(async (input: SaveNoteInput) => createSaveResult(input, 'b'.repeat(64)));
    const controller = createAutosaveController({
      document: createDocument(),
      save,
    });

    const initial = controller.snapshot();
    expect(Object.isFrozen(initial)).toBe(true);
    expect(() => {
      (initial as { status: string }).status = 'dirty';
    }).toThrow();

    controller.change('# one');
    const changed = controller.snapshot();
    expect(Object.isFrozen(changed)).toBe(true);
    expect(changed.markdown).toBe('# one');
    expect(initial.markdown).toBe('# hello');
  });
});
