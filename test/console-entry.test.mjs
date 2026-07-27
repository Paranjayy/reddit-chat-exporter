import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('console source restricts execution to a Reddit chat room and has no network API', async () => {
  const source = await readFile(new URL('../src/console/entry.js', import.meta.url), 'utf8');
  assert.match(source, /reddit\\\.com/);
  assert.match(source, /\/chat\\\/room/);
  assert.match(source, /createPrivateExport/);
  assert.equal((source.match(/throwIfConsoleExportAborted\(controller\.signal\)/g) ?? []).length, 3);
  assert.match(source, /The JSON file may already be saved; remaining downloads were stopped/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest|navigator\.sendBeacon|WebSocket/);
});
