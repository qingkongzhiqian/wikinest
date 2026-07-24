import { act } from 'react';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountUnifiedEditor } from '../src/main';
import type { MountEditorOptions, NoteDocument } from '../src/types';
import { AutosaveFlushError } from '../src/autosave';
import { WikiClientError } from '../src/wiki-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!Range.prototype.getClientRects) {
  const rect = () => new DOMRect(0, 0, 0, 0);
  Object.defineProperty(Range.prototype, 'getClientRects', {
    value: () => Object.assign([rect()], { item: (index: number) => index === 0 ? rect() : null }),
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { value: rect });
}

function documentFixture(overrides: Partial<NoteDocument> = {}): NoteDocument {
  return {
    path: 'notes/editor.md',
    markdown: '# 标题\n\n初始段落',
    frontmatter: { title: '前置元数据' },
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

async function waitForChange(handle: ReturnType<typeof mountUnifiedEditor>): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (handle.getDocumentState().revision > 0) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
  }
  throw new Error('rendered ProseMirror edit did not reach autosave');
}

async function flushError(handle: ReturnType<typeof mountUnifiedEditor>): Promise<unknown> {
  let error: unknown;
  await act(async () => {
    try {
      await handle.flush();
    } catch (caught) {
      error = caught;
    }
  });
  return error;
}

