import { afterEach, describe, expect, it } from 'vitest';
import { createWikinestEditor } from '../src/editor/create-editor';
import { filterSlashCommands } from '../src/editor/slash-menu';

describe('slash command menu', () => {
  afterEach(() => document.body.replaceChildren());

  it('filters commands by Chinese labels and English keywords', () => {
    expect(filterSlashCommands('一级').map((command) => command.id)).toEqual(['heading-1']);
    expect(filterSlashCommands('table').map((command) => command.id)).toEqual(['table']);
    expect(filterSlashCommands('代码').map((command) => command.id)).toEqual(['code-block']);
  });

  it('opens after slash and converts the paragraph with keyboard selection', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: '',
      onMarkdownChange: () => undefined,
    });
    const view = editor.getView();

    view.dispatch(view.state.tr.insertText('/'));
    const menu = document.querySelector<HTMLElement>('.wikinest-slash-menu');
    expect(menu?.hidden).toBe(false);
    expect(menu?.textContent).toContain('一级标题');

    view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    expect(view.state.doc.firstChild?.type.name).toBe('heading');
    expect(view.state.doc.firstChild?.attrs.level).toBe(1);
    expect(view.state.doc.textContent).toBe('');
    expect(menu?.hidden).toBe(true);
    await editor.destroy();
  });

  it('moves through commands with arrow keys before executing', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: '',
      onMarkdownChange: () => undefined,
    });
    const view = editor.getView();

    view.dispatch(view.state.tr.insertText('/'));
    view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector('.wikinest-slash-menu__item.is-selected')?.textContent)
      .toContain('二级标题');
    view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    expect(view.state.doc.firstChild?.type.name).toBe('heading');
    expect(view.state.doc.firstChild?.attrs.level).toBe(2);
    await editor.destroy();
  });

  it('inserts a three-column table and removes the slash query', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: '',
      onMarkdownChange: () => undefined,
    });
    const view = editor.getView();

    view.dispatch(view.state.tr.insertText('/table'));
    view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    expect(view.state.doc.firstChild?.type.name).toBe('table');
    expect(view.state.doc.firstChild?.firstChild?.childCount).toBe(3);
    expect(view.state.doc.textContent).not.toContain('/table');
    await editor.destroy();
  });

  it.each([
    ['/h2', 'heading', 2],
    ['/code', 'code_block', undefined],
    ['/quote', 'blockquote', undefined],
    ['/bullet', 'bullet_list', undefined],
    ['/number', 'ordered_list', undefined],
    ['/task', 'bullet_list', undefined],
    ['/hr', 'hr', undefined],
    ['/mermaid', 'code_block', 'mermaid'],
  ])('executes %s as a schema-safe block command', async (query, nodeName, attribute) => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: '',
      onMarkdownChange: () => undefined,
    });
    const view = editor.getView();

    view.dispatch(view.state.tr.insertText(query));
    view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    expect(view.state.doc.firstChild?.type.name).toBe(nodeName);
    if (query === '/h2') expect(view.state.doc.firstChild?.attrs.level).toBe(attribute);
    if (query === '/mermaid') expect(view.state.doc.firstChild?.attrs.language).toBe(attribute);
    if (query === '/task') {
      expect(view.state.doc.firstChild?.firstChild?.attrs.checked).toBe(false);
    }
    await editor.destroy();
  });

  it('closes on Escape without changing typed text', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await createWikinestEditor({
      root,
      markdown: '',
      onMarkdownChange: () => undefined,
    });
    const view = editor.getView();

    view.dispatch(view.state.tr.insertText('/'));
    view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));

    expect(document.querySelector<HTMLElement>('.wikinest-slash-menu')?.hidden).toBe(true);
    expect(view.state.doc.textContent).toBe('/');
    await editor.destroy();
  });
});
