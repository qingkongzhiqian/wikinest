// AI 整理 & 聚合:把丢进来的原始内容整理成规范排版,并把同一分类下的
// 零散笔记聚合成一篇综述文章。定位:人只负责记录,AI 负责整理。
//
// 依赖共享 LLM 客户端(src/core/llm.js),配置见其头部注释。

import {
  readNote, writeNote, getAllNotes, normalizeCategoryList, toRelPath, resolveNotePath,
  nextAvailablePath,
} from './store.js';
import { chat, isLLMConfigured, stripCodeFence } from './llm.js';
import {
  SINGLE_SOURCE_LANGUAGE_RULE,
  MULTI_SOURCE_LANGUAGE_RULE,
  isHanDocumentMajority,
  referenceHeadingForDocuments,
} from './prompts.js';
import { CONTENT_KINDS, contentKind } from './content-kind.js';

// 综述文章统一存放目录;这些文件不参与分类计数,也不出现在普通列表里。
export const DIGEST_DIR = 'digests';

// 整理/聚合是长任务,给更宽松的超时(可用 LLM_LONG_TIMEOUT_MS 覆盖)。
const LONG_TIMEOUT_MS = Number(process.env.LLM_LONG_TIMEOUT_MS) || 300_000;

const MAX_TIDY_CHARS = 6_000;         // 单次整理请求的正文上限
const MAX_PER_NOTE_CHARS = 1_800;     // 聚合时每篇笔记截断长度
const MAX_DIGEST_CHARS = 20_000;      // 聚合时所有来源合计上限

function splitTidyContent(body) {
  const chunks = [];
  let remaining = body;
  const preferredBoundary = Math.floor(MAX_TIDY_CHARS / 2);

  while (remaining.length > MAX_TIDY_CHARS) {
    let end = remaining.lastIndexOf('\n\n', MAX_TIDY_CHARS);
    if (end >= preferredBoundary) {
      end += 2;
    } else {
      end = remaining.lastIndexOf('\n', MAX_TIDY_CHARS);
      if (end >= preferredBoundary) end += 1;
      else end = MAX_TIDY_CHARS;
    }
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end);
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

export function isOrganizeConfigured() {
  return isLLMConfigured();
}

/** 某分类对应的综述文件路径(把路径分隔符等替换掉,保留中文)。 */
export function digestPathFor(category) {
  const safe = (category || '').trim().replace(/[/\\]+/g, '-').replace(/\s+/g, ' ');
  if (!safe) throw new Error('category is required');
  return `${DIGEST_DIR}/${safe}`;
}

/** 判断一条笔记是否是综述文件(路径前缀或 frontmatter 标记)。 */
export function isDigest(note) {
  if (!note) return false;
  const p = typeof note === 'string' ? note : note.path;
  if (p && p.startsWith(`${DIGEST_DIR}/`)) return true;
  return Boolean(note.data && note.data.digest);
}

/**
 * 把一段原始 markdown 整理成排版规范的 markdown:分段、合理标题层级、
 * 列表/代码块、修正明显格式混乱。只整理格式,不增删事实、不改写观点。
 * @returns {Promise<string>} 整理后的 markdown 正文(不含 frontmatter)
 */
export async function tidyMarkdown({ title = '', content = '' }) {
  if (!isOrganizeConfigured()) {
    throw new Error('AI 整理未配置:请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  }
  const body = (content || '').trim();
  if (!body) return '';
  const chunks = splitTidyContent(body);

  const system =
    'Format the raw text as clean, well-structured Markdown. ' +
    'Only improve formatting: do not add, remove, or rewrite facts, opinions, or data. ' +
    'Use semantic paragraphs and headings (##/###), lists for parallel items, and fenced blocks for code or commands. ' +
    'Fix obvious typos, punctuation, and excess blank lines while preserving the original tone. ' +
    SINGLE_SOURCE_LANGUAGE_RULE + ' ' +
    'Return only the Markdown body without wrapping the entire response in a code fence.';
  const outputs = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const part = chunks.length > 1
      ? `\nPart ${index + 1} of ${chunks.length}. Format only this part; do not add a document title or continuation note.`
      : '';
    const user = `Title: ${title || '(none)'}${part}\n\nRaw content:\n${chunks[index]}`;
    const text = await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.2, timeoutMs: LONG_TIMEOUT_MS },
    );
    const out = stripCodeFence(text);
    if (!out) throw new Error(`模型未返回第 ${index + 1}/${chunks.length} 段整理结果`);
    outputs.push(out);
  }
  return outputs.join('\n\n');
}

/**
 * 让模型根据正文起一个简洁、概括主题的中文标题(而不是截取第一行)。
 * 未配置或失败时返回空字符串,由调用方决定兜底。
 * @returns {Promise<string>}
 */
