import {
  chatStream,
  isLLMConfigured,
} from './llm.js';

const MAX_SELECTION_CHARS = 16_000;
const MAX_INSTRUCTION_CHARS = 16_000;
const MAX_NOTE_CHARS = 32_000;
const MAX_HISTORY_CHARS = 48_000;

const CONTEXT_LABELS = {
  selection: '选区',
  document: '当前文档',
};
const CONTEXT_MODES = new Set(['selection', 'document', 'general']);

function systemPrompt(mode) {
  if (mode === 'selection') {
    return [
      '你是 Wikinest 的 AI Markdown 编辑助手。',
      '只输出 Markdown 格式的编辑结果，不要解释、寒暄或添加代码围栏。',
      '除非用户明确要求改变，否则必须保留来源中的事实和信息，不得编造内容。',
      '请严格执行用户指令，并把回答限制为可直接替换选区的内容。',
    ].join('\n');
  }
  return [
    '你是 Wikinest 的 AI Markdown 问答助手。',
    '请使用 Markdown 直接回答用户问题，不要寒暄或添加代码围栏。',
    '如有来源内容，必须忠于其中的事实和信息，不得编造内容。',
  ].join('\n');
}

export function isAiEditConfigured() {
  return isLLMConfigured();
}

function validateInput({
  mode,
  messages,
  selection,
  noteContent,
} = {}) {
  if (!Object.hasOwn(CONTEXT_LABELS, mode) && mode !== 'general') {
    throw new Error('不支持的 AI 编辑模式');
  }
  if (!Array.isArray(messages)) throw new Error('messages 必须是数组');

  for (const message of messages) {
    if (message?.role !== 'user' && message?.role !== 'assistant') {
      throw new Error('消息角色仅支持 user 或 assistant');
    }
    if (typeof message.content !== 'string') {
      throw new Error('消息内容必须是字符串');
    }
    if (message.contextMode !== undefined && !CONTEXT_MODES.has(message.contextMode)) {
      throw new Error('contextMode 仅支持 selection、document 或 general');
    }
  }

  const instruction = messages.at(-1);
  if (instruction?.role !== 'user' || !instruction.content.trim()) {
    throw new Error('最后一条消息必须是非空的用户指令');
  }
  if (typeof selection !== 'string') throw new Error('selection 必须是字符串');
  if (typeof noteContent !== 'string') throw new Error('noteContent 必须是字符串');
  if (mode === 'selection' && !selection.trim()) throw new Error('选区内容不能为空');
  if (mode === 'document' && !noteContent.trim()) throw new Error('当前文档内容不能为空');
}

function recentHistory(messages, maxChars) {
  const retained = [];
  let remaining = maxChars;

  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index];
    const content = message.content.length > remaining
      ? message.content.slice(-remaining)
      : message.content;
    retained.unshift({ role: message.role, content });
    remaining -= content.length;
  }

  return retained;
}

function editRequest({
  mode,
  instruction,
  selection,
  noteContent,
  includeNote,
}) {
  const instructionSection = `用户指令：\n${instruction.slice(0, MAX_INSTRUCTION_CHARS)}`;
  if (mode === 'general') return instructionSection;

  const contextPrefix = `\n\n${CONTEXT_LABELS[mode]}：\n`;
  const contextBudget = mode === 'selection'
    ? MAX_SELECTION_CHARS
    : Math.min(
      MAX_NOTE_CHARS,
      MAX_HISTORY_CHARS - instructionSection.length - contextPrefix.length,
    );
  const contextSource = mode === 'selection' ? selection : noteContent;
  const request = `${instructionSection}${contextPrefix}${contextSource.slice(0, contextBudget)}`;
  if (mode === 'selection' && includeNote === true) {
    const notePrefix = '\n\n全文笔记（仅供参考）：\n';
    const noteBudget = Math.min(
      MAX_NOTE_CHARS,
      MAX_HISTORY_CHARS - request.length - notePrefix.length,
    );
    return `${request}${notePrefix}${noteContent.slice(0, noteBudget)}`;
  }
  return request;
}

export async function* streamAiEdit(input, options = {}) {
  const mode = input?.mode ?? 'selection';
  validateInput({ ...input, mode });

  const {
    messages,
    selection,
    noteContent,
    includeNote,
  } = input;
  const instruction = messages.at(-1).content;
  const finalRequest = editRequest({
    mode,
    instruction,
    selection,
    noteContent,
    includeNote,
  });
  const eligibleHistory = messages.slice(0, -1)
    .filter((message) => mode !== 'general' || message.contextMode === 'general');
  const history = recentHistory(
    eligibleHistory,
    MAX_HISTORY_CHARS - finalRequest.length,
  );
  const requestMessages = [
    { role: 'system', content: systemPrompt(mode) },
    ...history,
    {
      role: 'user',
      content: finalRequest,
    },
  ];
  const { stream = chatStream, ...streamOptions } = options;

  yield* stream(requestMessages, streamOptions);
}
