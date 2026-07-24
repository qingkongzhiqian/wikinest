import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import { isSafeUploadUrl } from './safe-url';

export const MAX_IMAGE_UPLOAD_BYTES = 15 * 1024 * 1024;

export type UploadRejection = 'type' | 'size';

export interface UploadResult {
  url: string;
}

interface UploadDependencies {
  uploadImage(file: File, signal: AbortSignal): Promise<UploadResult>;
  insertPlaceholder(file: File): string;
  replacePlaceholder(placeholderId: string, image: { src: string; alt: string }): void;
  failPlaceholder(placeholderId: string, error: unknown): void;
  hasPlaceholder(placeholderId: string): boolean;
}

interface PendingUpload {
  file: File;
  controller: AbortController;
}

type PlaceholderAction =
  | { type: 'add'; id: string; position: number; file: File }
  | { type: 'fail'; id: string }
  | { type: 'remove'; id: string };

interface UploadPluginState {
  decorations: DecorationSet;
  byId: Map<string, number>;
  files: Map<string, File>;
  failed: Set<string>;
}

function indexDecorations(decorations: DecorationSet): Map<string, number> {
  const byId = new Map<string, number>();
  for (const decoration of decorations.find()) {
    const id = decoration.spec.id;
    if (typeof id === 'string') byId.set(id, decoration.from);
  }
  return byId;
}

function findDecoration(decorations: DecorationSet, id: string): Decoration | undefined {
  return decorations.find().find((decoration) => decoration.spec.id === id);
}

function imageAlt(file: File): string {
  return file.name.replace(/\.[^.]+$/, '');
}

export function createUploadController(dependencies: UploadDependencies) {
  const uploads = new Map<string, PendingUpload>();
  const placeholdersByFile = new WeakMap<File, string>();
  const filesByPlaceholder = new Map<string, File>();
  let destroyed = false;

  const run = async (placeholderId: string, file: File): Promise<void> => {
    const previous = uploads.get(placeholderId);
    previous?.controller.abort();
    const controller = new AbortController();
    uploads.set(placeholderId, { file, controller });

    try {
      const uploaded = await dependencies.uploadImage(file, controller.signal);
      if (
        destroyed
        || controller.signal.aborted
        || uploads.get(placeholderId)?.controller !== controller
        || !dependencies.hasPlaceholder(placeholderId)
      ) return;
      if (!isSafeUploadUrl(uploaded.url)) {
        throw new Error('Upload returned an unsafe image URL');
      }
      dependencies.replacePlaceholder(placeholderId, { src: uploaded.url, alt: imageAlt(file) });
      uploads.delete(placeholderId);
      placeholdersByFile.delete(file);
    } catch (error) {
      if (
        destroyed
        || controller.signal.aborted
        || uploads.get(placeholderId)?.controller !== controller
        || !dependencies.hasPlaceholder(placeholderId)
      ) return;
      uploads.delete(placeholderId);
      dependencies.failPlaceholder(placeholderId, error);
    }
  };

  return {
    async upload(file: File): Promise<{ accepted: true; placeholderId: string } | { accepted: false; reason: UploadRejection }> {
      if (!file.type.startsWith('image/')) return { accepted: false, reason: 'type' };
      if (file.size > MAX_IMAGE_UPLOAD_BYTES) return { accepted: false, reason: 'size' };

      const existing = placeholdersByFile.get(file);
      const placeholderId = existing || dependencies.insertPlaceholder(file);
      if (!existing) {
        placeholdersByFile.set(file, placeholderId);
        filesByPlaceholder.set(placeholderId, file);
      }
      await run(placeholderId, file);
      return { accepted: true, placeholderId };
    },

    async retry(placeholderId: string): Promise<void> {
      const pending = uploads.get(placeholderId);
      if (pending) return;
      const file = filesByPlaceholder.get(placeholderId);
      if (file) await run(placeholderId, file);
    },

    remove(placeholderId: string): void {
      uploads.get(placeholderId)?.controller.abort();
      uploads.delete(placeholderId);
      filesByPlaceholder.delete(placeholderId);
    },

    destroy(): void {
      destroyed = true;
      for (const pending of uploads.values()) pending.controller.abort();
      uploads.clear();
      filesByPlaceholder.clear();
    },
  };
}

export interface UploadExtension {
  uploadFiles(files: Iterable<File>): Promise<void>;
  openFilePicker(): void;
  destroy(): void;
}

