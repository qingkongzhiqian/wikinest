const API_BASE = 'http://127.0.0.1:4321';
const SESSION_KEY = 'pendingClip';
const MODEL_KEY = 'modelConfig';
const CHAT_KEY = 'chatHistory';
const MAX_CHATS = 30;
const $ = (id) => document.getElementById(id);

const ACTIONS = {
  translate: { title: '翻译', key: 'translation' },
  summarize: { title: '摘要', key: 'summary' },
  'key-points': { title: '提取要点', key: 'keyPoints' },
  explain: { title: '解释', key: 'explanation' },
};

let capture = null;
let busy = false;
let outputs = { translation: '', summary: '', keyPoints: '', explanation: '' };
let modelConfig = { baseUrl: '', apiKey: '', model: '' };
let chats = [];
let activeChatId = null;

function hasModelConfig() {
  return Boolean(modelConfig.baseUrl && modelConfig.apiKey && modelConfig.model);
}

function hasQuote() {
  return Boolean(capture?.originalMarkdown?.trim());
}

function currentChat() {
  return chats.find((chat) => chat.id === activeChatId) || null;
}

function makeChat() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

async function persistChats() {
  chats = chats
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MAX_CHATS);
  await chrome.storage.local.set({ [CHAT_KEY]: { activeChatId, chats } });
  renderHistory();
}

function syncControls() {
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.disabled = busy || !hasQuote();
  });
  $('targetLanguage').disabled = busy || !hasQuote();
  $('saveBookmark').disabled = busy || !capture;
  $('save').disabled = busy || !hasQuote();
  $('discard').hidden = !hasQuote();
  $('ask').disabled = busy;
  $('newChat').disabled = busy;
}

function setStatus(message, error = false) {
  $('aiStatus').textContent = message || '';
  $('aiStatus').dataset.error = error ? 'true' : 'false';
}

function sourceMetadata(value) {
  return [value.siteName, value.author, value.publishedAt].filter(Boolean).join(' · ');
}