export async function suggestTitle({ content = '' }) {
  if (!isOrganizeConfigured()) return '';
  const body = (content || '').trim().slice(0, 4000);
  if (!body) return '';
  const system =
    'Create a concise, accurate title that summarizes the note. ' +
    SINGLE_SOURCE_LANGUAGE_RULE + ' ' +
    'Aim for 6 to 20 Chinese characters or 3 to 12 words in space-delimited languages. ' +
    'Do not use quotation marks or terminal punctuation. Return only the title with no explanation.';
  const text = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: body },
    ],
    { temperature: 0.3 },
  );
  return (text || '')
    .split('\n')[0]
    .trim()
    .replace(/^["'「『《【]+/, '')
    .replace(/["'」』》】。,、!?;：\s]+$/, '')
    .slice(0, 60);
}

/**
 * 读取一篇笔记,整理其正文并写回(保留 frontmatter,打上 tidied 标记)。
 * @returns {Promise<{ path: string, content: string }>}
 */
export async function tidyAndSet(path) {
  const note = await readNote(path);
  const tidied = await tidyMarkdown({
    title: (note.data.title || '').toString(),
    content: note.content,
  });
  const frontmatter = { ...note.data, tidied: true, tidiedAt: new Date().toISOString() };
  const saved = await writeNote(note.path, tidied, { frontmatter });
  return { path: saved, content: tidied };
}

/**
 * 收集某分类下的所有来源笔记(排除综述文件本身),按日期从新到旧。
 */
async function collectCategoryNotes(category) {
  const notes = await getAllNotes();
  const members = notes
    .filter((n) => (
      contentKind(n.data) === CONTENT_KINDS.NOTE
      && !isDigest(n)
      && normalizeCategoryList(n.data.categories).includes(category)
    ))
    .map((n) => {
      const name = n.path.split('/').pop().replace(/\.md$/, '');
      const date = (n.data.savedAt || n.data.date || '').toString()
        || (n.mtimeMs ? new Date(n.mtimeMs).toISOString() : '');
      return {
        path: n.path,
        title: (n.data.title || name).toString(),
        date,
        content: n.content,
      };
    });
  members.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.path.localeCompare(b.path));
  return members;
}

/**
 * 核心聚合:把一组来源笔记(members)交给模型合成一篇综述文章。
 * 负责拼接来源(带编号、控制总长度)、调用模型、把 [[N]] 引用转成站内链接,
 * 并追加一份确定性的「参考来源」清单。
 * @returns {Promise<{ article: string, included: Array }>}
 */
async function buildDigestArticle(members, { subject = '' } = {}) {
  // Number the sources so the model can cite them inline as [[N]], and so we
  // can append a deterministic, always-correct "参考来源" link list afterwards.
  const included = [];
  let acc = '';
  for (const m of members) {
    const n = included.length + 1;
    const piece = `\n\n### Source [${n}]: ${m.title}${m.date ? ` (${m.date.slice(0, 10)})` : ''}\n${(m.content || '').trim().slice(0, MAX_PER_NOTE_CHARS)}`;
    if (acc.length + piece.length > MAX_DIGEST_CHARS) break;
    acc += piece;
    included.push(m);
  }

  const system =
    'You are a knowledge editor. Synthesize the numbered source notes into one clear, coherent article. ' +
    'Deduplicate ideas and reorganize them by subtopic. Start with an H1 title and use H2 sections. ' +
    'Stay faithful to the notes and never invent unsupported facts. Lists are welcome when they improve clarity. ' +
    MULTI_SOURCE_LANGUAGE_RULE + ' ' +
    'Add [[N]] after claims that use source N; multiple citations such as [[1]][[3]] are allowed. ' +
    'Do not create a sources section because it is appended automatically. Return only Markdown without an outer code fence.';
  const user = `${subject}\nSource notes: ${members.length}; included: ${included.length}.\n${acc}`;

  const text = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.4, timeoutMs: LONG_TIMEOUT_MS },
  );
  let article = stripCodeFence(text);
  if (!article) throw new Error('模型未返回综述内容');

  // Turn inline [[N]] citations into in-app links back to the source note.
  // Invalid indices are left as-is. The frontend intercepts #note= links.
  article = article.replace(/\[\[(\d+)\]\]/g, (m, d) => {
    const src = included[Number(d) - 1];
    return src ? `[[${d}]](${noteLink(src.path)})` : m;
  });

  // Always append an accurate, deterministic source list (links guaranteed).
  if (included.length) {
    const list = included
      .map((m, i) => `${i + 1}. [${m.title}](${noteLink(m.path)})`)
      .join('\n');
    article += `\n\n## ${referenceHeadingForDocuments(included.map((m) => m.content), acc)}\n\n${list}\n`;
  }
  return { article, included };
}

