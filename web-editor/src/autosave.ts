import { WikiClientError } from './wiki-client';
import type {
  AutosaveController,
  AutosaveSnapshot,
  CreateAutosaveControllerOptions,
  NoteDocument,
  SaveNoteInput,
  SaveNoteResult,
} from './types';

const AUTOSAVE_DELAY_MS = 800;

export type AutosaveFlushErrorCode = 'COMPOSITION_ACTIVE' | 'BASELINE_REPLACED' | 'DESTROYED';

export class AutosaveFlushError extends Error {
  code: AutosaveFlushErrorCode;

  constructor(code: AutosaveFlushErrorCode) {
    super(`Autosave flush failed (${code})`);
    Object.defineProperty(this, 'name', {
      value: 'AutosaveFlushError',
      configurable: true,
      writable: true,
      enumerable: false,
    });
    this.code = code;
  }
}

interface FlushWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface SaveToken {
  generation: number;
  revision: number;
}

function createSnapshot(document: NoteDocument): AutosaveSnapshot {
  return {
    status: 'saved',
    path: document.path,
    markdown: document.markdown,
    baseVersion: document.version,
    unique: document.isNew === true,
    revision: 0,
    savedRevision: 0,
  };
}

function isConflictError(error: unknown): error is WikiClientError {
  return error instanceof WikiClientError && error.code === 'NOTE_VERSION_CONFLICT';
}

export function createAutosaveController(
  options: CreateAutosaveControllerOptions,
): AutosaveController {
  let state = createSnapshot(options.document);
  let destroyed = false;
  let composing = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeSave: SaveToken | null = null;
  let flushRequested = false;
  let terminalError: unknown = null;
  let flushWaiters: FlushWaiter[] = [];

  function createFlushError(code: AutosaveFlushErrorCode): AutosaveFlushError {
    return new AutosaveFlushError(code);
  }

  function hasUnsavedChanges(): boolean {
    return state.savedRevision < state.revision;
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function resolveFlushWaiters(): void {
    const waiters = flushWaiters;
    flushWaiters = [];
    flushRequested = false;
    for (const waiter of waiters) waiter.resolve();
  }

  function rejectFlushWaiters(error: unknown): void {
    const waiters = flushWaiters;
    flushWaiters = [];
    flushRequested = false;
    for (const waiter of waiters) waiter.reject(error);
  }

  function maybeResolveFlush(): void {
    if (!flushRequested) return;
    if (activeSave) return;
    if (hasUnsavedChanges()) return;
    resolveFlushWaiters();
  }

  function scheduleSave(): void {
    if (destroyed || composing || activeSave || !hasUnsavedChanges()) return;
    if (state.status === 'error' || state.status === 'conflict') return;

    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void startSave();
    }, AUTOSAVE_DELAY_MS);
  }

  function afterSuccessfulSave(result: SaveNoteResult, token: SaveToken): void {
    if (destroyed) return;
    if (activeSave !== token || token.generation !== generation) return;

    activeSave = null;
    state = {
      ...state,
      path: result.path,
      baseVersion: result.version,
      unique: false,
      savedRevision: token.revision,
      status: token.revision === state.revision ? 'saved' : 'saving',
      conflictPath: undefined,
    };

    if (token.revision === state.revision) {
      maybeResolveFlush();
      return;
    }

    if (composing) {
      state = { ...state, status: 'dirty' };
      return;
    }

    void startSave();
  }

  function afterFailedSave(error: unknown, token: SaveToken): void {
    if (destroyed) return;
    if (activeSave !== token || token.generation !== generation) return;

    activeSave = null;
    terminalError = error;

    if (isConflictError(error)) {
      state = {
        ...state,
        status: 'conflict',
        conflictPath: error.conflictPath || state.path,
      };
    } else {
      state = { ...state, status: 'error' };
    }

    rejectFlushWaiters(error);
  }

  function startSave(allowRetry = false): Promise<void> {
    if (destroyed || composing || activeSave || !hasUnsavedChanges()) {
      maybeResolveFlush();
      return Promise.resolve();
    }
    if (state.status === 'conflict') return Promise.resolve();
    if (state.status === 'error' && !allowRetry) return Promise.resolve();

    clearTimer();
    terminalError = null;

    state = {
      ...state,
      status: 'saving',
      conflictPath: undefined,
    };

    const token: SaveToken = {
      generation,
      revision: state.revision,
    };
    const input: SaveNoteInput = {
      path: state.path,
      markdown: state.markdown,
      ...(state.unique ? {} : { baseVersion: state.baseVersion }),
      ...(state.unique ? { unique: true } : {}),
    };

    activeSave = token;

    return Promise.resolve()
      .then(() => options.save(input))
      .then(
        (result) => afterSuccessfulSave(result, token),
        (error) => afterFailedSave(error, token),
      );
  }

  function replaceBaseline(document: NoteDocument): void {
    generation += 1;
    clearTimer();
    activeSave = null;
    terminalError = null;
    state = createSnapshot(document);
    rejectFlushWaiters(createFlushError('BASELINE_REPLACED'));
  }

  return {
    change(markdown: string): void {
      if (destroyed) return;

      const nextRevision = state.revision + 1;
      const nextStatus = state.status === 'saving'
        ? 'saving'
        : state.status === 'error'
          ? 'error'
          : state.status === 'conflict'
            ? 'conflict'
            : 'dirty';

      state = {
        ...state,
        markdown,
        revision: nextRevision,
        status: nextStatus,
      };

      if (composing) {
        clearTimer();
        return;
      }
      if (state.status === 'error' || state.status === 'conflict') return;
      if (activeSave) return;
      if (flushRequested) {
        void startSave();
        return;
      }
      scheduleSave();
    },

    flush(): Promise<void> {
      if (destroyed) return Promise.resolve();

      clearTimer();

      if (composing) {
        if (!hasUnsavedChanges() && !activeSave) {
          return Promise.resolve();
        }
        return Promise.reject(createFlushError('COMPOSITION_ACTIVE'));
      }

      if (state.status === 'error' || state.status === 'conflict') {
        return Promise.reject(terminalError || new Error('AUTOSAVE_TERMINAL'));
      }

      if (!hasUnsavedChanges() && !activeSave) {
        return Promise.resolve();
      }

      flushRequested = true;

      if (!activeSave && !composing) {
        void startSave();
      }

      return new Promise<void>((resolve, reject) => {
        flushWaiters.push({ resolve, reject });
        maybeResolveFlush();
      });
    },

    retry(): void {
      if (destroyed || activeSave || state.status !== 'error') return;
      clearTimer();
      void startSave(true);
    },

    replaceBaseline,

    snapshot(): AutosaveSnapshot {
      return Object.freeze({ ...state });
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      clearTimer();
      activeSave = null;
      rejectFlushWaiters(createFlushError('DESTROYED'));
    },

    setComposing(nextComposing: boolean): void {
      if (destroyed) return;
      if (composing === nextComposing) return;

      composing = nextComposing;
      if (composing) {
        clearTimer();
        return;
      }

      if (state.status === 'error' || state.status === 'conflict') return;
      if (activeSave || !hasUnsavedChanges()) {
        maybeResolveFlush();
        return;
      }
      if (flushRequested) {
        void startSave();
        return;
      }
      scheduleSave();
    },
  };
}