function renderConversation() {
  const chat = currentChat();
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  $('messageList').replaceChildren();
  for (const message of messages) {
    const item = document.createElement('article');
    item.className = `message ${message.role}`;
    if (message.contextQuote) {
      const context = document.createElement('div');
      context.className = 'message-context';
      const contextLabel = document.createElement('div');
      contextLabel.className = 'message-context-label';
      contextLabel.textContent = message.contextTitle
        ? `来自 ${message.contextTitle}`
        : '来自网页选区';
      const quote = document.createElement('blockquote');
      quote.textContent = message.contextQuote;
      context.append(contextLabel, quote);
      item.append(context);
    }
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = message.content;
    item.append(content);
    $('messageList').append(item);
  }
  const hasMessages = messages.length > 0;
  $('conversation').hidden = !hasMessages;
  $('workspace').hidden = !hasQuote() || hasMessages;
  $('emptyState').hidden = hasMessages || hasQuote();
  if (hasMessages) {
    requestAnimationFrame(() => {
      $('conversation').scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }
}

function renderHistory() {
  $('historyList').replaceChildren();
  if (!chats.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = '还没有历史对话';
    $('historyList').append(empty);
    return;
  }
  for (const chat of chats) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `history-item${chat.id === activeChatId ? ' active' : ''}`;
    const title = document.createElement('strong');
    title.textContent = chat.title || '新对话';
    const time = document.createElement('span');
    time.textContent = new Date(chat.updatedAt).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    button.append(title, time);
    button.addEventListener('click', () => {
      activeChatId = chat.id;
      $('historyPanel').hidden = true;
      renderConversation();
      void persistChats();
    });
    $('historyList').append(button);
  }
}

async function startNewChat() {
  const chat = makeChat();
  chats.unshift(chat);
  activeChatId = chat.id;
  $('userPrompt').value = '';
  $('historyPanel').hidden = true;
  $('modelSettings').hidden = true;
  setStatus('');
  renderConversation();
  await persistChats();
  $('userPrompt').focus();
}

async function appendMessage(role, content, includeContext = false) {
  let chat = currentChat();
  if (!chat) {
    chat = makeChat();
    chats.unshift(chat);
    activeChatId = chat.id;
  }
  const message = { role, content };
  if (includeContext && hasQuote()) {
    message.contextTitle = capture.sourceTitle || capture.siteName || '网页选区';
    message.contextQuote = capture.originalMarkdown.slice(0, 12_000);
  }
  chat.messages.push(message);
  if (role === 'user' && chat.title === '新对话') {
    chat.title = content.replace(/\s+/g, ' ').slice(0, 42);
  }
  chat.updatedAt = new Date().toISOString();
  await persistChats();
  renderConversation();
}

function renderCapture(value) {
  capture = value || null;
  $('workspace').hidden = !hasQuote();
  $('quoteAttachment').hidden = !hasQuote();
  $('userPrompt').placeholder = hasQuote() ? '针对引用内容提问…' : '问任何问题…';
  if (!capture) {
    $('original').value = '';
    $('originalPreview').textContent = '';
    renderConversation();
    syncControls();
    return;
  }

  const original = capture.originalMarkdown || '';
  $('sourceDomain').textContent = capture.siteName || new URL(capture.sourceUrl).hostname;
  $('sourceTitle').textContent = capture.sourceTitle || capture.sourceUrl;
  $('sourceMeta').textContent = sourceMetadata(capture);
  $('sourceLink').href = capture.sourceUrl;
  $('original').value = original;
  $('originalPreview').textContent = original;
  $('charCount').textContent = `${original.length.toLocaleString()} 字`;
  outputs = { translation: '', summary: '', keyPoints: '', explanation: '' };
  setStatus('');
  renderConversation();
  syncControls();
}

function requestSelection() {
  chrome.runtime.sendMessage({ type: 'pull-selection' }).catch(() => {});
}

async function loadPending() {
  const state = await chrome.storage.session.get(SESSION_KEY);
  renderCapture(state[SESSION_KEY]);
}

function fillModelForm() {
  $('modelBaseUrl').value = modelConfig.baseUrl;
  $('modelApiKey').value = modelConfig.apiKey;
  $('modelName').value = modelConfig.model;
}

async function loadModelConfig() {
  const state = await chrome.storage.local.get(MODEL_KEY);
  const saved = state[MODEL_KEY];
  if (saved && typeof saved === 'object') {
    modelConfig = {
      baseUrl: typeof saved.baseUrl === 'string' ? saved.baseUrl : '',
      apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
      model: typeof saved.model === 'string' ? saved.model : '',
    };
  }
  fillModelForm();
}

async function loadChats() {
  const state = await chrome.storage.local.get(CHAT_KEY);
  const saved = state[CHAT_KEY];
  chats = Array.isArray(saved?.chats) ? saved.chats.filter((chat) => (
    chat && typeof chat.id === 'string' && Array.isArray(chat.messages)
  )).slice(0, MAX_CHATS) : [];
  activeChatId = typeof saved?.activeChatId === 'string' ? saved.activeChatId : null;
  if (!currentChat()) {
    const chat = makeChat();
    chats.unshift(chat);
    activeChatId = chat.id;
  }
  renderHistory();
  renderConversation();
}

async function saveModelConfig() {
  const next = {
    baseUrl: $('modelBaseUrl').value.trim().replace(/\/+$/, ''),
    apiKey: $('modelApiKey').value.trim(),
    model: $('modelName').value.trim(),
  };
  if (!next.baseUrl || !next.apiKey || !next.model) {
    $('settingsStatus').textContent = '请填写完整配置';
    return;
  }
  try {
    const parsed = new URL(next.baseUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
  } catch {
    $('settingsStatus').textContent = 'Base URL 无效';
    return;
  }
  modelConfig = next;
  await chrome.storage.local.set({ [MODEL_KEY]: modelConfig });
  $('settingsStatus').textContent = '已保存';
  setTimeout(() => { $('modelSettings').hidden = true; }, 450);
}

async function api(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Wikinest returned ${response.status}`);
  return body;
}

async function runAction(action, button) {
  if (!hasQuote() || busy) return;
  busy = true;
  syncControls();
  const config = ACTIONS[action];
  const question = action === 'translate'
    ? `翻译为${$('targetLanguage').selectedOptions[0].textContent}`
    : config.title;
  setStatus(`${config.title}处理中…`);
  try {
    await appendMessage('user', question, true);
    const result = await api(`/api/clips/${action}`, {
      text: $('original').value,
      targetLanguage: $('targetLanguage').value,
      llm: hasModelConfig() ? modelConfig : undefined,
    });
    outputs[config.key] = result.output || '';
    await appendMessage('assistant', result.output || '');
    setStatus('');
  } catch (error) {
    setStatus(`处理失败：${error.message}`, true);
  } finally {
    busy = false;
    syncControls();
    button?.focus();
  }
}

async function askQuestion() {
  const question = $('userPrompt').value.trim();
  if (busy || !question) return;
  const chat = currentChat();
  const history = Array.isArray(chat?.messages)
    ? chat.messages.map(({ role, content }) => ({ role, content }))
    : [];
  busy = true;
  syncControls();
  setStatus(hasQuote() ? '正在结合引用内容思考…' : '正在思考…');
  try {
    $('userPrompt').value = '';
    await appendMessage('user', question, true);
    const result = await api('/api/clips/ask', {
      text: hasQuote() ? $('original').value : '',
      question,
      history,
      llm: hasModelConfig() ? modelConfig : undefined,
    });
    await appendMessage('assistant', result.output || '');
    setStatus('');
  } catch (error) {
    setStatus(`提问失败：${error.message}`, true);
  } finally {
    busy = false;
    syncControls();
    $('userPrompt').focus();
  }
}

async function clearPending() {
  await chrome.storage.session.remove(SESSION_KEY);
  renderCapture(null);
}

function showComplete(title, detail) {
  renderCapture(null);
  $('conversation').hidden = true;
  $('emptyState').hidden = false;
  $('emptyTitle').textContent = title;
  $('emptyDetail').textContent = detail;
  $('welcomeCard').hidden = true;
  $('welcomeChips').hidden = true;
}

async function saveBookmark() {
  if (!capture || busy) return;
  busy = true;
  syncControls();
  setStatus('正在收藏网址…');
  try {
    const result = await api('/api/bookmarks', {
      url: capture.sourceUrl,
      canonicalUrl: capture.canonicalUrl,
      title: capture.sourceTitle,
      description: capture.description,
      siteName: capture.siteName,
      favicon: capture.favicon,
    });
    await chrome.storage.session.remove(SESSION_KEY);
    showComplete(
      result.duplicate ? '这个网址已经收藏' : '网址已收藏',
      result.duplicate ? '没有创建重复收藏。' : '已放入 Wikinest 的网址收藏。',
    );
  } catch (error) {
    setStatus(`收藏失败：${error.message}`, true);
  } finally {
    busy = false;
    syncControls();
  }
}

async function saveClip() {
  if (!hasQuote() || busy) return;
  busy = true;
  syncControls();
  setStatus('正在保存剪藏…');
  try {
    const result = await api('/api/clips', {
      ...capture,
      originalMarkdown: $('original').value,
      translation: outputs.translation,
      translatedTo: $('targetLanguage').value,
      summary: outputs.summary,
      keyPoints: outputs.keyPoints,
      userNote: '',
    });
    await chrome.storage.session.remove(SESSION_KEY);
    showComplete(
      result.duplicate ? '这条剪藏已经存在' : '网页剪藏已保存',
      result.duplicate ? '没有创建重复内容。' : '已放入 Wikinest 的网页剪藏。',
    );
  } catch (error) {
    setStatus(`保存失败：${error.message}`, true);
  } finally {
    busy = false;
    syncControls();
  }
}

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => runAction(button.dataset.action, button));
});
$('copyOriginal').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('original').value);
    setStatus('引用已复制。');
  } catch {
    setStatus('复制失败，请手动复制。', true);
  }
});
$('discard').addEventListener('click', clearPending);
$('saveBookmark').addEventListener('click', saveBookmark);
$('save').addEventListener('click', saveClip);
$('ask').addEventListener('click', askQuestion);
$('newChat').addEventListener('click', startNewChat);
$('userPrompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void askQuestion();
  }
});
$('historyToggle').addEventListener('click', () => {
  $('modelSettings').hidden = true;
  $('historyPanel').hidden = !$('historyPanel').hidden;
  renderHistory();
});
$('historyClose').addEventListener('click', () => { $('historyPanel').hidden = true; });
$('settingsToggle').addEventListener('click', () => {
  $('historyPanel').hidden = true;
  $('settingsStatus').textContent = '';
  $('modelSettings').hidden = !$('modelSettings').hidden;
});
$('settingsClose').addEventListener('click', () => { $('modelSettings').hidden = true; });
$('settingsSave').addEventListener('click', saveModelConfig);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'clip-ready') void loadPending();
});

// The broadcast above can be missed while the panel is still booting, so the
// stored selection stays the source of truth for what the quote box shows.
chrome.storage.session.onChanged.addListener((changes) => {
  if (SESSION_KEY in changes) renderCapture(changes[SESSION_KEY].newValue);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  void loadPending();
  requestSelection();
});

void Promise.all([loadModelConfig(), loadChats(), loadPending()]).then(() => {
  syncControls();
  renderConversation();
  requestSelection();
});
