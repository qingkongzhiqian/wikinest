import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SINGLE_SOURCE_LANGUAGE_RULE,
  MULTI_SOURCE_LANGUAGE_RULE,
  QA_LANGUAGE_RULE,
  referenceHeadingFor,
  referenceHeadingForDocuments,
  noResultsMessageFor,
  noModelOutputMessageForDocuments,
} from '../src/core/prompts.js';

test('AI language rules are English and follow source documents', () => {
  assert.match(SINGLE_SOURCE_LANGUAGE_RULE, /same language as the source document/i);
  assert.match(MULTI_SOURCE_LANGUAGE_RULE, /dominant language/i);
  assert.match(QA_LANGUAGE_RULE, /retrieved sources/i);
  for (const value of [
    SINGLE_SOURCE_LANGUAGE_RULE,
    MULTI_SOURCE_LANGUAGE_RULE,
    QA_LANGUAGE_RULE,
  ]) {
    assert.doesNotMatch(value, /[\u4e00-\u9fff]/);
  }
});

test('deterministic answer sections follow the content language', () => {
  assert.equal(referenceHeadingFor('这是一篇中文笔记，记录产品设计。'), '参考来源');
  assert.equal(referenceHeadingFor('This is an English product design note.'), 'Sources');
  assert.match(noResultsMessageFor('我记录过哪些内容？'), /知识库/);
  assert.match(noResultsMessageFor('What did I write about?'), /knowledge base/i);
});

test('multi-document language uses document majority rather than character volume', () => {
  const documents = [
    'A very long English document '.repeat(100),
    '中文笔记一',
    '中文笔记二',
  ];
  assert.equal(referenceHeadingForDocuments(documents), '参考来源');
  assert.match(noModelOutputMessageForDocuments(['English source']), /model returned no content/i);
});
