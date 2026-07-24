import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

test('production editor bundle does not depend on Node process globals', async () => {
  const outputDir = path.resolve(process.cwd(), 'web-dist/editor');
  const entries = await readdir(outputDir, { withFileTypes: true });
  const javascript = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.js'));
  assert.ok(javascript.length > 0, 'editor build must emit JavaScript');

  for (const entry of javascript) {
    const source = await readFile(path.join(outputDir, entry.name), 'utf8');
    assert.equal(
      /\bprocess\.env\.NODE_ENV\b/.test(source),
      false,
      `${entry.name} must run in a browser without a Node process global`,
    );
  }
});
