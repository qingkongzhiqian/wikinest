import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

async function collectTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTests(target);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [target] : [];
  }));
  return files.flat();
}

const tests = (await collectTests(path.resolve('test'))).sort();
if (!tests.length) throw new Error('No Node test files found');

const child = spawn(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Node test runner terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
