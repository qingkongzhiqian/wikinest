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
