import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { EditorRoot, type EditorViewController, type EditorViewSnapshot } from './EditorRoot';
import './editor.css';
import type {
  EditorHandle,
  EditorSaveStatus,
  EditorSelectionSnapshot,
  MountEditorOptions,
  NoteDocument,
  WikiClient,
} from './types';
import { AutosaveFlushError, createAutosaveController } from './autosave';
import { createWikinestEditor, type WikinestEditor } from './editor/create-editor';
import { serializeDocument } from './editor/markdown';
import { planAiSlice, serializeSelection } from './editor/selection';
import { HttpWikiClient } from './wiki-client';

export function createEditorClient(): HttpWikiClient {
  return new HttpWikiClient();
}

interface EditorState {
  path: string;
  version: string;
  status: EditorSaveStatus;
  revision: number;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((nextResolve) => {
      resolve = nextResolve;
    }),
    resolve,
  };
}

class UnifiedEditorController implements EditorViewController, EditorHandle {
  #state: EditorState = {
    path: '',
    version: '',
    status: 'saved',
    revision: 0,
  };

  #viewSnapshot: EditorViewSnapshot = {
    path: '',
    status: 'saved',
  };

  #listeners = new Set<() => void>();

  #root: Root;

  #options: MountEditorOptions & { client: WikiClient };

  #editorRoot: HTMLDivElement | null = null;

  #editorRootReady = deferred<HTMLDivElement>();

  #editor: WikinestEditor | null = null;

  #autosave: ReturnType<typeof createAutosaveController> | null = null;

  #document: NoteDocument | null = null;

  #destroyed = false;

  #loading = false;

  #loadGeneration = 0;

  #loadQueue: Promise<void> = Promise.resolve();

  #composing = false;

  #editorEvents = new WeakMap<WikinestEditor, {
    dom: HTMLElement;
    compositionStart: EventListener;
    compositionEnd: EventListener;
    keydown: EventListener;
  }>();

  constructor(root: Root, options: MountEditorOptions & { client: WikiClient }) {
    this.#root = root;
    this.#options = options;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): EditorViewSnapshot => {
    return this.#viewSnapshot;
  };

  attachEditorRoot = (element: HTMLDivElement | null): void => {
    this.#editorRoot = element;
    if (element) this.#editorRootReady.resolve(element);
  };

  async load(document: NoteDocument): Promise<void> {
    if (this.#destroyed) return;
    const generation = ++this.#loadGeneration;
    const load = this.#loadQueue.catch(() => undefined).then(() => this.#performLoad(document, generation));
    this.#loadQueue = load;
    return load;
  }

  async #performLoad(document: NoteDocument, generation: number): Promise<void> {
    if (this.#destroyed || generation !== this.#loadGeneration) return;
    this.#loading = true;
    const editorRoot = this.#editorRoot || await this.#editorRootReady.promise;
    if (this.#destroyed || generation !== this.#loadGeneration) return;

    if (!this.#editor) {
      const candidate = await createWikinestEditor({
        root: editorRoot,
        markdown: document.markdown,
        onMarkdownChange: (markdown) => this.#onMarkdownChange(markdown),
        onSelectionChange: () => this.#options.onSelectionChange?.(),
        uploadImage: (file, signal) => this.#options.client.uploadImage(file, signal),
      });
      if (this.#destroyed || generation !== this.#loadGeneration) {
        await candidate.destroy();
        return;
      }
      this.#editor = candidate;
      this.#bindEditorEvents(candidate);
    } else {
      this.#editor.replaceMarkdown(document.markdown);
    }

    if (this.#destroyed || generation !== this.#loadGeneration) return;
    if (!this.#autosave) {
      this.#autosave = createAutosaveController({
        document,
        save: async (input) => {
          this.#emit();
          try {
            const result = await this.#options.client.saveNote(input);
            this.#options.onSaved?.(result);
            return result;
          } finally {
            queueMicrotask(() => this.#syncAutosaveState());
          }
        },
      });
    } else {
      this.#autosave.replaceBaseline(document);
    }
    this.#document = document;
    this.#setState({
      path: document.path,
      version: document.version,
      status: 'saved',
      revision: 0,
    });
    this.#loading = false;
  }

  async flush(): Promise<void> {
    try {
      if (!this.#autosave) return;
      if (this.#composing) {
        this.#editor?.getView().dom.blur();
        await Promise.resolve();
      }
      await this.#autosave.flush();
    } catch (error) {
      this.#syncAutosaveState();
      throw error;
    }
    this.#syncAutosaveState();
  }

  focus(): void {
    this.#editor?.getView().focus();
  }

  getMarkdown(): string {
    return this.#editor ? serializeDocument(this.#editor.editor, this.#editor.getView()) : '';
  }

  getDocumentState() {
    return {
      path: this.#state.path,
      version: this.#state.version,
      status: this.#state.status,
      revision: this.#state.revision,
    };
  }

  getSelectionSnapshot(): EditorSelectionSnapshot | null {
    if (!this.#editor || !this.#autosave || !this.#state.path) return null;
    const { from, to } = this.#editor.getView().state.selection;
    if (from === to) return null;

    return {
      path: this.#state.path,
      docRevision: this.#autosave.snapshot().revision,
      from,
      to,
      selectedMarkdown: serializeSelection(this.#editor.getView(), from, to, this.#editor.editor),
    };
  }

  applyAiResult(
    snapshot: EditorSelectionSnapshot,
    markdown: string,
    mode: 'replace' | 'insert',
  ): boolean {
    if (
      !this.#editor
      || !this.#autosave
      || snapshot.path !== this.#state.path
      || snapshot.docRevision !== this.#autosave.snapshot().revision
    ) {
      return false;
    }

    const view = this.#editor.getView();
    const { doc } = view.state;
    if (
      snapshot.from < 0
      || snapshot.to < snapshot.from
      || snapshot.to > doc.content.size
      || serializeSelection(view, snapshot.from, snapshot.to, this.#editor.editor) !== snapshot.selectedMarkdown
    ) {
      return false;
    }
    const replacement = planAiSlice(
      this.#editor.editor,
      view,
      markdown,
      mode,
      snapshot.from,
      snapshot.to,
    );
    if (!replacement) return false;
    try {
      view.dispatch(view.state.tr
        .replace(replacement.from, replacement.to, replacement.slice)
        .scrollIntoView());
    } catch {
      return false;
    }
    return true;
  }

  retry = (): void => {
    this.#autosave?.retry();
    this.#syncAutosaveState();
  };

  openConflict = (): void => {
    const conflictPath = this.#autosave?.snapshot().conflictPath;
    if (conflictPath) this.#options.onConflictOpen(conflictPath);
  };

  openImagePicker = (): void => {
    this.#editor?.openImagePicker();
  };

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#loadGeneration += 1;
    this.#autosave?.destroy();
    this.#autosave = null;
    if (this.#editor) {
      this.#unbindEditorEvents(this.#editor);
      void this.#editor.destroy();
    }
    this.#editor = null;
    this.#listeners.clear();
    this.#root.unmount();
  }

  #bindEditorEvents(editor: WikinestEditor): void {
    const dom = editor.getView().dom;
    const compositionStart: EventListener = () => {
      this.#composing = true;
      this.#autosave?.setComposing(true);
    };
    const compositionEnd: EventListener = () => {
      this.#composing = false;
      this.#autosave?.setComposing(false);
      this.#syncAutosaveState();
    };
    const keydown: EventListener = (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.flush().catch(() => undefined);
      }
    };
    dom.addEventListener('compositionstart', compositionStart);
    dom.addEventListener('compositionend', compositionEnd);
    dom.addEventListener('keydown', keydown);
    this.#editorEvents.set(editor, { dom, compositionStart, compositionEnd, keydown });
  }

  #unbindEditorEvents(editor: WikinestEditor): void {
    const events = this.#editorEvents.get(editor);
    if (!events) return;
    events.dom.removeEventListener('compositionstart', events.compositionStart);
    events.dom.removeEventListener('compositionend', events.compositionEnd);
    events.dom.removeEventListener('keydown', events.keydown);
    this.#editorEvents.delete(editor);
  }

  #setState(partial: Partial<EditorState>): void {
    this.#state = { ...this.#state, ...partial };
    this.#viewSnapshot = {
      path: this.#state.path,
      status: this.#state.status,
    };
    this.#emit();
  }

  #emit(): void {
    this.#options.onStatus(this.#state.status);
    for (const listener of this.#listeners) listener();
  }

  #onMarkdownChange(markdown: string): void {
    if (this.#destroyed || this.#loading || !this.#autosave) return;
    this.#autosave.change(markdown);
    this.#syncAutosaveState();
  }

  #syncAutosaveState(): void {
    if (!this.#autosave || this.#destroyed) return;
    const snapshot = this.#autosave.snapshot();
    this.#setState({
      path: snapshot.path,
      version: snapshot.baseVersion,
      status: snapshot.status,
      revision: snapshot.revision,
    });
  }
}

export function mountUnifiedEditor(options: MountEditorOptions): EditorHandle {
  const resolvedOptions: MountEditorOptions & { client: NonNullable<MountEditorOptions['client']> } = {
    ...options,
    client: options.client || createEditorClient(),
  };
  const root = createRoot(options.element);
  const controller = new UnifiedEditorController(root, resolvedOptions);
  root.render(<EditorRoot controller={controller} locale={resolvedOptions.locale} />);
  return controller;
}

declare global {
  interface Window {
    WikinestEditor: {
      mount(options: MountEditorOptions): EditorHandle;
      createClient(): HttpWikiClient;
    };
  }
}

window.WikinestEditor = { mount: mountUnifiedEditor, createClient: createEditorClient };
window.dispatchEvent(new Event('wikinest-editor-ready'));
