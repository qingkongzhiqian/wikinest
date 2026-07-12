// Shared OpenAI-compatible chat client used by classify / organize / synthesize.
// Works with OpenAI, DeepSeek, 通义千问, 或任何兼容 /chat/completions 的服务
// —— 只改环境变量,不改代码。
//
// Env:
//   LLM_BASE_URL   e.g. https://api.deepseek.com/v1  (末尾可带或不带 /)
//   LLM_API_KEY    API key
//   LLM_MODEL      模型名,e.g. deepseek-chat / gpt-4o-mini / qwen-plus
//   LLM_TIMEOUT_MS 单次请求超时,默认 15000(整理/聚合会用更长的超时)

export function llmConfig() {
  return {
    baseUrl: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 15000,
  };
}

export function isLLMConfigured() {
  const c = llmConfig();
  return Boolean(c.baseUrl && c.apiKey && c.model);
}

/**
 * Call the chat completions API and return the assistant message text.
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} [opts]
 * @param {number} [opts.temperature]
 * @param {number} [opts.timeoutMs]  overrides the env default (long tasks want more)
 * @returns {Promise<string>}
 */
export async function chat(messages, { temperature = 0.3, timeoutMs } = {}) {
  if (!isLLMConfigured()) {
    throw new Error('LLM 未配置:请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  }
  const c = llmConfig();
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
