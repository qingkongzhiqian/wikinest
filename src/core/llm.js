// Shared OpenAI-compatible chat client used by classify / organize / synthesize.
// Works with OpenAI, DeepSeek, 通义千问, 或任何兼容 /chat/completions 的服务
// —— 只改环境变量,不改代码。
//
// Env:
//   LLM_BASE_URL   e.g. https://api.deepseek.com/v1  (末尾可带或不带 /)
//   LLM_API_KEY    API key
//   LLM_MODEL      模型名,e.g. deepseek-chat / gpt-4o-mini / qwen-plus
//   LLM_TIMEOUT_MS 单次请求超时,默认 15000(整理/聚合会用更长的超时)

import { createAiUpstreamError } from './ai-errors.js';

const MAX_RETRY_AFTER_SECONDS = 7 * 24 * 60 * 60;
const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
const MAX_SSE_BUFFER_CHARS = 1024 * 1024;
const MAX_STREAM_OUTPUT_CHARS = 1_000_000;

function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  let seconds;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const timestamp = Date.parse(trimmed);
    if (!Number.isFinite(timestamp)) return undefined;
    seconds = Math.max(0, Math.ceil((timestamp - now) / 1000));
  }
  if (!Number.isSafeInteger(seconds) || seconds > MAX_RETRY_AFTER_SECONDS) return undefined;
  return seconds;
}

async function readBoundedBody(body, maxBytes) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (value.byteLength > remaining || total === maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    await reader.cancel().catch(() => {});
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader cleanup must not replace the upstream error.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function upstreamHttpError(response) {
  let providerCode;
  try {
    const body = await readBoundedBody(response.body, MAX_PROVIDER_ERROR_BYTES);
    const parsed = JSON.parse(body);
    const candidate = parsed?.code ?? parsed?.error?.code;
    if (typeof candidate === 'string') providerCode = candidate;
  } catch {
    // Provider bodies are untrusted and intentionally discarded.
  }
  return createAiUpstreamError('http', {
    status: response.status,
    providerCode,
    retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
  });
}

export function llmConfig() {
  return {
    baseUrl: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 15000,
  };
}

function resolvedLlmConfig(override) {
  if (!override || typeof override !== 'object') return llmConfig();
  const baseUrl = typeof override.baseUrl === 'string'
    ? override.baseUrl.trim().replace(/\/+$/, '')
    : '';
  const apiKey = typeof override.apiKey === 'string' ? override.apiKey.trim() : '';
  const model = typeof override.model === 'string' ? override.model.trim() : '';
  if (baseUrl) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('LLM Base URL 无效');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('LLM Base URL 必须使用 HTTP 或 HTTPS');
    }
  }
  return {
    baseUrl,
    apiKey: apiKey.slice(0, 8_000),
    model: model.slice(0, 200),
    timeoutMs: Number(override.timeoutMs) || 15000,
  };
}

export function isLLMConfigured(override) {
  try {
    const c = resolvedLlmConfig(override);
    return Boolean(c.baseUrl && c.apiKey && c.model);
  } catch {
    return false;
  }
}

/**
 * Call the chat completions API and return the assistant message text.
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} [opts]
 * @param {number} [opts.temperature]
 * @param {number} [opts.timeoutMs]  overrides the env default (long tasks want more)
 * @returns {Promise<string>}
 */
