import { describe, expect, it } from 'vitest';
import { TextSelection } from '@milkdown/prose/state';
import { undo } from '@milkdown/prose/history';
import { createWikinestEditor } from '../src/editor/create-editor';
import { serializeDocument } from '../src/editor/markdown';
import { serializeSelection } from '../src/editor/selection';

const GFM_FIXTURE = `# 标题

- [x] 已完成
- [ ] 待处理

| 名称 | 值 |
| --- | --- |
| A | 1 |

> 引用

\`\`\`js
console.log('ok')
\`\`\`

[链接](https://example.com "链接标题")

![图片](https://example.com/image.png "图片标题")
`;

function semanticSummary(node: { type: { name: string }; text?: string; attrs: Record<string, unknown>; forEach: (fn: (child: typeof node) => void) => void }): unknown {
  const children: unknown[] = [];
  node.forEach((child) => children.push(semanticSummary(child)));
  return {
    type: node.type.name,
    text: node.text,
    attrs: ['code_block', 'list_item', 'link', 'image'].includes(node.type.name)
      ? node.attrs
      : undefined,
    children,
  };
}

function semanticAssets(node: {
  type: { name: string };
  attrs: Record<string, unknown>;
  marks?: ReadonlyArray<{ type: { name: string }; attrs: Record<string, unknown> }>;
  forEach: (fn: (child: typeof node) => void) => void;
}): Array<{ type: string; attrs: Record<string, unknown> }> {
  const assets: Array<{ type: string; attrs: Record<string, unknown> }> = [];
  for (const mark of node.marks || []) {
    if (mark.type.name === 'link') assets.push({ type: 'link', attrs: mark.attrs });
  }
  if (node.type.name === 'link' || node.type.name === 'image') {
    assets.push({ type: node.type.name, attrs: node.attrs });
  }
  node.forEach((child) => assets.push(...semanticAssets(child)));
  return assets;
}

describe('Milkdown Markdown serialization', () => {
  it('round-trips GFM semantics without frontmatter', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: GFM_FIXTURE,
      onMarkdownChange: () => undefined,
    });
    const parsed = editor.getView().state.doc;
    const serialized = serializeDocument(editor.editor, editor.getView());
    editor.replaceMarkdown(serialized);
    const reparsed = editor.getView().state.doc;

    expect(semanticSummary(reparsed)).toEqual(semanticSummary(parsed));
    expect(semanticAssets(reparsed)).toEqual([
      {
        type: 'link',
        attrs: {
          href: 'https://example.com',
          title: '链接标题',
        },
      },
      {
        type: 'image',
        attrs: {
          src: 'https://example.com/image.png',
          alt: '图片',
          title: '图片标题',
        },
      },
    ]);
    expect(serialized).toContain('```js');
    expect(serialized).toContain("console.log('ok')");
    expect(serialized).toContain('[x] 已完成');
    expect(serialized).toContain('| 名称');
    expect(serialized).toContain('[链接](https://example.com "链接标题")');
    expect(serialized).toContain('![图片](https://example.com/image.png "图片标题")');
    await editor.destroy();
  });

  it('does not parse NoteDocument frontmatter as editable content', async () => {
    const markdown = '---\ntitle: 不应进入编辑器\n---\n\n# 正文';
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: '# 正文',
      onMarkdownChange: () => undefined,
    });
    const parsed = editor.getView().state.doc;

    expect(parsed.textContent).toContain('正文');
    expect(parsed.textContent).not.toContain('不应进入编辑器');
    expect(markdown).toContain('title: 不应进入编辑器');
    await editor.destroy();
  });

  it('serializes a real ProseMirror slice as Markdown', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: '[链接](https://example.com)',
      onMarkdownChange: () => undefined,
    });
    const view = editor.getView();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));

    expect(serializeSelection(view, 1, 3, editor.editor)).toContain('[链接](https://example.com)');
    await editor.destroy();
  });

  it.each([
    ['task', '- [ ] 待处理', '待处理'],
    ['table', '| 名称 | 值 |\n| --- | --- |\n| A | 1 |', '名称'],
    ['code block', '```js\nconst value = 1;\n```', 'const value = 1;'],
  ])('serializes and undoes one %s mutation', async (_kind, markdown, originalText) => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown,
      onMarkdownChange: () => undefined,
    });
    const view = editor.getView();
    let position: number | undefined;
    view.state.doc.descendants((node, pos) => {
      if (position === undefined && node.isText && node.text === originalText) position = pos;
    });
    expect(position).toBeDefined();
    view.dispatch(view.state.tr.insertText('!', position! + originalText.length));
    expect(serializeDocument(editor.editor, view)).toContain(`${originalText}!`);
    expect(undo(view.state, (transaction) => view.dispatch(transaction))).toBe(true);
    expect(serializeDocument(editor.editor, view)).toContain(originalText);
    expect(serializeDocument(editor.editor, view)).not.toContain(`${originalText}!`);
    await editor.destroy();
  });
});