/**
 * 把某分类下的所有笔记聚合成一篇综述文章,存到 digests/<分类>.md(覆盖式)。
 * @returns {Promise<{ path: string, category: string, sourceCount: number }>}
 */
export async function synthesizeCategory(category) {
  if (!isOrganizeConfigured()) {
    throw new Error('AI 聚合未配置:请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  }
  const cat = (category || '').trim();
  if (!cat) throw new Error('category is required');

  const members = await collectCategoryNotes(cat);
  if (!members.length) throw new Error(`分类「${cat}」下没有笔记`);

  const { article, included } = await buildDigestArticle(members, { subject: `Category: ${cat}` });

  const path = digestPathFor(cat);
  const frontmatter = {
    title: isHanDocumentMajority(members.map((m) => m.content), cat)
      ? `「${cat}」综述`
      : `${cat} Digest`,
    digest: true,
    category: cat,
    generatedAt: new Date().toISOString(),
    sourceCount: members.length,
    sources: included.map((m) => m.path),
  };
  const saved = await writeNote(path, article, { frontmatter });
  return { path: saved, category: cat, sourceCount: members.length };
}

/**
 * 把用户手动挑选的任意几篇笔记聚合成一篇综述文章。与分类综述不同:
 * 不绑定任何分类,每次生成一个新文件(digests/<标题>.md,自动去重命名),
 * 因此同一批笔记可以合成多篇不同角度的文章。
 * @param {string[]} paths 选中的笔记路径
 * @param {{ title?: string }} opts 可选标题;留空则由 AI 起题
 * @returns {Promise<{ path: string, sourceCount: number, title: string }>}
 */
export async function synthesizeSelection(paths, { title = '' } = {}) {
  if (!isOrganizeConfigured()) {
    throw new Error('AI 聚合未配置:请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  }
  const list = Array.isArray(paths) ? [...new Set(paths.filter(Boolean))] : [];
  if (list.length < 2) throw new Error('请至少选择 2 篇笔记');

  const members = [];
  const catSet = new Set(); // union of the source notes' categories
  for (const p of list) {
    let note;
    try { note = await readNote(p); } catch { continue; }
    if (isDigest(note) || contentKind(note.data) !== CONTENT_KINDS.NOTE) continue;
    const name = note.path.split('/').pop().replace(/\.md$/, '');
    const date = (note.data.savedAt || note.data.date || '').toString();
    normalizeCategoryList(note.data.categories).forEach((c) => catSet.add(c));
    members.push({
      path: note.path,
      title: (note.data.title || name).toString(),
      date,
      content: note.content,
    });
  }
  if (members.length < 2) throw new Error('有效笔记不足 2 篇');

  const { article, included } = await buildDigestArticle(members, {
    subject: 'Topic: the user selected these notes to synthesize into one article.',
  });

  // Title: caller-provided → AI-suggested from the article → date fallback.
  let finalTitle = (title || '').trim();
  if (!finalTitle) {
    try { finalTitle = await suggestTitle({ content: article }); } catch { /* ignore */ }
  }
  if (!finalTitle) {
    const date = new Date().toISOString().slice(0, 10);
    finalTitle = isHanDocumentMajority(members.map((m) => m.content), article)
      ? `自选综述 · ${date}`
      : `Custom Digest · ${date}`;
  }

  // Inherit the source notes' categories so the synthesis is filed alongside them.
  const categories = [...catSet];
  const path = await nextAvailablePath(digestPathFor(finalTitle));
  const frontmatter = {
    title: finalTitle,
    digest: true,
    custom: true,
    generatedAt: new Date().toISOString(),
    sourceCount: members.length,
    sources: included.map((m) => m.path),
  };
  if (categories.length) frontmatter.categories = categories;
  const saved = await writeNote(path, article, { frontmatter });
  return { path: saved, sourceCount: members.length, title: finalTitle, categories };
}

// In-app link to a note. The SPA intercepts href="#note=<path>" clicks and
// opens the note without a page reload. markdown-it percent-encodes the path;
// the frontend decodes it. We drop the trailing .md for readability.
function noteLink(relPath) {
  return `#note=${(relPath || '').replace(/\.md$/i, '')}`;
}

/** 读取某分类现有综述(若不存在返回 null)。 */
export async function getDigest(category) {
  const path = digestPathFor(category);
  try {
    const abs = resolveNotePath(path);
    const note = await readNote(toRelPath(abs));
    return note;
  } catch {
    return null;
  }
}