describe('UnifiedMarkdownEditor', () => {
  const mounts: Array<{ host: HTMLDivElement; unmount: () => void }> = [];

  afterEach(async () => {
    await act(async () => {
      for (const mount of mounts.splice(0)) mount.unmount();
    });
    document.body.replaceChildren();
  });

  it('does not show a redundant image button when paste and drop upload remain available', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const options: MountEditorOptions = {
      element: host,
      client: { readNote: vi.fn(), saveNote: vi.fn(), uploadImage: vi.fn() },
      locale: 'zh-CN',
      onStatus: vi.fn(),
      onConflictOpen: vi.fn(),
      onFatal: vi.fn(),
    };
    let handle!: ReturnType<typeof mountUnifiedEditor>;
    await act(async () => { handle = mountUnifiedEditor(options); });
    mounts.push({ host, unmount: () => handle.destroy() });
    await act(async () => { await handle.load(documentFixture()); });
    const editor = await waitForEditor(host);

    expect(editor).not.toBeNull();
    expect(host.querySelector('.wikinest-editor__toolbar')).toBeNull();
    expect([...host.querySelectorAll('button')].map((button) => button.textContent))
      .not.toContain('插入图片');
  });

  it('edits rendered ProseMirror content and routes the markdown to autosave', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const saveNote = vi.fn(async (input) => ({
      path: input.path,
      version: 'b'.repeat(64),
    }));
    const options: MountEditorOptions = {
      element: host,
      client: {
        readNote: vi.fn(),
        saveNote,
        uploadImage: vi.fn(),
      },
      locale: 'zh-CN',
      onStatus: vi.fn(),
      onConflictOpen: vi.fn(),
      onFatal: vi.fn(),
    };
    let handle!: ReturnType<typeof mountUnifiedEditor>;
    await act(async () => {
      handle = mountUnifiedEditor(options);
    });
    mounts.push({ host, unmount: () => handle.destroy() });

    await act(async () => {
      await handle.load(documentFixture());
    });

    const editor = await waitForEditor(host);
    expect(host.querySelector('textarea')).toBeNull();
    expect(editor.getAttribute('contenteditable')).toBe('true');

    const paragraph = editor.querySelector('p');
    expect(paragraph).not.toBeNull();
    paragraph!.textContent = '直接编辑后的段落';
    fireEvent.input(paragraph!, { inputType: 'insertText', data: '落' });

    await act(async () => {
      await Promise.resolve();
    });

    expect(handle.getMarkdown()).toContain('直接编辑后的段落');
    await waitForChange(handle);
    await act(async () => {
      await handle.flush();
    });
    expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({
      markdown: expect.stringContaining('直接编辑后的段落'),
    }));
  });

  it('rejects an active composition, saves after compositionend, and handles Mod-S', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const saveNote = vi.fn(async (input) => ({ path: input.path, version: 'b'.repeat(64) }));
    const options: MountEditorOptions = {
      element: host,
      client: { readNote: vi.fn(), saveNote, uploadImage: vi.fn() },
      locale: 'en',
      onStatus: vi.fn(),
      onConflictOpen: vi.fn(),
      onFatal: vi.fn(),
    };
    let handle!: ReturnType<typeof mountUnifiedEditor>;
    await act(async () => { handle = mountUnifiedEditor(options); });
    mounts.push({ host, unmount: () => handle.destroy() });
    await act(async () => { await handle.load(documentFixture()); });
    const editor = await waitForEditor(host);

    await act(async () => { editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    editor.querySelector('p')!.textContent = '拼音完成';
    fireEvent.input(editor.querySelector('p')!, { inputType: 'insertText', data: '完' });
    await waitForChange(handle);
    expect(await flushError(handle)).toMatchObject({ code: 'COMPOSITION_ACTIVE' } as Partial<AutosaveFlushError>);
    expect(saveNote).not.toHaveBeenCalled();

    await act(async () => { editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    const shortcut = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, metaKey: true, key: 's' });
    await act(async () => {
      editor.dispatchEvent(shortcut);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(shortcut.defaultPrevented).toBe(true);
    expect(saveNote).toHaveBeenCalledTimes(1);
  });

  it('exposes retry and conflict callbacks through the rendered controls', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const onConflictOpen = vi.fn();
    const saveNote = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ path: 'notes/editor.md', version: 'b'.repeat(64) })
      .mockRejectedValueOnce(new WikiClientError(409, {
        code: 'NOTE_VERSION_CONFLICT',
        conflictPath: 'notes/conflict-copy.md',
      }));
    const options: MountEditorOptions = {
      element: host,
      client: { readNote: vi.fn(), saveNote, uploadImage: vi.fn() },
      locale: 'en', onStatus: vi.fn(), onConflictOpen, onFatal: vi.fn(),
    };
    let handle!: ReturnType<typeof mountUnifiedEditor>;
    await act(async () => { handle = mountUnifiedEditor(options); });
    mounts.push({ host, unmount: () => handle.destroy() });
    await act(async () => { await handle.load(documentFixture()); });
    const editor = await waitForEditor(host);
    editor.querySelector('p')!.textContent = 'retry me';
    fireEvent.input(editor.querySelector('p')!, { inputType: 'insertText', data: '!' });
    await waitForChange(handle);
    expect(await flushError(handle)).toMatchObject({ message: 'offline' });
    await act(async () => { fireEvent.click(host.querySelector('button')!); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(saveNote).toHaveBeenCalledTimes(2);

    editor.querySelector('p')!.textContent = 'conflict me';
    fireEvent.input(editor.querySelector('p')!, { inputType: 'insertText', data: '!' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    expect(await flushError(handle)).toMatchObject({ code: 'NOTE_VERSION_CONFLICT' });
    const conflictButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Open conflict copy');
    await act(async () => { fireEvent.click(conflictButton!); });
    expect(onConflictOpen).toHaveBeenCalledWith('notes/conflict-copy.md');
  });

  it('keeps the editor alive for network and conflict flush failures without reporting fatal', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const onFatal = vi.fn();
    const saveNote = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new WikiClientError(409, {
        code: 'NOTE_VERSION_CONFLICT',
        conflictPath: 'notes/conflict-copy.md',
      }));
    const options: MountEditorOptions = {
      element: host, client: { readNote: vi.fn(), saveNote, uploadImage: vi.fn() },
      locale: 'en', onStatus: vi.fn(), onConflictOpen: vi.fn(), onFatal,
    };
    let handle!: ReturnType<typeof mountUnifiedEditor>;
    await act(async () => { handle = mountUnifiedEditor(options); });
    mounts.push({ host, unmount: () => handle.destroy() });
    await act(async () => { await handle.load(documentFixture()); });
    const editor = await waitForEditor(host);
    editor.querySelector('p')!.textContent = 'offline';
    fireEvent.input(editor.querySelector('p')!, { inputType: 'insertText', data: '!' });
    await waitForChange(handle);
    await expect(flushError(handle)).resolves.toMatchObject({ message: 'offline' });
    expect(handle.getDocumentState().status).toBe('error');
    expect(host.querySelector('.ProseMirror')).not.toBeNull();
    expect(onFatal).not.toHaveBeenCalled();

    editor.querySelector('p')!.textContent = 'conflict';
    fireEvent.input(editor.querySelector('p')!, { inputType: 'insertText', data: '!' });
    await act(async () => { fireEvent.click(host.querySelector('button')!); });
    await expect(flushError(handle)).resolves.toMatchObject({ code: 'NOTE_VERSION_CONFLICT' });
    expect(handle.getDocumentState().status).toBe('conflict');
    expect(host.querySelector('.ProseMirror')).not.toBeNull();
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('keeps frontmatter outside the editor and saves only the Markdown body', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const note = documentFixture({ markdown: '# body', frontmatter: { title: 'private', tags: ['a'] } });
    const original = structuredClone(note);
    const saveNote = vi.fn(async (input) => ({ path: input.path, version: 'b'.repeat(64) }));
    const options: MountEditorOptions = {
      element: host, client: { readNote: vi.fn(), saveNote, uploadImage: vi.fn() },
      locale: 'en', onStatus: vi.fn(), onConflictOpen: vi.fn(), onFatal: vi.fn(),
    };
    let handle!: ReturnType<typeof mountUnifiedEditor>;
    await act(async () => { handle = mountUnifiedEditor(options); });
    mounts.push({ host, unmount: () => handle.destroy() });
    await act(async () => { await handle.load(note); });
    const editor = await waitForEditor(host);
    expect(editor.textContent).not.toContain('private');
    editor.querySelector('h1')!.textContent = 'changed body';
    await act(async () => { fireEvent.input(editor.querySelector('h1')!, { inputType: 'insertText', data: '!' }); });
    await waitForChange(handle);
    await act(async () => { await handle.flush(); });
    expect(saveNote).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: '# changed body\n' }));
    expect(note).toEqual(original);
  });

  it('returns null for an empty selection and serializes a real selected ProseMirror range', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const onSelectionChange = vi.fn();
    const options: MountEditorOptions = {
      element: host, client: { readNote: vi.fn(), saveNote: vi.fn(), uploadImage: vi.fn() },
      locale: 'en', onStatus: vi.fn(), onConflictOpen: vi.fn(), onFatal: vi.fn(), onSelectionChange,
    };
    let handle!: ReturnType<typeof mountUnifiedEditor>;
    await act(async () => { handle = mountUnifiedEditor(options); });
    mounts.push({ host, unmount: () => handle.destroy() });
    await act(async () => { await handle.load(documentFixture({ markdown: '[链接](https://example.com)' })); });
    const editor = await waitForEditor(host);
    editor.focus();
    await act(async () => { document.dispatchEvent(new Event('selectionchange')); });
    expect(handle.getSelectionSnapshot()).toBeNull();
    const range = document.createRange();
    range.selectNodeContents(editor.querySelector('p')!);
    const browserSelection = window.getSelection()!;
    browserSelection.removeAllRanges();
    browserSelection.addRange(range);
    await act(async () => { document.dispatchEvent(new Event('selectionchange')); });
    const snapshot = handle.getSelectionSnapshot();
    expect(snapshot).toMatchObject({ path: 'notes/editor.md', docRevision: 0 });
    expect(snapshot?.from).toBeLessThan(snapshot?.to ?? 0);
    expect(snapshot?.selectedMarkdown).toContain('[链接](https://example.com)');
    expect(onSelectionChange).toHaveBeenCalled();
  });

  it('writes an AI selection result once and rejects the same stale snapshot', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const options: MountEditorOptions = {
      element: host, client: { readNote: vi.fn(), saveNote: vi.fn(), uploadImage: vi.fn() },
      locale: 'en', onStatus: vi.fn(), onConflictOpen: vi.fn(), onFatal: vi.fn(),
    };
    let handle!: ReturnType<typeof mountUnifiedEditor>;
    await act(async () => { handle = mountUnifiedEditor(options); });
    mounts.push({ host, unmount: () => handle.destroy() });
    await act(async () => { await handle.load(documentFixture({ markdown: '[selected text](https://example.com)' })); });
    const editor = await waitForEditor(host);
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor.querySelector('p')!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => { document.dispatchEvent(new Event('selectionchange')); });
    const snapshot = handle.getSelectionSnapshot();
    expect(snapshot).not.toBeNull();
    expect(handle.applyAiResult(snapshot!, 'rewritten', 'replace')).toBe(true);
    expect(handle.getMarkdown()).toContain('rewritten');
    expect(handle.applyAiResult(snapshot!, 'again', 'replace')).toBe(false);
  });

  it('undoes one real editor transaction and ignores events after destroy', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const saveNote = vi.fn(async (input) => ({ path: input.path, version: 'b'.repeat(64) }));
    const onStatus = vi.fn();
    const options: MountEditorOptions = {
      element: host, client: { readNote: vi.fn(), saveNote, uploadImage: vi.fn() },
      locale: 'en', onStatus, onConflictOpen: vi.fn(), onFatal: vi.fn(),
    };
    let handle!: ReturnType<typeof mountUnifiedEditor>;
    await act(async () => { handle = mountUnifiedEditor(options); });
    await act(async () => { await handle.load(documentFixture({ markdown: 'before' })); });
    const editor = await waitForEditor(host);
    editor.querySelector('p')!.textContent = 'after';
    await act(async () => { fireEvent.input(editor.querySelector('p')!, { inputType: 'insertText', data: 'r' }); });
    await waitForChange(handle);
    expect(handle.getMarkdown()).toContain('after');
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        ctrlKey: true,
        key: 'z',
        code: 'KeyZ',
      }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(handle.getMarkdown()).toContain('before');

    const statuses = onStatus.mock.calls.length;
    await act(async () => { handle.destroy(); });
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, metaKey: true, key: 's' }));
    fireEvent.input(editor.querySelector('p')!, { inputType: 'insertText', data: 'x' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    expect(saveNote).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(statuses);
  });

});
