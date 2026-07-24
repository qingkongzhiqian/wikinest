import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const editorCss = readFileSync(path.resolve(process.cwd(), 'web-editor/src/editor.css'), 'utf8');

describe('Typora-style Markdown presentation', () => {
  beforeEach(() => {
    expect(editorCss).toContain('border-collapse: collapse');
    document.head.innerHTML = `<style>${editorCss}</style>`;
    document.body.innerHTML = `
      <div class="wikinest-editor">
        <div class="wikinest-editor__content">
          <div class="ProseMirror">
            <blockquote><p>warning</p></blockquote>
            <table><tbody><tr><th>field</th><td>value</td></tr></tbody></table>
            <p><code>inline</code></p>
            <img src="/image.png" alt="image">
          </div>
        </div>
      </div>
    `;
  });

  it('renders tables with visible grid, spacing, and a distinct header', () => {
    const table = document.querySelector('table') as HTMLTableElement;
    const header = document.querySelector('th') as HTMLTableCellElement;
    const cell = document.querySelector('td') as HTMLTableCellElement;

    expect(getComputedStyle(table).borderCollapse).toBe('collapse');
    expect(getComputedStyle(cell).borderTopStyle).toBe('solid');
    expect(getComputedStyle(cell).borderTopWidth).toBe('1px');
    expect(getComputedStyle(cell).paddingTop).toBe('8px');
    expect(getComputedStyle(header).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  it('visually distinguishes quotes and inline code and constrains images', () => {
    const quote = document.querySelector('blockquote') as HTMLElement;
    const code = document.querySelector('code') as HTMLElement;
    const image = document.querySelector('img') as HTMLImageElement;

    expect(getComputedStyle(quote).borderLeftWidth).toBe('4px');
    expect(getComputedStyle(code).fontFamily).toContain('monospace');
    expect(getComputedStyle(image).maxWidth).toBe('100%');
  });
});
