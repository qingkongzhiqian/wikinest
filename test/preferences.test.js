import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readLocale, writeLocale, syncLocaleToEnv } from '../desktop/preferences.js';

const MAIN_SOURCE = readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
const PRELOAD_SOURCE = readFileSync(new URL('../desktop/settings-preload.cjs', import.meta.url), 'utf8');

function fakeStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
  };
}

test('locale defaults to English and persists supported choices', () => {
  const store = fakeStore();
  assert.equal(readLocale(store), 'en');
  assert.equal(writeLocale(store, 'zh-CN'), 'zh-CN');
  assert.equal(readLocale(store), 'zh-CN');
  assert.equal(writeLocale(store, 'fr'), 'en');
  assert.equal(readLocale(store), 'en');
});

test('locale sync updates the server rendering environment', () => {
  const previous = process.env.WIKINEST_LOCALE;
  try {
    syncLocaleToEnv('zh-CN');
    assert.equal(process.env.WIKINEST_LOCALE, 'zh-CN');
    syncLocaleToEnv('invalid');
    assert.equal(process.env.WIKINEST_LOCALE, 'en');
  } finally {
    if (previous === undefined) delete process.env.WIKINEST_LOCALE;
    else process.env.WIKINEST_LOCALE = previous;
  }
});

test('settings IPC returns, persists, and hot-applies locale', () => {
  assert.match(MAIN_SOURCE, /locale:\s*readLocale\(store\)/);
  assert.match(MAIN_SOURCE, /writeLocale\(store,\s*data\?\.locale\s*\?\?\s*previousLocale\)/);
  assert.match(MAIN_SOURCE, /syncLocaleToEnv\(locale\)/);
  assert.match(MAIN_SOURCE, /if \(localeChanged\) buildMenu\(\)/);
  assert.ok(
    MAIN_SOURCE.indexOf('writeSettings(store, data)') <
      MAIN_SOURCE.indexOf('writeLocale(store, data?.locale ?? previousLocale)'),
    'provider settings should persist before locale changes',
  );
  assert.match(PRELOAD_SOURCE, /on\('settings-updated',\s*\(_event,\s*payload\)\s*=>\s*cb\(payload\)\)/);
});
