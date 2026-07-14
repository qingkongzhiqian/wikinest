// Auto-categorization built on the shared OpenAI-compatible LLM client.
// See src/core/llm.js for provider configuration (env vars).

import { readNote, listCategories, setNoteCategories, normalizeCategoryList } from './store.js';
import { chat, extractJson, isLLMConfigured } from './llm.js';
import { SINGLE_SOURCE_LANGUAGE_RULE } from './prompts.js';

const MAX_CONTENT_CHARS = 4000;
const MAX_CATEGORIES = 3;

export function isClassifyConfigured() {
  return isLLMConfigured();
}

export function normalizeCategories(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && Array.isArray(raw.categories)) arr = raw.categories;
  else if (typeof raw === 'string') arr = [raw];
  return [...new Set(
    arr
      .map((x) => (typeof x === 'string' ? x : x?.name))
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean),
  )].slice(0, MAX_CATEGORIES);
}

/**
 * Classify a note into 1..3 categories, reusing existing ones where possible.
 * @param {object} args
 * @param {string} args.title
 * @param {string} args.content
 * @param {string[]} [args.existingCategories]
 * @returns {Promise<string[]>}
 */
export async function classifyNote({ title = '', content = '', existingCategories = [] }) {
  if (!isClassifyConfigured()) {
    throw new Error('自动分类未配置:请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  }
  const body = (content || '').slice(0, MAX_CONTENT_CHARS);
  const existing = existingCategories.length ? existingCategories.join(', ') : '(none)';

  const system =
    'You classify personal notes into 1 to 3 categories. ' +
    'Prefer semantically matching items from the existing categories and create a new category only when none fits. ' +
    'Use broad, reusable categories instead of note-specific labels. ' +
    SINGLE_SOURCE_LANGUAGE_RULE + ' ' +
    'Return only JSON in this shape: {"categories":["category 1","category 2"]}.';
  const user =
    `Existing categories: ${existing}\n\nTitle: ${title || '(none)'}\n\nContent:\n${body}`;

  const text = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.2 },
  );
  const cats = normalizeCategories(extractJson(text));
  if (!cats.length) throw new Error('模型未返回有效分类');
  return cats;
}

/**
 * (Re)classify a saved note and persist the result. Always overwrites.
 * Reads the note's full content so it works after append/edit too.
 * @returns {Promise<string[]>}
 */
export async function classifyAndSet(savedPath) {
  const { data, content } = await readNote(savedPath);
  const existing = (await listCategories()).map((c) => c.name);
  const cats = await classifyNote({
    title: (data.title || '').toString(),
    content,
    existingCategories: existing,
  });
  await setNoteCategories(savedPath, cats);
  return cats;
}

/**
 * Best-effort auto-tagging used right after a write (web / MCP / CLI).
 * Silently skips when the LLM isn't configured, never throws, and won't
 * overwrite categories that are already set (e.g. edited by hand).
 * @returns {Promise<string[]>}
 */
export async function autoTagIfEmpty(savedPath) {
  if (!isClassifyConfigured()) return [];
  try {
    const { data } = await readNote(savedPath);
    const current = normalizeCategoryList(data.categories);
    if (current.length) return current;
    return await classifyAndSet(savedPath);
  } catch (err) {
    console.error('auto-classify failed:', err.message);
    return [];
  }
}
