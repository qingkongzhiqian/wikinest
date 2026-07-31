import { act } from 'react';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountUnifiedEditor } from '../src/main';
import type { EditorHandle, MountEditorOptions, NoteDocument } from '../src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!Range.prototype.getClientRects) {
  const rect = () => new DOMRect(0, 0, 0, 0);
  Object.defineProperty(Range.prototype, 'getClientRects', {
    value: () => Object.assign([rect()], { item: (index: number) => index === 0 ? rect() : null }),
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { value: rect });
}

function note(overrides: Partial<NoteDocument> = {}): NoteDocument {
  return {
    path: 'notes/ai.md',
    markdown: 'before\n\nselected\n\nafter',
    frontmatter: {},
    version: 'a'.repeat(64),
    ...overrides,
  };
}

async function waitForEditor(host: HTMLElement): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const editor = host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
    if (editor) return editor;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Milkdown contenteditable was not mounted');
}

async function waitForRevision(handle: EditorHandle): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (handle.getDocumentState().revision > 0) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  }
  throw new Error('edit did not reach autosave');
}

function selectParagraph(editor: HTMLElement, index = 1): void {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor.querySelectorAll('p')[index]!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

function selectText(node: Text, from: number, to: number): void {
  node.parentElement?.closest<HTMLElement>('.ProseMirror')?.focus();
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

function selectAcrossParagraphs(editor: HTMLElement, first: number, last: number): void {
  editor.focus();
  const paragraphs = editor.querySelectorAll('p');
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setStartBefore(paragraphs[first]!);
  range.setEndAfter(paragraphs[last]!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

function firstTextNode(element: Element): Text {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!node) throw new Error('Expected text node');
  return node as Text;
}

async function mountNote(
  mounts: Array<() => void>,
  markdown: string,
  saveNote = vi.fn(async (input) => ({ path: input.path, version: 'b'.repeat(64) })),
): Promise<{ host: HTMLDivElement; editor: HTMLElement; handle: EditorHandle; saveNote: ReturnType<typeof vi.fn> }> {
  const host = document.createElement('div');
  document.body.append(host);
  const options: MountEditorOptions = {
    element: host,
    client: { readNote: vi.fn(), saveNote, uploadImage: vi.fn() },
    locale: 'en', onStatus: vi.fn(), onConflictOpen: vi.fn(), onFatal: vi.fn(),
  };
  let handle!: EditorHandle;
  await act(async () => { handle = mountUnifiedEditor(options); });
  mounts.push(() => handle.destroy());
  await act(async () => { await handle.load(note({ markdown })); });
  return { host, editor: await waitForEditor(host), handle, saveNote };
}

describe('AI selection write-back', () => {
  const mounts: Array<() => void> = [];

  afterEach(async () => {
    await act(async () => {
      for (const destroy of mounts.splice(0)) destroy();
    });
    document.body.replaceChildren();
  });

  it('parses Markdown into one undoable replacement and schedules autosave', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const saveNote = vi.fn(async (input) => ({ path: input.path, version: 'b'.repeat(64) }));
    const options: MountEditorOptions = {
      element: host,
      client: { readNote: vi.fn(), saveNote, uploadImage: vi.fn() },
      locale: 'en', onStatus: vi.fn(), onConflictOpen: vi.fn(), onFatal: vi.fn(),
    };
    let handle!: EditorHandle;
    await act(async () => { handle = mountUnifiedEditor(options); });
    mounts.push(() => handle.destroy());
    await act(async () => { await handle.load(note()); });
    const editor = await waitForEditor(host);
    await act(async () => { selectParagraph(editor); });
    const snapshot = handle.getSelectionSnapshot();

    expect(snapshot?.selectedMarkdown).toContain('selected');
    expect(handle.applyAiResult(snapshot!, '## replacement\n\n- [x] parsed', 'replace')).toBe(true);
    expect(handle.getMarkdown()).toContain('## replacement');
    expect(handle.getMarkdown()).toContain('[x] parsed');
    await waitForRevision(handle);
    await act(async () => { await handle.flush(); });
    expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({
      markdown: expect.stringContaining('## replacement'),
    }));

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, ctrlKey: true, key: 'z', code: 'KeyZ',
      }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(handle.getMarkdown()).toContain('selected');
  });

  it('rejects stale snapshots and invalid Markdown without changing the document', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const options: MountEditorOptions = {
      element: host,
      client: { readNote: vi.fn(), saveNote: vi.fn(), uploadImage: vi.fn() },
      locale: 'en', onStatus: vi.fn(), onConflictOpen: vi.fn(), onFatal: vi.fn(),
    };
    let handle!: EditorHandle;
    await act(async () => { handle = mountUnifiedEditor(options); });
    mounts.push(() => handle.destroy());
    await act(async () => { await handle.load(note()); });
    const editor = await waitForEditor(host);
    await act(async () => { selectParagraph(editor); });
    const snapshot = handle.getSelectionSnapshot()!;
    const original = handle.getMarkdown();

    expect(handle.applyAiResult({ ...snapshot, path: 'notes/other.md' }, 'changed', 'replace')).toBe(false);
    expect(handle.applyAiResult({ ...snapshot, to: 9999 }, 'changed', 'replace')).toBe(false);
    expect(handle.applyAiResult({ ...snapshot, selectedMarkdown: 'different' }, 'changed', 'replace')).toBe(false);
    let invalidResult: boolean | undefined;
    expect(() => { invalidResult = handle.applyAiResult(snapshot, '\u0000', 'replace'); }).not.toThrow();
    expect(invalidResult).toBe(false);
    expect(handle.getMarkdown()).toBe(original);
  });

  it('replaces a partial textblock selection with inline Markdown without losing surrounding text', async () => {
    const { editor, handle } = await mountNote(mounts, '段前旧文本段后');
    const text = editor.querySelector('p')!.firstChild as Text;
    await act(async () => { selectText(text, 2, 5); });
    const snapshot = handle.getSelectionSnapshot()!;

    expect(handle.applyAiResult(snapshot, '**新文本**', 'replace')).toBe(true);
    expect(handle.getMarkdown()).toContain('段前**新文本**段后');
  });

  it('rejects block Markdown for a partial textblock selection atomically', async () => {
    const { editor, handle } = await mountNote(mounts, '段前旧文本段后');
    const text = editor.querySelector('p')!.firstChild as Text;
    await act(async () => { selectText(text, 2, 5); });
    const snapshot = handle.getSelectionSnapshot()!;
    const original = handle.getMarkdown();

    expect(handle.applyAiResult(snapshot, '| A |\n| - |\n| B |', 'replace')).toBe(false);
    expect(handle.getMarkdown()).toBe(original);
  });

  it('replaces whole and cross-paragraph selections with parsed blocks and inserts blocks after a textblock', async () => {
    const whole = await mountNote(mounts, 'old');
    await act(async () => { selectParagraph(whole.editor, 0); });
    expect(whole.handle.applyAiResult(whole.handle.getSelectionSnapshot()!, '# heading\n\nnew paragraph', 'replace')).toBe(true);
    expect(whole.handle.getMarkdown()).toContain('# heading\n\nnew paragraph');
    expect(whole.handle.getMarkdown()).not.toContain('old');

    const cross = await mountNote(mounts, 'first\n\nsecond\n\nthird');
    await act(async () => { selectAcrossParagraphs(cross.editor, 0, 1); });
    expect(cross.handle.applyAiResult(cross.handle.getSelectionSnapshot()!, 'one\n\ntwo', 'replace')).toBe(true);
    expect(cross.handle.getMarkdown()).toContain('one\n\ntwo\n\nthird');

    const insert = await mountNote(mounts, 'before\n\nselected\n\nafter');
    await act(async () => { selectParagraph(insert.editor, 1); });
    expect(insert.handle.applyAiResult(insert.handle.getSelectionSnapshot()!, '## inserted\n\nblock', 'insert')).toBe(true);
    expect(insert.handle.getMarkdown()).toContain('selected\n\n## inserted\n\nblock\n\nafter');
  });

  it('uses schema-valid boundaries for list, code, and table selections', async () => {
    const list = await mountNote(mounts, '- old\n- keep');
    const listText = firstTextNode(list.editor.querySelector('li p')!);
    await act(async () => { selectText(listText, 0, 3); });
    expect(list.handle.applyAiResult(list.handle.getSelectionSnapshot()!, '**new**', 'replace')).toBe(true);
    expect(list.handle.getMarkdown()).toContain('* **new**');
    expect(list.handle.getMarkdown()).toContain('* keep');

    const code = await mountNote(mounts, '```js\nold value\n```');
    const codeText = firstTextNode(code.editor.querySelector('pre code')!);
    await act(async () => { selectText(codeText, 0, 3); });
    const codeSnapshot = code.handle.getSelectionSnapshot()!;
    const codeOriginal = code.handle.getMarkdown();
    expect(code.handle.applyAiResult(codeSnapshot, '| A |\n| - |\n| B |', 'replace')).toBe(false);
    expect(code.handle.getMarkdown()).toBe(codeOriginal);
    expect(code.handle.applyAiResult(codeSnapshot, 'new', 'replace')).toBe(true);
    expect(code.handle.getMarkdown()).toContain('new value');

    const table = await mountNote(mounts, '| A |\n| - |\n| old |');
    const tableText = firstTextNode(table.editor.querySelector('td')!);
    await act(async () => { selectText(tableText, 0, 3); });
    expect(table.handle.applyAiResult(table.handle.getSelectionSnapshot()!, '**new**', 'replace')).toBe(true);
    expect(table.handle.getMarkdown()).toContain('**new**');
  });

  it('inserts multi-block AI results at legal list item, code block, and table cell boundaries and undoes each', async () => {
    const replacement = '## inserted\n\nsecond block';

    const list = await mountNote(mounts, '- selected\n- keep');
    const listText = firstTextNode(list.editor.querySelector('li p')!);
    await act(async () => { selectText(listText, 0, 8); });
    const listOriginal = list.handle.getMarkdown();
    expect(list.handle.applyAiResult(list.handle.getSelectionSnapshot()!, replacement, 'insert')).toBe(true);
    expect(list.handle.getMarkdown()).toContain('inserted');
    expect(list.handle.getMarkdown()).toContain('keep');
    await act(async () => {
      list.editor.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, ctrlKey: true, key: 'z', code: 'KeyZ',
      }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(list.handle.getMarkdown()).toBe(listOriginal);

    const code = await mountNote(mounts, '```js\nselected\n```\n\nafter');
    const codeText = firstTextNode(code.editor.querySelector('pre code')!);
    await act(async () => { selectText(codeText, 0, 8); });
    const codeOriginal = code.handle.getMarkdown();
    expect(code.handle.applyAiResult(code.handle.getSelectionSnapshot()!, replacement, 'insert')).toBe(true);
    expect(code.handle.getMarkdown()).toContain('```js\nselected\n```\n\n## inserted');
    expect(code.handle.getMarkdown()).toContain('second block\n\nafter');
    await act(async () => {
      code.editor.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, ctrlKey: true, key: 'z', code: 'KeyZ',
      }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(code.handle.getMarkdown()).toBe(codeOriginal);

    const table = await mountNote(mounts, '| A |\n| - |\n| selected |');
    const tableText = firstTextNode(table.editor.querySelector('td')!);
    await act(async () => { selectText(tableText, 0, 8); });
    const tableOriginal = table.handle.getMarkdown();
    expect(table.handle.applyAiResult(table.handle.getSelectionSnapshot()!, replacement, 'insert')).toBe(true);
    expect(table.handle.getMarkdown()).toContain('inserted');
    await act(async () => {
      table.editor.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, ctrlKey: true, key: 'z', code: 'KeyZ',
      }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(table.handle.getMarkdown()).toBe(tableOriginal);
  });

  it('rejects snapshots after local revision, selected-content, or loaded-path changes', async () => {
    const local = await mountNote(mounts, 'old');
    await act(async () => { selectParagraph(local.editor, 0); });
    const localSnapshot = local.handle.getSelectionSnapshot()!;
    local.editor.querySelector('p')!.textContent = 'edited';
    fireEvent.input(local.editor.querySelector('p')!, { inputType: 'insertText', data: 'd' });
    await waitForRevision(local.handle);
    expect(local.handle.applyAiResult(localSnapshot, 'AI', 'replace')).toBe(false);

    const changed = await mountNote(mounts, 'old');
    await act(async () => { selectParagraph(changed.editor, 0); });
    const changedSnapshot = changed.handle.getSelectionSnapshot()!;
    expect(changed.handle.applyAiResult({
      ...changedSnapshot,
      selectedMarkdown: 'different',
    }, 'AI', 'replace')).toBe(false);

    const loaded = await mountNote(mounts, 'old');
    await act(async () => { selectParagraph(loaded.editor, 0); });
    const loadedSnapshot = loaded.handle.getSelectionSnapshot()!;
    await act(async () => {
      await loaded.handle.load(note({ path: 'notes/other.md', markdown: 'other', version: 'b'.repeat(64) }));
    });
    expect(loaded.handle.applyAiResult(loadedSnapshot, 'AI', 'replace')).toBe(false);
  });
});
