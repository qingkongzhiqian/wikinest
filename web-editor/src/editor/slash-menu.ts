import { setBlockType, wrapIn } from '@milkdown/prose/commands';
import { Fragment } from '@milkdown/prose/model';
import { wrapInList } from '@milkdown/prose/schema-list';
import { Plugin, TextSelection, type Transaction } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

type SlashCommandId =
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'paragraph'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'blockquote'
  | 'code-block'
  | 'table'
  | 'divider'
  | 'mermaid';

export interface SlashCommand {
  id: SlashCommandId;
  label: string;
  description: string;
  keywords: readonly string[];
  icon: string;
}

export interface SlashMenuExtension {
  destroy(): void;
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'heading-1', label: '一级标题', description: '大标题', keywords: ['h1', 'heading 1', 'title', '一级'], icon: 'H1' },
  { id: 'heading-2', label: '二级标题', description: '章节标题', keywords: ['h2', 'heading 2', '二级'], icon: 'H2' },
  { id: 'heading-3', label: '三级标题', description: '小节标题', keywords: ['h3', 'heading 3', '三级'], icon: 'H3' },
  { id: 'paragraph', label: '正文', description: '普通文本段落', keywords: ['text', 'paragraph', '正文'], icon: 'T' },
  { id: 'bullet-list', label: '无序列表', description: '创建项目符号列表', keywords: ['bullet', 'unordered', 'list', '无序'], icon: '•' },
  { id: 'ordered-list', label: '有序列表', description: '创建编号列表', keywords: ['number', 'ordered', 'list', '有序'], icon: '1.' },
  { id: 'task-list', label: '任务列表', description: '创建待办事项', keywords: ['task', 'todo', 'check', '任务', '待办'], icon: '☐' },
  { id: 'blockquote', label: '引用', description: '创建引用段落', keywords: ['quote', 'blockquote', '引用'], icon: '❝' },
  { id: 'code-block', label: '代码块', description: '创建多行代码', keywords: ['code', '代码'], icon: '</>' },
  { id: 'table', label: '表格', description: '插入 3 × 3 表格', keywords: ['table', 'grid', '表格'], icon: '▦' },
  { id: 'divider', label: '分割线', description: '插入水平分割线', keywords: ['divider', 'rule', 'hr', '分割'], icon: '—' },
  { id: 'mermaid', label: 'Mermaid 图表', description: '创建 Mermaid 代码块', keywords: ['mermaid', 'diagram', '图表'], icon: '◇' },
];

export function filterSlashCommands(query: string): SlashCommand[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter((command) => (
    command.label.toLocaleLowerCase().includes(normalized)
    || command.keywords.some((keyword) => keyword.toLocaleLowerCase().includes(normalized))
  ));
}

interface ActiveSlashQuery {
  from: number;
  to: number;
  query: string;
  signature: string;
}

function activeSlashQuery(view: EditorView): ActiveSlashQuery | null {
  const { selection } = view.state;
  if (!selection.empty || selection.$from.parent.type.name !== 'paragraph') return null;
  const text = selection.$from.parent.textBetween(0, selection.$from.parentOffset, '\n', '\n');
  const match = text.match(/^\/([^\s/]*)$/u);
  if (!match) return null;
  const from = selection.$from.start();
  return {
    from,
    to: selection.from,
    query: match[1] || '',
    signature: `${from}:${selection.from}:${match[1] || ''}`,
  };
}

function replaceCurrentBlockWithTable(view: EditorView): boolean {
  const { state } = view;
  const { schema, selection } = state;
  const tableType = schema.nodes.table;
  const rowType = schema.nodes.table_row;
  const headerRowType = schema.nodes.table_header_row || rowType;
  const headerType = schema.nodes.table_header || schema.nodes.table_cell;
  const cellType = schema.nodes.table_cell;
  const paragraphType = schema.nodes.paragraph;
  if (!tableType || !rowType || !headerRowType || !headerType || !cellType || !paragraphType) return false;
  const cells = (type: typeof cellType) => Array.from({ length: 3 }, () => type.createAndFill()!);
  const header = headerRowType.create(null, cells(headerType));
  const rows = Array.from({ length: 2 }, () => rowType.create(null, cells(cellType)));
  const table = tableType.create(null, [header, ...rows]);
  const blockStart = selection.$from.before();
  const blockEnd = blockStart + selection.$from.parent.nodeSize;
  const transaction = state.tr.replaceWith(
    blockStart,
    blockEnd,
    Fragment.fromArray([table, paragraphType.create()]),
  );
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(blockStart + 1), 1));
  view.dispatch(transaction.scrollIntoView());
  return true;
}

function markCurrentListItemAsTask(view: EditorView): void {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== 'list_item') continue;
    view.dispatch(view.state.tr.setNodeMarkup(
      $from.before(depth),
      node.type,
      { ...node.attrs, checked: false },
    ));
    return;
  }
}

