import { beforeEach, describe, expect, it, vi } from 'vitest';

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock('mermaid', () => ({ default: mermaid }));

import {
  isMermaidCodeBlock,
  sanitizeMermaidSvg,
} from '../src/editor/mermaid-node';
import { createWikinestEditor } from '../src/editor/create-editor';
import { serializeDocument } from '../src/editor/markdown';

if (!Range.prototype.getClientRects) {
  const rect = () => new DOMRect(0, 0, 0, 0);
  Object.defineProperty(Range.prototype, 'getClientRects', {
    value: () => Object.assign([rect()], { item: (index: number) => index === 0 ? rect() : null }),
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { value: rect });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushRender() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('Mermaid nodes', () => {
  beforeEach(() => {
    mermaid.initialize.mockReset();
    mermaid.render.mockReset();
    mermaid.render.mockResolvedValue({ svg: '<svg><text>default</text></svg>' });
  });

  it('recognizes only fenced code blocks whose language is mermaid', () => {
    expect(isMermaidCodeBlock({ type: { name: 'code_block' }, attrs: { language: 'mermaid' } })).toBe(true);
    expect(isMermaidCodeBlock({ type: { name: 'code_block' }, attrs: { language: 'Mermaid' } })).toBe(true);
    expect(isMermaidCodeBlock({ type: { name: 'code_block' }, attrs: { language: 'js' } })).toBe(false);
    expect(isMermaidCodeBlock({ type: { name: 'paragraph' }, attrs: { language: 'mermaid' } })).toBe(false);
  });

  it('removes executable and foreign-object output from Mermaid SVG', () => {
    const svg = '<svg><script>alert(1)</script><foreignObject><a href="javascript:alert(1)">x</a></foreignObject><rect onclick="alert(1)" /><a href="https://safe.example">safe</a></svg>';

    const safe = sanitizeMermaidSvg(svg);

    expect(safe).not.toContain('<script');
    expect(safe).not.toContain('foreignObject');
    expect(safe).not.toContain('onclick');
    expect(safe).not.toContain('javascript:');
    expect(safe).toContain('https://safe.example');
  });

  it('removes unsafe inline and stylesheet URL payloads', () => {
    const svg = `<svg>
      <style>@import url(https://evil.example/theme.css); .x { fill: url(javascript:alert(1)); }</style>
      <rect style="fill: url(data:text/css,evil); stroke: url(http://evil.example/a)" />
      <path style="filter: url(file:///tmp/filter)" />
    </svg>`;

    const safe = sanitizeMermaidSvg(svg);

    expect(safe).not.toContain('<style');
    expect(safe).not.toContain('style=');
    expect(safe).not.toMatch(/javascript:|data:|https?:|file:|@import|expression/i);
  });

  it('retains normal Mermaid colors, fonts, and local SVG references', () => {
    const svg = `<svg>
      <style>.node { fill: #ececff; stroke: #333; font-family: Arial, sans-serif; filter: url(#shadow); }</style>
      <rect class="node" style="fill: rgb(236, 236, 255); stroke-width: 2; filter: url(#shadow)" />
    </svg>`;

    const safe = sanitizeMermaidSvg(svg);

    expect(safe).toContain('<style');
    expect(safe).toContain('font-family: Arial');
    expect(safe).toContain('url(#shadow)');
    expect(safe).toContain('style="fill: rgb(236, 236, 255); stroke-width: 2; filter: url(#shadow)"');
  });

  it('installs a Mermaid code-block node view while preserving fenced source', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: '```mermaid\ngraph TD\n  A-->B\n```',
      onMarkdownChange: () => undefined,
    });

    const code = editor.getView().state.doc.firstChild!;
    expect(code.type.name).toBe('code_block');
    expect(code.attrs.language).toBe('mermaid');
    expect(root.querySelector('.wikinest-mermaid-node')).not.toBeNull();
    expect(editor.getView().state.doc.textContent).toContain('A-->B');
    const diagram = root.querySelector<HTMLElement>('.wikinest-mermaid-node > div')!;
    diagram.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(root.querySelector<HTMLElement>('.wikinest-mermaid-node__source')?.hidden).toBe(false);
    expect(diagram.hidden).toBe(true);
    expect(root.querySelectorAll('.wikinest-mermaid-node__source').length).toBe(1);

    await editor.destroy();
  });

  it('keeps only the newest injected render result', async () => {
    const renderA = deferred<{ svg: string }>();
    const renderB = deferred<{ svg: string }>();
    mermaid.render.mockImplementation((_id: string, source: string) => (
      source.includes('B') ? renderB.promise : renderA.promise
    ));
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: '```mermaid\ngraph TD\nA\n```',
      onMarkdownChange: () => undefined,
    });
    await flushRender();
    const view = editor.getView();
    const block = view.state.doc.firstChild!;
    view.dispatch(view.state.tr.insertText('B', block.nodeSize - 1));
    await flushRender();

    renderB.resolve({ svg: '<svg><text>B</text></svg>' });
    await flushRender();
    renderA.resolve({ svg: '<svg><text>A</text></svg>' });
    await flushRender();

    expect(root.querySelector('.wikinest-mermaid')?.textContent).toContain('B');
    expect(root.querySelector('.wikinest-mermaid')?.textContent).not.toContain('A');
    await editor.destroy();
  });

  it('keeps rejected render errors local and preserves edited Mermaid source', async () => {
    mermaid.render.mockRejectedValue(new Error('invalid diagram'));
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: '```mermaid\ngraph TD\nA\n```',
      onMarkdownChange: () => undefined,
    });
    await flushRender();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Mermaid 图表语法无效');
    const view = editor.getView();
    root.querySelector<HTMLElement>('.wikinest-mermaid-node > div')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const source = root.querySelector<HTMLElement>('.wikinest-mermaid-node__source code')!;
    source.textContent = 'graph TD\nNEW';
    source.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'NEW' }));
    await flushRender();
    expect(serializeDocument(editor.editor, view)).toContain('```mermaid\ngraph TD\nNEW');
    await editor.destroy();
  });

  it('ignores a render result after the node view is destroyed', async () => {
    const render = deferred<{ svg: string }>();
    mermaid.render.mockReturnValue(render.promise);
    const root = document.createElement('div');
    document.body.append(root);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const editor = await createWikinestEditor({
      root,
      markdown: '```mermaid\ngraph TD\nA\n```',
      onMarkdownChange: () => undefined,
    });
    await flushRender();
    await editor.destroy();
    render.resolve({ svg: '<svg><text>late</text></svg>' });
    await flushRender();

    expect(root.querySelector('svg')).toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
