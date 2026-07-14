import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, isRagConfigured, isAskConfigured } from '../src/core/rag.js';

test('ask configuration requires both embeddings and a chat model', () => {
  const keys = ['EMBED_BASE_URL', 'EMBED_API_KEY', 'EMBED_MODEL', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.EMBED_BASE_URL = 'https://embeddings.example.test/v1';
    process.env.EMBED_API_KEY = 'embed-key';
    process.env.EMBED_MODEL = 'embed-model';
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    assert.equal(isRagConfigured(), true);
    assert.equal(isAskConfigured(), false);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('chunkText returns nothing for empty / whitespace input', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
  assert.deepEqual(chunkText(null), []);
});

test('chunkText merges short paragraphs into one chunk', () => {
  const chunks = chunkText('para one\n\npara two');
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /para one/);
  assert.match(chunks[0], /para two/);
});

test('chunkText hard-splits a paragraph longer than the chunk size', () => {
  const long = 'x'.repeat(1500); // > 700 chars
  const chunks = chunkText(long);
  assert.equal(chunks.length, 3); // 700 + 700 + 100
  assert.equal(chunks[0].length, 700);
  assert.equal(chunks[2].length, 100);
});

test('chunkText caps the number of chunks per note', () => {
  // 60 paragraphs of 800 chars each → 2 chunks each = 120, capped to 50.
  const content = Array.from({ length: 60 }, () => 'y'.repeat(800)).join('\n\n');
  assert.equal(chunkText(content).length, 50);
});
