// Retrieval-augmented "ask your wiki": build a persisted vector index over all
// notes, retrieve the most relevant chunks for a question, and let the chat LLM
// answer grounded in them — with citations that link back to the source notes.
//
// The index is a plain JSON file under content/.index/ (hidden, so it never
// shows up as a note). Brute-force cosine over a few thousand chunks in memory
// is plenty fast for a personal wiki; no vector DB needed.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getAllNotes, CONTENT_DIR } from './store.js';
import { isDigest } from './organize.js';
import {
  embedTexts, embedOne, dot, isEmbedConfigured, embedConfig,
} from './embed.js';
import { chat, stripCodeFence } from './llm.js';

const INDEX_DIR = path.join(CONTENT_DIR, '.index');
const INDEX_FILE = path.join(INDEX_DIR, 'embeddings.json');

const CHUNK_CHARS = 700;   // target characters per chunk
const MAX_CHUNKS_PER_NOTE = 50;
const LONG_TIMEOUT_MS = Number(process.env.LLM_LONG_TIMEOUT_MS) || 90_000;

export function isRagConfigured() {
  return isEmbedConfigured();
}

// Split a note body into reasonably-sized chunks on paragraph boundaries.
function chunkText(content) {
  const paras = (content || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if (p.length > CHUNK_CHARS) {
      if (buf) { chunks.push(buf); buf = ''; }
      for (let i = 0; i < p.length; i += CHUNK_CHARS) chunks.push(p.slice(i, i + CHUNK_CHARS));
      continue;
    }
    if (buf && buf.length + p.length + 2 > CHUNK_CHARS) { chunks.push(buf); buf = p; }
    else buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) chunks.push(buf);
  return chunks.slice(0, MAX_CHUNKS_PER_NOTE);
}

// ---- index persistence (in-memory cache backed by a JSON file) ----
let _index = null;      // { model, notes: { [path]: { mtimeMs, title, chunks:[{text,vec}] } } }
let _syncing = null;    // in-flight sync promise (dedupe concurrent asks)

async function loadIndex() {
  if (_index) return _index;
  try {
    const raw = await fs.readFile(INDEX_FILE, 'utf8');
    _index = JSON.parse(raw);
  } catch {
    _index = { model: '', notes: {} };
  }
  if (!_index.notes) _index.notes = {};
  return _index;
}

async function saveIndex() {
  await fs.mkdir(INDEX_DIR, { recursive: true });
  await fs.writeFile(INDEX_FILE, JSON.stringify(_index));
}

/**
 * Bring the index up to date with the notes on disk: (re)embed new/changed
 * notes, drop deleted ones, and rebuild entirely if the embedding model changed.
 * Concurrent callers share one in-flight sync.
 * @returns {Promise<{ notes:number, chunks:number, embedded:number }>}
 */
export async function syncIndex() {
  if (_syncing) return _syncing;
  _syncing = (async () => {
    if (!isEmbedConfigured()) throw new Error('Embedding 未配置');
    const idx = await loadIndex();
    const model = embedConfig().model;
    if (idx.model !== model) { idx.model = model; idx.notes = {}; } // model change → rebuild

    const notes = (await getAllNotes()).filter((n) => !isDigest(n));
    const alive = new Set(notes.map((n) => n.path));

    // Prune deleted notes.
    for (const p of Object.keys(idx.notes)) {
      if (!alive.has(p)) delete idx.notes[p];
    }

    // Collect chunks needing embedding across all changed notes.
    const pending = []; // { path, title, texts:[], embedText:[] }
    for (const n of notes) {
      const existing = idx.notes[n.path];
      if (existing && existing.mtimeMs === n.mtimeMs) continue; // unchanged
      const name = n.path.split('/').pop().replace(/\.md$/, '');
      const title = (n.data.title || name).toString();
      const texts = chunkText(n.content);
      if (!texts.length) { idx.notes[n.path] = { mtimeMs: n.mtimeMs, title, chunks: [] }; continue; }
      pending.push({
        path: n.path,
        title,
        mtimeMs: n.mtimeMs,
        texts,
        embedText: texts.map((t) => `${title}\n${t}`),
      });
    }

    let embedded = 0;
    if (pending.length) {
      const flat = [];
      for (const pnd of pending) for (const t of pnd.embedText) flat.push(t);
      const vecs = await embedTexts(flat);
      embedded = vecs.length;
      let cursor = 0;
      for (const pnd of pending) {
        const chunks = pnd.texts.map((text, i) => ({ text, vec: vecs[cursor + i] }));
        cursor += pnd.texts.length;
        idx.notes[pnd.path] = { mtimeMs: pnd.mtimeMs, title: pnd.title, chunks };
      }
    }

    if (pending.length || idx.model !== model) await saveIndex();
    else await saveIndex(); // also persist pruning of deleted notes

    let chunkCount = 0;
    for (const p of Object.keys(idx.notes)) chunkCount += (idx.notes[p].chunks || []).length;
    return { notes: Object.keys(idx.notes).length, chunks: chunkCount, embedded };
  })();
  try { return await _syncing; }
  finally { _syncing = null; }
}

