import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const background = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const content = fs.readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');

test('supports Gmail and Drive with local email export content scripts', () => {
  const matches = manifest.content_scripts.flatMap((entry) => entry.matches ?? []);
  assert.ok(matches.includes('https://mail.google.com/*'));
  assert.ok(matches.includes('https://drive.google.com/*'));
  assert.ok(manifest.version === '0.4.7');
  assert.match(background, /private-email-export/);
  assert.match(content, /private-email-export/);
});

test('email collector exposes Gmail, Drive, Markdown, and ZIP operations', async () => {
  const email = await import('../extension/core/email-ui.js');
  for (const name of ['collectGmailThread', 'collectDriveFile', 'toEmailMarkdown', 'createEmailZip']) {
    assert.equal(typeof email[name], 'function', name);
  }
});
