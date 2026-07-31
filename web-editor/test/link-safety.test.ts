import { afterEach, describe, expect, it } from 'vitest';
import { createWikinestEditor } from '../src/editor/create-editor';
import { serializeDocument } from '../src/editor/markdown';

describe('Milkdown link safety', () => {
  const editors: Array<{ destroy(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
    document.body.replaceChildren();
  });

  it('removes unsafe initial link marks while preserving their text', async () => {
    const root = document.body.appendChild(document.createElement('div'));
    const editor = await createWikinestEditor({
      root,
      markdown: '[danger](JaVaScRiPt:alert(1)) [safe](notes/a.md) [web](https://example.test) [mail](mailto:person@example.test) [hash](#section)',
      onMarkdownChange: () => undefined,
    });
    editors.push(editor);

    expect(serializeDocument(editor.editor, editor.getView())).toContain('danger');
    expect(root.querySelector('a[href^="javascript" i]')).toBeNull();
    expect(root.querySelector<HTMLAnchorElement>('a[href="notes/a.md"]')?.textContent).toBe('safe');
    expect(root.querySelector<HTMLAnchorElement>('a[href="https://example.test"]')?.textContent).toBe('web');
    expect(root.querySelector<HTMLAnchorElement>('a[href="mailto:person@example.test"]')?.textContent).toBe('mail');
    expect(root.querySelector<HTMLAnchorElement>('a[href="#section"]')?.textContent).toBe('hash');
  });

  it('strips unsafe link marks added in a later transaction and prevents unsafe clicks', async () => {
    const root = document.body.appendChild(document.createElement('div'));
    const editor = await createWikinestEditor({
      root,
      markdown: 'plain',
      onMarkdownChange: () => undefined,
    });
    editors.push(editor);
    const view = editor.getView();
    const link = view.state.schema.marks.link.create({ href: 'java%73cript:alert(1)' });
    view.dispatch(view.state.tr.insertText('danger', 1, 1).addMark(1, 7, link));

    expect(serializeDocument(editor.editor, view)).toContain('danger');
    expect(root.querySelector('a')).toBeNull();

    const unsafe = document.createElement('a');
    unsafe.href = 'javascript:alert(1)';
    root.querySelector('.ProseMirror')!.append(unsafe);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    unsafe.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });
});
