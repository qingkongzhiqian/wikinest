import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCategories } from '../src/core/classify.js';

test('normalizeCategories accepts a plain string array', () => {
  assert.deepEqual(normalizeCategories(['技术', '生活']), ['技术', '生活']);
});

test('normalizeCategories unwraps { categories: [...] }', () => {
  assert.deepEqual(normalizeCategories({ categories: ['读书笔记'] }), ['读书笔记']);
});

test('normalizeCategories accepts a bare string', () => {
  assert.deepEqual(normalizeCategories('随笔'), ['随笔']);
});

test('normalizeCategories handles arrays of { name } objects', () => {
  assert.deepEqual(normalizeCategories([{ name: '技术' }, { name: '生活' }]), ['技术', '生活']);
});

test('normalizeCategories trims, dedupes, and drops empties', () => {
  assert.deepEqual(normalizeCategories([' 技术 ', '技术', '']), ['技术']);
});

test('normalizeCategories caps at 3 categories', () => {
  assert.deepEqual(normalizeCategories(['a', 'b', 'c', 'd', 'e']), ['a', 'b', 'c']);
});

test('normalizeCategories returns [] for junk input', () => {
  assert.deepEqual(normalizeCategories(null), []);
  assert.deepEqual(normalizeCategories(123), []);
  assert.deepEqual(normalizeCategories([null, 1, {}]), []);
});
