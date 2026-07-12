import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/web/server.js';

test('startServer binds to 127.0.0.1 and assigns a free port', async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  const { address, port } = server.address();
  assert.equal(address, '127.0.0.1');
  assert.ok(port > 0, 'a real port should be assigned');
  const res = await fetch(`http://127.0.0.1:${port}/api/tree`);
  assert.equal(res.status, 200);
  await new Promise((r) => server.close(r));
});
