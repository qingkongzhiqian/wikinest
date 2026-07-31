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

test('Docker image builds and copies the production editor bundle', async () => {
  const dockerfile = await readFile(path.resolve(process.cwd(), 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /RUN npm run editor:build/);
  assert.match(dockerfile, /COPY --from=editor-build \/app\/web-dist \.\/web-dist/);
});

test('every Electron packaging command builds fresh editor assets', async () => {
  const pkg = JSON.parse(await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'));
  for (const name of ['dist', 'dist:dir', 'dist:mac', 'dist:win', 'dist:linux']) {
    assert.match(pkg.scripts[name], /^npm run editor:build && electron-builder/);
  }
});
