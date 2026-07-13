// OpenAI-compatible embeddings client, used by the RAG (semantic search + ask).
// Defaults to reusing the chat LLM's base URL / API key so DashScope, OpenAI,
// etc. work out of the box; override with EMBED_* only if embeddings live
// on a different endpoint or model.
//
// Env:
//   EMBED_BASE_URL   default: LLM_BASE_URL
//   EMBED_API_KEY    default: LLM_API_KEY
//   EMBED_MODEL      default: text-embedding-v4 (DashScope 通义 embedding)
//   EMBED_TIMEOUT_MS default: 20000
//   EMBED_BATCH      default: 10 (texts per request)

export function embedConfig() {
  return {
    baseUrl: (process.env.EMBED_BASE_URL || process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.EMBED_API_KEY || process.env.LLM_API_KEY || '',
    model: process.env.EMBED_MODEL || 'text-embedding-v4',
    timeoutMs: Number(process.env.EMBED_TIMEOUT_MS) || 20000,
    batch: Math.max(1, Number(process.env.EMBED_BATCH) || 10),
  };
}

export function isEmbedConfigured() {
  const c = embedConfig();
  return Boolean(c.baseUrl && c.apiKey && c.model);
}

// L2-normalize a vector in place so similarity is a plain dot product later.
function normalize(vec) {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

async function embedBatch(texts, c) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), c.timeoutMs);
  let resp;
  try {
    resp = await fetch(`${c.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({ model: c.model, input: texts }),
      signal: ctl.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Embedding 请求超时 (>${c.timeoutMs}ms)`);
    throw new Error(`Embedding 请求出错: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Embedding 请求失败 (${resp.status}): ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  const rows = (data?.data || [])
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => normalize(d.embedding || []));
  if (rows.length !== texts.length) {
    throw new Error(`Embedding 数量不匹配: 期望 ${texts.length}, 得到 ${rows.length}`);
  }
  return rows;
}

/**
 * Embed an array of texts, returned as L2-normalized vectors (same order).
 * Batches requests to stay within provider input limits.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts) {
  if (!isEmbedConfigured()) {
    throw new Error('Embedding 未配置:请设置 EMBED_* 或复用 LLM_BASE_URL / LLM_API_KEY');
  }
  const list = (texts || []).map((t) => (t || '').toString().slice(0, 4000) || ' ');
  if (!list.length) return [];
  const c = embedConfig();
  const out = [];
  for (let i = 0; i < list.length; i += c.batch) {
    const rows = await embedBatch(list.slice(i, i + c.batch), c);
    out.push(...rows);
  }
  return out;
}

/** Embed a single query string → one normalized vector. */
export async function embedOne(text) {
  const [v] = await embedTexts([text]);
  return v;
}

/** Dot product of two equal-length vectors (== cosine for normalized inputs). */
export function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
