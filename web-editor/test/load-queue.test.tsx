import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createEditor } = vi.hoisted(() => ({ createEditor: vi.fn() }));
vi.mock('../src/editor/create-editor', () => ({ createWikinestEditor: createEditor }));

import { mountUnifiedEditor } from '../src/main';
import type { NoteDocument } from '../src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function note(path: string): NoteDocument {
  return { path, markdown: `# ${path}`, frontmatter: {}, version: path.padEnd(64, 'a') };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((next) => { resolve = next; }), resolve };
}

describe('load queue', () => {
  let handle: ReturnType<typeof mountUnifiedEditor> | undefined;

  afterEach(async () => {
    await act(async () => handle?.destroy());
    handle = undefined;
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('destroys an editor that becomes stale while creating and publishes only the latest load', async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    const editorDouble = () => ({
      getView: vi.fn(() => ({ dom: document.createElement('div') })),
      replaceMarkdown: vi.fn(),
      destroy: vi.fn(async () => undefined),
      editor: {},
    });
    const firstEditor = editorDouble();
    const secondEditor = editorDouble();
    createEditor.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const host = document.createElement('div');
    document.body.append(host);
    await act(async () => {
      handle = mountUnifiedEditor({
        element: host,
        client: { readNote: vi.fn(), saveNote: vi.fn(), uploadImage: vi.fn() },
        locale: 'en',
        onStatus: vi.fn(),
        onConflictOpen: vi.fn(),
        onFatal: vi.fn(),
      });
    });

    const mounted = handle!;
    const one = mounted.load(note('notes/one.md'));
    for (let attempt = 0; attempt < 10 && !createEditor.mock.calls.length; attempt += 1) {
      await Promise.resolve();
    }
    expect(createEditor).toHaveBeenCalledTimes(1);
    const two = mounted.load(note('notes/two.md'));
    await act(async () => {
      first.resolve(firstEditor);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(firstEditor.destroy).toHaveBeenCalledTimes(1);

    await act(async () => {
      second.resolve(secondEditor);
      await Promise.all([one, two]);
    });
    expect(mounted.getDocumentState().path).toBe('notes/two.md');
    expect(secondEditor.destroy).not.toHaveBeenCalled();
  });
});
