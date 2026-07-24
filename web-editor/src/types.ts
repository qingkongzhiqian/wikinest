export interface NoteDocument {
  path: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  version: string;
  isNew?: boolean;
}

export interface SaveNoteInput {
  path: string;
  markdown: string;
  baseVersion?: string;
  unique?: boolean;
}

export interface SaveNoteResult {
  path: string;
  version: string;
  conflictPath?: string;
}

export type EditorSaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface AutosaveSnapshot {
  status: EditorSaveStatus;
  path: string;
  markdown: string;
  baseVersion: string;
  unique?: boolean;
  revision: number;
  savedRevision: number;
  conflictPath?: string;
}

export interface AutosaveController {
  change(markdown: string): void;
  flush(): Promise<void>;
  retry(): void;
  replaceBaseline(document: NoteDocument): void;
  snapshot(): AutosaveSnapshot;
  destroy(): void;
  setComposing(composing: boolean): void;
}

export interface CreateAutosaveControllerOptions {
  document: NoteDocument;
  save(input: SaveNoteInput): Promise<SaveNoteResult>;
}

export interface EditorSelectionSnapshot {
  path: string;
  docRevision: number;
  from: number;
  to: number;
  selectedMarkdown: string;
}

export interface EditorHandle {
  load(document: NoteDocument): Promise<void>;
  flush(): Promise<void>;
  focus(): void;
  getMarkdown(): string;
  getDocumentState(): {
    path: string;
    version: string;
    status: EditorSaveStatus;
    revision: number;
  };
  getSelectionSnapshot(): EditorSelectionSnapshot | null;
  applyAiResult(
    snapshot: EditorSelectionSnapshot,
    markdown: string,
    mode: 'replace' | 'insert',
  ): boolean;
  destroy(): void;
}

export interface WikiClient {
  readNote(path: string): Promise<NoteDocument>;
  saveNote(input: SaveNoteInput): Promise<SaveNoteResult>;
  uploadImage(file: File, signal?: AbortSignal): Promise<{ url: string }>;
}

export interface MountEditorOptions {
  element: HTMLElement;
  client?: WikiClient;
  locale: 'en' | 'zh-CN';
  onStatus(status: EditorSaveStatus): void;
  onConflictOpen(path: string): void;
  onFatal(code: string): void;
  onSaved?(result: SaveNoteResult): void;
  onSelectionChange?(): void;
}
