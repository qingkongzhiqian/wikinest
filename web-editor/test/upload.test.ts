import { describe, expect, it, vi } from 'vitest';
import {
  MAX_IMAGE_UPLOAD_BYTES,
  createUploadController,
} from '../src/editor/upload';
import { createWikinestEditor } from '../src/editor/create-editor';
import { serializeDocument } from '../src/editor/markdown';
import { undo } from '@milkdown/prose/history';

function image(name = 'diagram.png', size = 4): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' });
}

describe('createUploadController', () => {
  it('rejects non-images and oversized images before issuing an upload', async () => {
    const upload = vi.fn();
    const controller = createUploadController({
      uploadImage: upload,
      insertPlaceholder: vi.fn(() => 'placeholder'),
      replacePlaceholder: vi.fn(),
      failPlaceholder: vi.fn(),
      hasPlaceholder: vi.fn(() => true),
    });

    await expect(controller.upload(new File(['text'], 'note.txt', { type: 'text/plain' })))
      .resolves.toEqual({ accepted: false, reason: 'type' });
    await expect(controller.upload(image('huge.png', MAX_IMAGE_UPLOAD_BYTES + 1)))
      .resolves.toEqual({ accepted: false, reason: 'size' });

    expect(upload).not.toHaveBeenCalled();
  });

  it('uses one placeholder per file retry and replaces it only once on success', async () => {
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ url: 'https://assets.example.test/diagram.png' });
    const insertPlaceholder = vi.fn(() => 'placeholder-1');
    const replacePlaceholder = vi.fn();
    const failPlaceholder = vi.fn();
    const controller = createUploadController({
      uploadImage: upload,
      insertPlaceholder,
      replacePlaceholder,
      failPlaceholder,
      hasPlaceholder: vi.fn(() => true),
    });
    const file = image();

    await controller.upload(file);
    await controller.retry('placeholder-1');

    expect(insertPlaceholder).toHaveBeenCalledTimes(1);
    expect(failPlaceholder).toHaveBeenCalledWith('placeholder-1', expect.any(Error));
    expect(replacePlaceholder).toHaveBeenCalledWith('placeholder-1', {
      src: 'https://assets.example.test/diagram.png',
      alt: 'diagram',
    });
  });

  it('fails the placeholder without inserting an unsafe successful upload URL', async () => {
    const replacePlaceholder = vi.fn();
    const failPlaceholder = vi.fn();
    const controller = createUploadController({
      uploadImage: vi.fn(async () => ({ url: 'data:image/png;base64,secret' })),
      insertPlaceholder: vi.fn(() => 'placeholder-unsafe'),
      replacePlaceholder,
      failPlaceholder,
      hasPlaceholder: vi.fn(() => true),
    });

    await controller.upload(image('unsafe.png'));

    expect(replacePlaceholder).not.toHaveBeenCalled();
    expect(failPlaceholder).toHaveBeenCalledWith('placeholder-unsafe', expect.any(Error));
  });

  it('aborts deleted placeholders and ignores a late upload result', async () => {
    let resolveUpload!: (value: { url: string }) => void;
    const uploadImage = vi.fn((_file: File, _signal: AbortSignal) => new Promise<{ url: string }>((resolve) => {
      resolveUpload = resolve;
    }));
    const replacePlaceholder = vi.fn();
    const controller = createUploadController({
      uploadImage,
      insertPlaceholder: vi.fn(() => 'placeholder-1'),
      replacePlaceholder,
      failPlaceholder: vi.fn(),
      hasPlaceholder: vi.fn(() => false),
    });

    const pending = controller.upload(image());
    controller.remove('placeholder-1');
    resolveUpload({ url: 'https://assets.example.test/late.png' });
    await pending;

    expect(uploadImage.mock.calls[0][1].aborted).toBe(true);
    expect(replacePlaceholder).not.toHaveBeenCalled();
  });

  it('routes pasted images through the editor controller into one image transaction', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const uploaded = vi.fn(async () => ({ url: 'https://assets.example.test/pasted.png' }));
    const editor = await createWikinestEditor({
      root,
      markdown: 'before',
      onMarkdownChange: () => undefined,
      uploadImage: uploaded,
    });
    const file = image('pasted.png');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
    editor.getView().dom.dispatchEvent(paste);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(uploaded).toHaveBeenCalledWith(file, expect.any(AbortSignal));
    expect(serializeDocument(editor.editor, editor.getView())).toContain(
      '![pasted](https://assets.example.test/pasted.png)',
    );
    undo(editor.getView().state, (transaction) => editor.getView().dispatch(transaction));
    expect(serializeDocument(editor.editor, editor.getView())).not.toContain('pasted.png');

    await editor.destroy();
  });

  it('routes dropped images through the same controller', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const uploaded = vi.fn(async () => ({ url: 'https://assets.example.test/dropped.png' }));
    const editor = await createWikinestEditor({
      root,
      markdown: 'before',
      onMarkdownChange: () => undefined,
      uploadImage: uploaded,
    });
    const file = image('dropped.png');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
    const view = editor.getView();
    const posAtCoords = vi.spyOn(view, 'posAtCoords').mockReturnValue(null);
    try {
      view.dom.dispatchEvent(drop);
    } finally {
      posAtCoords.mockRestore();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(uploaded).toHaveBeenCalledWith(file, expect.any(AbortSignal));
    expect(serializeDocument(editor.editor, editor.getView())).toContain(
      '![dropped](https://assets.example.test/dropped.png)',
    );
    await editor.destroy();
  });

  it('routes file-picker images through the same controller', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const uploaded = vi.fn(async () => ({ url: 'https://assets.example.test/picked.png' }));
    const editor = await createWikinestEditor({
      root,
      markdown: 'before',
      onMarkdownChange: () => undefined,
      uploadImage: uploaded,
    });
    const file = image('picked.png');
    const originalClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function click() {
      Object.defineProperty(this, 'files', { value: [file] });
      this.dispatchEvent(new Event('change'));
    };
    try {
      editor.openImagePicker();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      HTMLInputElement.prototype.click = originalClick;
    }

    expect(uploaded).toHaveBeenCalledWith(file, expect.any(AbortSignal));
    expect(serializeDocument(editor.editor, editor.getView())).toContain(
      '![picked](https://assets.example.test/picked.png)',
    );
    await editor.destroy();
  });

  it('keeps a pending placeholder mapped across edits before and after it', async () => {
    let resolveUpload!: (result: { url: string }) => void;
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: 'body',
      onMarkdownChange: () => undefined,
      uploadImage: () => new Promise((resolve) => { resolveUpload = resolve; }),
    });
    const file = image('mapped.png');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
    editor.getView().dom.dispatchEvent(paste);
    const view = editor.getView();
    view.dispatch(view.state.tr.insertText('before ', 1));
    view.dispatch(view.state.tr.insertText(' after', view.state.doc.content.size - 1));
    resolveUpload({ url: 'https://assets.example.test/mapped.png' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(serializeDocument(editor.editor, editor.getView())).toContain(
      '![mapped](https://assets.example.test/mapped.png)',
    );
    expect(root.querySelectorAll('.wikinest-upload-placeholder')).toHaveLength(0);
    await editor.destroy();
  });

  it('does not replace a deleted placeholder before its abort cleanup microtask', async () => {
    let resolveUpload!: (result: { url: string }) => void;
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: 'body',
      onMarkdownChange: () => undefined,
      uploadImage: () => new Promise((resolve) => { resolveUpload = resolve; }),
    });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [image('deleted.png')] } });
    editor.getView().dom.dispatchEvent(paste);
    const view = editor.getView();
    view.dispatch(view.state.tr.delete(1, view.state.doc.content.size - 1));
    resolveUpload({ url: 'https://assets.example.test/deleted.png' });
    await Promise.resolve();

    expect(serializeDocument(editor.editor, editor.getView())).not.toContain('deleted.png');
    await editor.destroy();
  });

  it('keeps a failed editor placeholder retryable without serializing a bad URL', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const uploaded = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ url: 'https://assets.example.test/retry.png' });
    const editor = await createWikinestEditor({
      root,
      markdown: 'before',
      onMarkdownChange: () => undefined,
      uploadImage: uploaded,
    });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [image('retry.png')] } });
    editor.getView().dom.dispatchEvent(paste);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(root.querySelector('.wikinest-upload-placeholder')).not.toBeNull();
    expect(serializeDocument(editor.editor, editor.getView())).not.toContain('retry.png');
    root.querySelector<HTMLButtonElement>('.wikinest-upload-placeholder button')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(serializeDocument(editor.editor, editor.getView())).toContain(
      '![retry](https://assets.example.test/retry.png)',
    );

    await editor.destroy();
  });
});
