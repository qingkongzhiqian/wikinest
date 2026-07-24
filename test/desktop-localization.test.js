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

test('standalone settings includes localized vault sync controls and behavior', () => {
  assert.match(SETTINGS_HTML, /<fieldset[^>]*id="syncSettings"/);
  assert.match(SETTINGS_HTML, /data-i18n="sync\.title"/);
  for (const id of [
    'SYNC_ENABLED', 'SYNC_BUCKET', 'SYNC_ENDPOINT', 'SYNC_REGION', 'SYNC_PREFIX',
    'SYNC_FORCE_PATH_STYLE', 'SYNC_ACCESS_KEY_ID', 'SYNC_SECRET_ACCESS_KEY',
    'SYNC_PASSWORD', 'SYNC_CLEAR_PASSWORD',
  ]) {
    assert.match(SETTINGS_HTML, new RegExp(`id="${id}"`));
  }
  assert.match(SETTINGS_HTML, /id="syncPlaintextWarning"[^>]*role="alert"/);
  assert.match(SETTINGS_HTML, /id="syncTest"[^>]*type="button"/);
  assert.match(SETTINGS_HTML, /id="syncNow"[^>]*type="button"/);
  assert.match(SETTINGS_HTML, /window\.wikiSettings\.syncGet\(\)/);
  assert.match(SETTINGS_HTML, /window\.wikiSettings\.syncSave\(/);
  assert.match(SETTINGS_HTML, /window\.wikiSettings\.syncTest\(/);
  assert.match(SETTINGS_HTML, /window\.wikiSettings\.syncNow\(\)/);
  assert.match(SETTINGS_HTML, /onSyncStatus\(handleSyncStatus\)/);
  assert.match(SETTINGS_HTML, /hasSecretAccessKey[\s\S]*sync\.secretSavedPlaceholder/);
  assert.match(SETTINGS_HTML, /hasPassword[\s\S]*sync\.passwordSavedPlaceholder/);
});

test('standalone sync settings handle partial saves and password mode safely', () => {
  assert.match(SETTINGS_HTML, /let settingsSaved = false/);
  assert.match(SETTINGS_HTML, /settingsSaved\s*\? tr\('sync\.partialSaveFailed'/);
  assert.match(SETTINGS_HTML, /let syncSavedEnabled = false/);
  assert.match(SETTINGS_HTML, /getElementById\('syncNow'\)\.disabled = !syncSavedEnabled/);
  assert.match(SETTINGS_HTML, /SYNC_CLEAR_PASSWORD[\s\S]*SYNC_PASSWORD[\s\S]*disabled/);
  assert.match(SETTINGS_HTML, /SYNC_PASSWORD[\s\S]*SYNC_CLEAR_PASSWORD[\s\S]*checked = false/);
  assert.match(SETTINGS_HTML, /syncPlaintextWarning'\)\.hidden = !enabled \|\| passwordWillExist/);
  assert.doesNotMatch(SETTINGS_HTML, /new Date\(\)\.toISOString\(\)/);
});
