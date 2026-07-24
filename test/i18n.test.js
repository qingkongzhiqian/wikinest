import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  MESSAGES,
  normalizeLocale,
  createTranslator,
} from '../src/i18n.js';

test('desktop locale defaults to English and accepts supported values', () => {
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocale('zh'), 'zh-CN');
  assert.equal(normalizeLocale('fr'), 'en');
});

test('translation dictionaries have identical non-empty production keys', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['en', 'zh-CN']);
  const productionKeys = (messages) => Object.keys(messages)
    .filter((key) => !key.startsWith('test.'))
    .sort();
  assert.deepEqual(productionKeys(MESSAGES.en), productionKeys(MESSAGES['zh-CN']));
  for (const locale of SUPPORTED_LOCALES) {
    for (const value of Object.values(MESSAGES[locale])) {
      assert.equal(typeof value, 'string');
      assert.ok(value.length > 0);
    }
  }
});

test('translator interpolates parameters and falls back to English', () => {
  const zh = createTranslator('zh-CN');
  assert.equal(zh('notes.count', { count: 3 }), '3 篇笔记');
  const previousWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(zh('test.englishOnly'), 'English fallback');
  } finally {
    console.warn = previousWarn;
  }
  assert.match(warnings[0], /missing translation.*test\.englishOnly/i);
});

test('sync UI has complete bilingual status, warning, and action messages', () => {
  const keys = [
    'sync.title', 'sync.note', 'sync.enabled', 'sync.bucket', 'sync.endpoint',
    'sync.region', 'sync.prefix', 'sync.pathStyle', 'sync.accessKeyId',
    'sync.secretAccessKey', 'sync.password', 'sync.secretSavedPlaceholder',
    'sync.passwordSavedPlaceholder', 'sync.plaintextWarning', 'sync.clearPassword',
    'sync.modeLocked', 'sync.test', 'sync.now', 'sync.testUninitialized',
    'sync.testPlaintext', 'sync.testEncrypted', 'sync.lastUpdated', 'sync.error',
    'sync.partialSaveFailed',
    'sync.state.disabled', 'sync.state.pending', 'sync.state.syncing',
    'sync.state.synced', 'sync.state.error', 'sync.state.stopped',
  ];
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of keys) assert.ok(MESSAGES[locale][key], `${locale}: ${key}`);
  }
});

test('floating AI assistant has complete English and Simplified Chinese messages', () => {
  const keys = [
    'ai.title', 'ai.launcher', 'ai.close', 'ai.threadMenu', 'ai.newChat', 'ai.deleteChat',
    'ai.contextSelection', 'ai.contextDocument', 'ai.contextGeneral', 'ai.noDocument',
    'ai.quick.polish', 'ai.quick.shorten', 'ai.quick.expand', 'ai.quick.fix',
    'ai.suggest.summary', 'ai.suggest.keyPoints', 'ai.suggest.table', 'ai.suggest.neutral',
    'ai.empty', 'ai.prompt', 'ai.send', 'ai.stop', 'ai.error', 'ai.stopped',
    'ai.stale', 'ai.noSelection', 'ai.replace', 'ai.insert', 'ai.copy', 'ai.copied',
    'ai.notConfigured', 'ai.streaming', 'ai.done', 'ai.applied',
  ];
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of keys) assert.ok(MESSAGES[locale][key], `${locale}: ${key}`);
  }

  assert.equal(MESSAGES.en['ai.quick.polish'], 'Polish');
  assert.equal(MESSAGES.en['ai.quick.shorten'], 'Shorten');
  assert.equal(MESSAGES.en['ai.quick.expand'], 'Expand');
  assert.equal(MESSAGES.en['ai.quick.fix'], 'Fix grammar');
  assert.equal(MESSAGES['zh-CN']['ai.quick.polish'], '润色');
  assert.equal(MESSAGES['zh-CN']['ai.quick.shorten'], '缩短');
  assert.equal(MESSAGES['zh-CN']['ai.quick.expand'], '扩写');
  assert.equal(MESSAGES['zh-CN']['ai.quick.fix'], '修正语法');
  assert.equal(MESSAGES.en['ai.newChat'], 'New chat');
  assert.equal(MESSAGES['zh-CN']['ai.newChat'], '新聊天');
  assert.equal(MESSAGES.en['ai.launcher'], 'Open AI assistant');
  assert.equal(MESSAGES['zh-CN']['ai.launcher'], '打开 AI 助手');
  assert.equal(MESSAGES.en['ai.noDocument'], 'No document context');
  assert.equal(MESSAGES['zh-CN']['ai.noDocument'], '无文档上下文');
  assert.equal(MESSAGES.en['ai.notConfigured'], 'Configure LLM settings to enable the AI assistant.');
  assert.equal(MESSAGES['zh-CN']['ai.notConfigured'], '请先配置大模型，再使用 AI 助手。');
});

test('AI error cards have complete bilingual actionable feedback', () => {
  const keys = [
    'ai.error.rateLimited', 'ai.error.authentication', 'ai.error.modelNotFound',
    'ai.error.invalidRequest', 'ai.error.timeout', 'ai.error.network',
    'ai.error.interrupted', 'ai.error.fallback', 'ai.error.requestId',
    'ai.error.retry', 'ai.error.retryIn', 'ai.error.openSettings',
  ];
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of keys) assert.ok(MESSAGES[locale][key], `${locale}: ${key}`);
  }

  assert.match(MESSAGES.en['ai.error.rateLimited'], /too many|rate limit/i);
  assert.match(MESSAGES['zh-CN']['ai.error.rateLimited'], /频繁|限流/);
  assert.match(MESSAGES.en['ai.error.authentication'], /settings/i);
  assert.match(MESSAGES['zh-CN']['ai.error.authentication'], /设置/);
  assert.match(MESSAGES.en['ai.error.modelNotFound'], /model/i);
  assert.match(MESSAGES['zh-CN']['ai.error.modelNotFound'], /模型/);
  assert.match(MESSAGES.en['ai.error.retryIn'], /\{seconds\}/);
  assert.match(MESSAGES['zh-CN']['ai.error.retryIn'], /\{seconds\}/);
  assert.match(MESSAGES.en['ai.error.requestId'], /\{requestId\}/);
  assert.match(MESSAGES['zh-CN']['ai.error.requestId'], /\{requestId\}/);
});