/** Force a full rebuild of the index. */
export async function rebuildIndex() {
  await loadIndex();
  _index.notes = {};
  _index.model = '';
  await saveIndex();
  return syncIndex();
}

/**
 * Semantic search: return the top-k most similar chunks to the query.
 * @returns {Promise<Array<{ path, title, text, score }>>}
 */
export async function semanticSearch(query, k = 6) {
  if (!(query || '').trim()) return [];
  await syncIndex();
  const qvec = await embedOne(query);
  const scored = [];
  for (const [p, entry] of Object.entries(_index.notes)) {
    for (const ch of entry.chunks || []) {
      if (!ch.vec) continue;
      scored.push({ path: p, title: entry.title, text: ch.text, score: dot(qvec, ch.vec) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// In-app link to a note (the SPA intercepts href="#note=<path>" clicks).
function noteLink(relPath) {
  return `#note=${(relPath || '').replace(/\.md$/i, '')}`;
}

/**
 * Answer a natural-language question grounded in the wiki's notes.
 * @returns {Promise<{ answer:string, sources:Array<{path,title}>, hitCount:number }>}
 */
export async function askWiki(question, { k = 6 } = {}) {
  if (!isEmbedConfigured()) throw new Error('语义问答未配置:请设置 EMBED_* 或复用 LLM 配置');
  const q = (question || '').trim();
  if (!q) throw new Error('question is required');

  const hits = await semanticSearch(q, k);
  if (!hits.length) {
    return { answer: '知识库里暂时没有找到相关内容。换个说法,或先多记录一些笔记再试。', sources: [], hitCount: 0 };
  }

  const context = hits
    .map((h, i) => `【${i + 1}】《${h.title}》\n${h.text}`)
    .join('\n\n');

  const system =
    '你是用户私人知识库的问答助手。只依据下面提供的「资料片段」回答问题,' +
    '严禁编造资料中没有的信息;若资料不足以回答,就如实说明「知识库里没有相关内容」。' +
    '用中文,简洁、有条理地回答。' +
    '在引用了某段资料的句子末尾,用 [[N]] 标注片段编号(N 是【】里的数字,可多个如 [[1]][[3]]),' +
    '不要自己写「参考来源」清单,清单会自动生成。直接输出回答,不要用 ``` 包裹。';
  const user = `问题:${q}\n\n资料片段:\n${context}`;

  const text = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.3, timeoutMs: LONG_TIMEOUT_MS },
  );
  let answer = stripCodeFence(text) || '（模型没有返回内容）';

  // Map [[N]] citations to in-app links back to the cited chunk's note.
  answer = answer.replace(/\[\[(\d+)\]\]/g, (m, d) => {
    const src = hits[Number(d) - 1];
    return src ? `[[${d}]](${noteLink(src.path)})` : m;
  });

  // Deterministic, deduped source list.
  const seen = new Set();
  const sources = [];
  for (const h of hits) {
    if (seen.has(h.path)) continue;
    seen.add(h.path);
    sources.push({ path: h.path, title: h.title });
  }
  const list = sources.map((s, i) => `${i + 1}. [${s.title}](${noteLink(s.path)})`).join('\n');
  answer += `\n\n## 参考来源\n\n${list}\n`;

  return { answer, sources, hitCount: hits.length };
}