export function installUploadExtension(
  view: EditorView,
  uploadImage: (file: File, signal: AbortSignal) => Promise<UploadResult>,
): UploadExtension {
  const key = new PluginKey<UploadPluginState>('wikinest-upload');
  let sequence = 0;
  let controller!: ReturnType<typeof createUploadController>;

  const placeholder = (id: string, failed: boolean, position: number) => Decoration.widget(position, () => {
    const element = document.createElement('span');
    element.className = 'wikinest-upload-placeholder';
    element.dataset.uploadPlaceholder = id;
    element.contentEditable = 'false';
    element.textContent = failed ? '图片上传失败' : '图片上传中…';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试';
    retry.hidden = !failed;
    retry.addEventListener('click', (event) => {
      event.preventDefault();
      void controller.retry(id);
    });
    element.append(' ', retry);
    return element;
  }, { key: `${id}:${failed ? 'failed' : 'pending'}`, id, failed });

  const plugin = new Plugin<UploadPluginState>({
    key,
    state: {
      init: () => ({
        decorations: DecorationSet.empty, byId: new Map(), files: new Map(), failed: new Set(),
      }),
      apply(transaction, previous) {
        let decorations = previous.decorations.map(transaction.mapping, transaction.doc);
        let byId = indexDecorations(decorations);
        const files = new Map(previous.files);
        const failed = new Set(previous.failed);
        if (transaction.docChanged) {
          const deletedIds = [...previous.files.keys()].filter((id) => !byId.has(id));
          if (deletedIds.length) {
            for (const id of deletedIds) {
              files.delete(id);
              failed.delete(id);
              queueMicrotask(() => controller?.remove(id));
            }
          }
        }
        const action = transaction.getMeta(key) as PlaceholderAction | undefined;
        if (action?.type === 'add') {
          const next = placeholder(action.id, false, action.position);
          decorations = decorations.add(transaction.doc, [next]);
          byId = indexDecorations(decorations);
          files.set(action.id, action.file);
        }
        if (action?.type === 'fail') {
          const current = findDecoration(decorations, action.id);
          if (current) {
            const next = placeholder(action.id, true, current.from);
            decorations = decorations.remove([current]).add(transaction.doc, [next]);
            byId = indexDecorations(decorations);
          }
          failed.add(action.id);
        }
        if (action?.type === 'remove') {
          const current = findDecoration(decorations, action.id);
          if (current) decorations = decorations.remove([current]);
          byId = indexDecorations(decorations);
          files.delete(action.id);
          failed.delete(action.id);
        }
        return { decorations, byId, files, failed };
      },
    },
    props: {
      decorations(state) {
        return key.getState(state)?.decorations ?? null;
      },
    },
  });
  view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, plugin] }));

  const action = (next: PlaceholderAction) => view.dispatch(view.state.tr.setMeta(key, next));
  controller = createUploadController({
    uploadImage,
    insertPlaceholder(file) {
      const id = `upload-${++sequence}`;
      action({ type: 'add', id, position: view.state.selection.from, file });
      return id;
    },
    replacePlaceholder(id, image) {
      const state = key.getState(view.state);
      const position = state?.byId.get(id);
      const imageNode = view.state.schema.nodes.image?.create(image);
      if (!imageNode || position === undefined) return;
      view.dispatch(view.state.tr.insert(position, imageNode)
        .setMeta(key, { type: 'remove', id }));
    },
    failPlaceholder(id) {
      action({ type: 'fail', id });
    },
    hasPlaceholder(id) {
      const state = key.getState(view.state);
      return Boolean(state?.byId.has(id));
    },
  });

  const extension: UploadExtension = {
    async uploadFiles(files) {
      for (const file of files) await controller.upload(file);
    },
    openFilePicker() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', () => {
        void extension.uploadFiles([...(input.files || [])]);
      }, { once: true });
      input.click();
    },
    destroy() {
      controller.destroy();
      view.dom.removeEventListener('paste', handlePaste, true);
      view.dom.removeEventListener('drop', handleDrop, true);
    },
  };
  const handlePaste = (event: Event) => {
    const files = [...((event as ClipboardEvent).clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    void extension.uploadFiles(files);
  };
  const handleDrop = (event: Event) => {
    const drop = event as DragEvent;
    const files = [...(drop.dataTransfer?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    const coordinate = view.posAtCoords({ left: drop.clientX, top: drop.clientY });
    if (coordinate) view.dispatch(view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(coordinate.pos)),
    ));
    void extension.uploadFiles(files);
  };
  view.dom.addEventListener('paste', handlePaste, true);
  view.dom.addEventListener('drop', handleDrop, true);
  return extension;
}
