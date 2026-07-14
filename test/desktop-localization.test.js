import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { desktopLabels } from '../desktop/preferences.js';

const SETTINGS_HTML = readFileSync(new URL('../desktop/settings.html', import.meta.url), 'utf8');

test('desktop labels follow locale', () => {
  assert.equal(desktopLabels('en').file, 'File');
  assert.equal(desktopLabels('en').openFolder, 'Open Folder…');
  assert.equal(desktopLabels('zh-CN').file, '文件');
  assert.equal(desktopLabels('zh-CN').openFolder, '打开文件夹…');
});

test('standalone settings applies messages returned by preload', () => {
  assert.match(SETTINGS_HTML, /data-i18n="app\.settings"/);
  assert.match(SETTINGS_HTML, /const messages = info\?\.messages/);
  assert.match(SETTINGS_HTML, /querySelectorAll\('\[data-i18n\]'\)/);
});
