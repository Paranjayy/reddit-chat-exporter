import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'src/shared/reddit-ui.js',
  'src/shared/exporter.js',
  'src/console/entry.js',
];

const sources = await Promise.all(files.map(async (file) => {
  const source = await readFile(resolve(root, file), 'utf8');
  // The shared modules have no imports. Removing their export markers lets
  // this standalone IIFE run directly in a browser console.
  return `// ${file}\n${source.replace(/^export\s+/gm, '')}`;
}));
const output = `/* Private Reddit Chat Exporter — local DOM only; generated file. */\n(() => {\n'use strict';\n${sources.join('\n\n')}\n})();\n`;
const target = resolve(root, 'dist/reddit-chat-exporter.console.js');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, output, 'utf8');
