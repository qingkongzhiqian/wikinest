import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/web/server.js';

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

before(() => {
  console.log = () => {};
  console.warn = () => {};
});

after(() => {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
});

test('startServer binds to 127.0.0.1 and assigns a free port', async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    const { address, port } = server.address();
    assert.equal(address, '127.0.0.1');
    assert.ok(port > 0, 'a real port should be assigned');
    const res = await fetch(`http://127.0.0.1:${port}/api/tree`);
    assert.equal(res.status, 200);
    const icon = await fetch(`http://127.0.0.1:${port}/assets/icon.png`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type') || '', /^image\/png/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('server renders the desktop locale from the environment', async () => {
  const previous = process.env.WIKINEST_LOCALE;
  process.env.WIKINEST_LOCALE = 'en';
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), />All notes</);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.WIKINEST_LOCALE;
    else process.env.WIKINEST_LOCALE = previous;
  }
});

import { bootBackend } from '../desktop/boot.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

async function reserveFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('bootBackend uses the given vault dir and serves on 127.0.0.1', async () => {
  const vault = await mkdtemp(path.join(tmpdir(), 'wiki-vault-'));
  const { server, port } = await bootBackend({ vaultDir: vault });
  assert.ok(port > 0);
  const res = await fetch(`http://127.0.0.1:${port}/api/tree`);
  assert.equal(res.status, 200);
  await new Promise((r) => server.close(r));
  await rm(vault, { recursive: true, force: true });
});

test('bootBackend honors an explicit stable desktop port', async () => {
  const vault = await mkdtemp(path.join(tmpdir(), 'wiki-vault-'));
  const expectedPort = await reserveFreePort();
  const { server, port } = await bootBackend({ vaultDir: vault, port: expectedPort });
  try {
    assert.equal(port, expectedPort);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(vault, { recursive: true, force: true });
  }
});
