import { serializerCtx } from '@milkdown/core';
import type { Editor } from '@milkdown/core';
import type { EditorView } from '@milkdown/prose/view';

export function serializeDocument(editor: Editor, view: EditorView): string {
  return editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc));
}

export function serializeMarkdownRange(
  editor: Editor,
  view: EditorView,
  from: number,
  to: number,
): string {
  return editor.action((ctx) => {
    const slice = view.state.doc.slice(from, to, true);
    const document = view.state.schema.topNodeType.createAndFill(null, slice.content);
    return document ? ctx.get(serializerCtx)(document) : '';
  });
}
