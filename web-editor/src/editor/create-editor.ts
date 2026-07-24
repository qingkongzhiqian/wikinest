import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  rootCtx,
} from '@milkdown/core';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { Plugin } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { replaceAll } from '@milkdown/utils';
import { createMermaidNodeViews } from './mermaid-node';
import { installUploadExtension, type UploadExtension } from './upload';
import { isSafeLinkUrl } from './safe-url';
import { installSlashMenu, type SlashMenuExtension } from './slash-menu';

export interface WikinestEditorConfig {
  root: HTMLElement;
  markdown: string;
  onMarkdownChange(markdown: string): void;
  onSelectionChange?(): void;
  uploadImage?(file: File, signal: AbortSignal): Promise<{ url: string }>;
}

export interface WikinestEditor {
  editor: Editor;
  getView(): EditorView;
  replaceMarkdown(markdown: string): void;
  openImagePicker(): void;
  destroy(): Promise<void>;
}

function unsafeLinkCleanupTransaction(view: EditorView) {
  let transaction = view.state.tr;
  view.state.doc.descendants((node, position) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'link' && !isSafeLinkUrl(mark.attrs.href)) {
        transaction = transaction.removeMark(position, position + node.nodeSize, mark);
      }
    }
  });
  return transaction.docChanged ? transaction : undefined;
}

function linkSafetyPlugin() {
  return new Plugin({
    appendTransaction(_transactions, _oldState, newState) {
      let transaction = newState.tr;
      newState.doc.descendants((node, position) => {
        for (const mark of node.marks) {
          if (mark.type.name === 'link' && !isSafeLinkUrl(mark.attrs.href)) {
            transaction = transaction.removeMark(position, position + node.nodeSize, mark);
          }
        }
      });
      return transaction.docChanged ? transaction : undefined;
    },
  });
}

function selectionChangePlugin(onSelectionChange?: () => void) {
  return new Plugin({
    view: () => ({
      update(view, previousState) {
        if (previousState.selection.eq(view.state.selection)) return;
        try {
          onSelectionChange?.();
        } catch {
          // Host UI failures must not break ProseMirror selection handling.
        }
      },
    }),
  });
}

export async function createWikinestEditor(config: WikinestEditorConfig): Promise<WikinestEditor> {
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, config.root);
      ctx.set(defaultValueCtx, config.markdown);
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => config.onMarkdownChange(markdown));
    })
    // GFM 扩展与 CommonMark 各注册一次，避免重复注册任一 preset。
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(listener);

  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  view.updateState(view.state.reconfigure({
    plugins: [
      ...view.state.plugins,
      linkSafetyPlugin(),
      selectionChangePlugin(config.onSelectionChange),
    ],
  }));
  const initialCleanup = unsafeLinkCleanupTransaction(view);
  if (initialCleanup) view.dispatch(initialCleanup);
  const handleSafeLinkClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href]');
    if (anchor && view.dom.contains(anchor) && !isSafeLinkUrl(anchor.getAttribute('href'))) {
      event.preventDefault();
    }
  };
  view.dom.addEventListener('click', handleSafeLinkClick, true);
  view.setProps({ nodeViews: createMermaidNodeViews() });
  const uploads: UploadExtension = installUploadExtension(view, config.uploadImage || (async () => {
    throw new Error('Image upload is unavailable');
  }));
  const slashMenu: SlashMenuExtension = installSlashMenu(view);

  return {
    editor,
    getView: () => editor.action((ctx) => ctx.get(editorViewCtx)),
    replaceMarkdown: (markdown) => editor.action(replaceAll(markdown)),
    openImagePicker: () => uploads.openFilePicker(),
    destroy: async () => {
      slashMenu.destroy();
      uploads.destroy();
      view.dom.removeEventListener('click', handleSafeLinkClick, true);
      await editor.destroy();
    },
  };
}