export async function chat(messages, { temperature = 0.3, timeoutMs, config } = {}) {
  if (!isLLMConfigured(config)) {
    throw new Error('LLM 未配置:请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  }
  const c = resolvedLlmConfig(config);
  const budget = timeoutMs || c.timeoutMs;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budget);
  let resp;
  try {
    resp = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({
        model: c.model,
        temperature,
        // DashScope/qwen3 推理模型:关掉思考更快;其它服务商会忽略这个未知字段。
        enable_thinking: false,
        messages,
      }),
      signal: ctl.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`LLM 请求超时 (>${budget}ms)`);
    throw new Error(`LLM 请求出错: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`LLM 请求失败 (${resp.status}): ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * Call the streaming chat completions API and yield assistant text deltas.
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} [opts]
 * @param {number} [opts.temperature]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @returns {AsyncGenerator<string>}
 */
export async function* chatStream(messages, {
  temperature = 0.3,
  timeoutMs,
  signal,
} = {}) {
  if (!isLLMConfigured()) {
    throw new Error('LLM 未配置:请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  }
  const c = llmConfig();
  const budget = timeoutMs || c.timeoutMs;
  const ctl = new AbortController();
  let abortOwner;
  const abortForCaller = () => {
    if (abortOwner === undefined) abortOwner = 'caller';
    ctl.abort();
  };
  if (signal?.aborted) abortForCaller();
  else signal?.addEventListener('abort', abortForCaller, { once: true });
  const timer = setTimeout(() => {
    if (abortOwner === undefined) {
      abortOwner = 'timeout';
      ctl.abort();
    }
  }, budget);
  let reader;

  try {
    let resp;
    try {
      resp = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify({
          model: c.model,
          temperature,
          enable_thinking: false,
          messages,
          stream: true,
        }),
        signal: ctl.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        if (abortOwner === 'caller') throw err;
        throw createAiUpstreamError('timeout');
      }
      throw createAiUpstreamError('network');
    }

    if (!resp.ok) {
      throw await upstreamHttpError(resp);
    }

    if (!resp.body) throw createAiUpstreamError('interrupted');
    reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    let completed = false;
    let streamedChars = 0;

    function nextContent(choice) {
      const content = choice?.delta?.content;
      if (typeof content !== 'string') return undefined;
      if (streamedChars + content.length > MAX_STREAM_OUTPUT_CHARS) {
        throw createAiUpstreamError('interrupted');
      }
      streamedChars += content.length;
      return content;
    }

    while (!done) {
      let result;
      try {
        result = await reader.read();
      } catch (err) {
        if (err.name === 'AbortError') {
          if (abortOwner === 'caller') throw err;
          throw createAiUpstreamError('timeout');
        }
        throw createAiUpstreamError('network');
      }
      done = result.done;
      const decoded = decoder.decode(result.value, { stream: !done });
      if (buffer.length + decoded.length > MAX_SSE_BUFFER_CHARS) {
        throw createAiUpstreamError('interrupted');
      }
      buffer += decoded;

      let boundary;
      while ((boundary = buffer.match(/\r?\n\r?\n/))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const payload = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!payload) continue;
        if (payload.trim() === '[DONE]') {
          completed = true;
          break;
        }

        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          // Ignore malformed and non-content events.
          continue;
        }
        const choice = data?.choices?.[0];
        const content = nextContent(choice);
        if (typeof content === 'string') yield content;
        if (choice?.finish_reason != null) {
          completed = true;
          break;
        }
      }
      if (completed) return;
    }

    if (buffer.trim()) {
      const payload = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (payload.trim() === '[DONE]') {
        completed = true;
      } else if (payload) {
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          // A malformed tail cannot prove successful stream completion.
          data = undefined;
        }
        if (data) {
          const choice = data?.choices?.[0];
          const content = nextContent(choice);
          if (typeof content === 'string') yield content;
          if (choice?.finish_reason != null) completed = true;
        }
      }
    }
    if (!completed) throw createAiUpstreamError('interrupted');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortForCaller);
    if (reader) {
      await reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // Reader cleanup must not replace the stream outcome.
      }
    }
  }
}

/** Pull the first JSON object/array out of a possibly-chatty model reply. */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  for (let end = candidate.length; end > start; end--) {
    const ch = candidate[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    try { return JSON.parse(candidate.slice(start, end)); } catch { /* keep trying */ }
  }
  return null;
}

/**
 * Strip a leading/trailing markdown code fence the model sometimes wraps
 * whole-document output in (```markdown … ```), returning the inner text.
 */
export function stripCodeFence(text) {
  const t = (text || '').trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return (m ? m[1] : t).trim();
}
