import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const background = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

test('LinkedIn collector runs in embedded messaging frames', () => {
  const linkedinScript = manifest.content_scripts.find((entry) =>
    entry.matches?.some((pattern) => pattern.includes('linkedin.com')),
  );

  assert.ok(linkedinScript, 'LinkedIn must have its own content-script entry');
  assert.equal(linkedinScript.all_frames, true);
  assert.deepEqual(linkedinScript.js, ['core/linkedin-ui.classic.js', 'content.js']);
  assert.ok(manifest.permissions.includes('webNavigation'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.equal(manifest.version, '0.4.5');
  assert.match(background, /probed\.coreBootstrapFailures === probed\.initializationErrors/);
  assert.match(background, /files: \['core\/linkedin-ui\.classic\.js', 'content\.js'\]/);
});

test('classic LinkedIn core bootstraps without dynamic module import', () => {
  const source = fs.readFileSync(new URL('../extension/core/linkedin-ui.classic.js', import.meta.url), 'utf8');
  const context = { console };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  assert.equal(typeof context.__PRIVATE_SOCIAL_LINKEDIN_CORE__?.collectLinkedInChatHistory, 'function');
  assert.equal(typeof context.__PRIVATE_SOCIAL_LINKEDIN_CORE__?.toLinkedInMarkdown, 'function');
});
