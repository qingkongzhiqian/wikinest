import type { Editor } from '@milkdown/core';
import { parserCtx } from '@milkdown/core';
import type { Node as ProseMirrorNode } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import { Slice } from '@milkdown/prose/model';
import { serializeMarkdownRange } from './markdown';

export function serializeSelection(view: EditorView, from: number, to: number, editor: Editor): string {
  return serializeMarkdownRange(editor, view, from, to);
}

interface TextblockBoundary {
  before: number;
  start: number;
  end: number;
  after: number;
}

export interface AiSlicePlan {
  from: number;
  to: number;
  slice: Slice;
}

function parseMarkdownDocument(editor: Editor, markdown: string): ProseMirrorNode | null {
  if (typeof markdown !== 'string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(markdown)) {
    return null;
  }
  try {
    return editor.action((ctx) => {
      const document = ctx.get(parserCtx)(markdown);
      return document?.type === ctx.get(parserCtx)('').type ? document : null;
    });
  } catch {
    return null;
  }
}

function textblockBoundary(doc: ProseMirrorNode, position: number, edge: 'start' | 'end'): TextblockBoundary | null {
  const resolved = doc.resolve(position);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    if (resolved.node(depth).isTextblock) {
      return {
        before: resolved.before(depth),
        start: resolved.start(depth),
        end: resolved.end(depth),
        after: resolved.after(depth),
      };
    }
  }
  const adjacent = edge === 'start' ? resolved.nodeAfter : resolved.nodeBefore;
  if (!adjacent?.isTextblock) return null;
  const before = edge === 'start' ? position : position - adjacent.nodeSize;
  return {
    before,
    start: before + 1,
    end: before + adjacent.nodeSize - 1,
    after: before + adjacent.nodeSize,
  };
}

function inlineSlice(document: ProseMirrorNode): Slice | null {
  const node = document.childCount === 1 ? document.firstChild : null;
  return node?.type.name === 'paragraph' ? new Slice(node.content, 0, 0) : null;
}

export function planAiSlice(
  editor: Editor,
  view: EditorView,
  markdown: string,
  mode: 'replace' | 'insert',
  from: number,
  to: number,
): AiSlicePlan | null {
  const document = parseMarkdownDocument(editor, markdown);
  if (!document || from < 0 || to < from || to > view.state.doc.content.size) return null;

  const inline = inlineSlice(document);
  const start = textblockBoundary(view.state.doc, from, 'start');
  const end = textblockBoundary(view.state.doc, to, 'end');
  if (mode === 'insert') {
    if (inline && end && to >= end.start && to <= end.end) {
      return { from: to, to, slice: inline };
    }
    return end ? { from: end.after, to: end.after, slice: new Slice(document.content, 0, 0) } : null;
  }

  if (
    inline
    && start
    && end
    && start.before === end.before
    && from >= start.start
    && to <= start.end
  ) {
    return { from, to, slice: inline };
  }

  if (
    start
    && end
    && (from === start.before || from === start.start)
    && (to === end.after || to === end.end)
  ) {
    return { from: start.before, to: end.after, slice: new Slice(document.content, 0, 0) };
  }
  return null;
}