function executeCommand(view: EditorView, command: SlashCommand, active: ActiveSlashQuery): boolean {
  const cursor = active.from;
  const removeQuery = view.state.tr.delete(active.from, active.to);
  removeQuery.setSelection(TextSelection.create(removeQuery.doc, cursor));
  view.dispatch(removeQuery);
  const dispatch = (transaction: Transaction) => (
    view.dispatch(transaction.scrollIntoView())
  );
  const { schema } = view.state;
  switch (command.id) {
    case 'heading-1':
    case 'heading-2':
    case 'heading-3':
      return setBlockType(schema.nodes.heading, { level: Number(command.id.at(-1)) })(view.state, dispatch);
    case 'paragraph':
      return setBlockType(schema.nodes.paragraph)(view.state, dispatch);
    case 'bullet-list':
      return wrapInList(schema.nodes.bullet_list)(view.state, dispatch);
    case 'ordered-list':
      return wrapInList(schema.nodes.ordered_list)(view.state, dispatch);
    case 'task-list': {
      const wrapped = wrapInList(schema.nodes.bullet_list)(view.state, dispatch);
      if (wrapped) markCurrentListItemAsTask(view);
      return wrapped;
    }
    case 'blockquote':
      return wrapIn(schema.nodes.blockquote)(view.state, dispatch);
    case 'code-block':
      return setBlockType(schema.nodes.code_block, { language: '' })(view.state, dispatch);
    case 'mermaid':
      return setBlockType(schema.nodes.code_block, { language: 'mermaid' })(view.state, dispatch);
    case 'table':
      return replaceCurrentBlockWithTable(view);
    case 'divider': {
      const paragraph = schema.nodes.paragraph.create();
      const divider = schema.nodes.hr.create();
      const blockStart = view.state.selection.$from.before();
      const blockEnd = blockStart + view.state.selection.$from.parent.nodeSize;
      const transaction = view.state.tr.replaceWith(
        blockStart,
        blockEnd,
        Fragment.fromArray([divider, paragraph]),
      );
      transaction.setSelection(TextSelection.near(transaction.doc.resolve(blockStart + 2), 1));
      view.dispatch(transaction.scrollIntoView());
      return true;
    }
  }
}

export function installSlashMenu(view: EditorView): SlashMenuExtension {
  const menu = document.createElement('div');
  menu.className = 'wikinest-slash-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', '插入内容');
  menu.hidden = true;
  document.body.append(menu);
  let active: ActiveSlashQuery | null = null;
  let filtered: SlashCommand[] = [];
  let selectedIndex = 0;
  let dismissedSignature = '';

  const positionMenu = () => {
    if (!active) return;
    try {
      const coordinates = view.coordsAtPos(active.to);
      menu.style.left = `${Math.max(12, coordinates.left)}px`;
      menu.style.top = `${coordinates.bottom + 6}px`;
    } catch {
      const rect = view.dom.getBoundingClientRect();
      menu.style.left = `${Math.max(12, rect.left)}px`;
      menu.style.top = `${rect.top + 32}px`;
    }
  };

  const render = () => {
    menu.replaceChildren();
    filtered.forEach((command, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wikinest-slash-menu__item';
      button.dataset.index = String(index);
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === selectedIndex));
      if (index === selectedIndex) button.classList.add('is-selected');
      const icon = document.createElement('span');
      icon.className = 'wikinest-slash-menu__icon';
      icon.textContent = command.icon;
      const text = document.createElement('span');
      text.className = 'wikinest-slash-menu__text';
      const label = document.createElement('strong');
      label.textContent = command.label;
      const description = document.createElement('small');
      description.textContent = command.description;
      text.append(label, description);
      button.append(icon, text);
      menu.append(button);
    });
  };

  const update = () => {
    const next = activeSlashQuery(view);
    if (!next || next.signature === dismissedSignature) {
      active = next;
      menu.hidden = true;
      return;
    }
    if (active?.signature !== next.signature) selectedIndex = 0;
    active = next;
    filtered = filterSlashCommands(next.query);
    if (!filtered.length) {
      menu.hidden = true;
      return;
    }
    selectedIndex = Math.min(selectedIndex, filtered.length - 1);
    render();
    positionMenu();
    menu.hidden = false;
  };

  const choose = (index: number) => {
    if (!active || !filtered[index]) return;
    const selected = filtered[index];
    menu.hidden = true;
    dismissedSignature = '';
    executeCommand(view, selected, active);
    view.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (menu.hidden || !active || !filtered.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      selectedIndex = (selectedIndex + direction + filtered.length) % filtered.length;
      render();
      menu.querySelector<HTMLElement>('.is-selected')?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      choose(selectedIndex);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismissedSignature = active.signature;
      menu.hidden = true;
    }
  };

  const onMouseDown = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>('[data-index]');
    if (!button || !menu.contains(button)) return;
    event.preventDefault();
    choose(Number(button.dataset.index));
  };

  view.dom.addEventListener('keydown', onKeyDown, true);
  menu.addEventListener('mousedown', onMouseDown);
  const plugin = new Plugin({
    view: () => ({
      update,
      destroy: () => undefined,
    }),
  });
  view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, plugin] }));
  update();

  return {
    destroy() {
      view.dom.removeEventListener('keydown', onKeyDown, true);
      menu.removeEventListener('mousedown', onMouseDown);
      menu.remove();
    },
  };
}
