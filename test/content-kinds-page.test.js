import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../src/web/page.js';

const EN_HTML = renderPage('en');
const ZH_HTML = renderPage('zh-CN');

test('sidebar exposes bookmarks and web clips as independent collections', () => {
  for (const html of [EN_HTML, ZH_HTML]) {
    assert.match(html, /data-side="bookmarks"/);
    assert.match(html, /data-side="clips"/);
    assert.match(html, /const COLLECTION_BOOKMARKS = 'bookmark'/);
    assert.match(html, /const COLLECTION_CLIPS = 'web_clip'/);
    assert.match(html, /itemKind\(i\) === COLLECTION_BOOKMARKS/);
    assert.match(html, /itemKind\(i\) === COLLECTION_CLIPS/);
  }
  assert.match(EN_HTML, />Bookmarks</);
  assert.match(EN_HTML, />Web clips</);
  assert.match(ZH_HTML, />网址收藏</);
  assert.match(ZH_HTML, />网页剪藏</);
});

test('categories and synthesis remain restricted to knowledge notes', () => {
  assert.match(
    EN_HTML,
    /function isNote\(i\)\s*\{\s*return itemKind\(i\) === COLLECTION_NOTES/,
  );
  assert.match(
    EN_HTML,
    /renderCats\(\(note\.data && note\.data\.categories\) \|\| \[\], kind === COLLECTION_NOTES\)/,
  );
  assert.match(
    EN_HTML,
    /select\.style\.display = organizeEnabled && collectionMode === COLLECTION_NOTES/,
  );
});

test('content collection script remains valid JavaScript', () => {
  const scripts = [...EN_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const [, source] of scripts) {
    assert.doesNotThrow(() => new Function(source));
  }
});
