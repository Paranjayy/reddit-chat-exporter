import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const background = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

test('LinkedIn collector runs in embedded messaging frames', () => {
  const linkedinScript = manifest.content_scripts.find((entry) =>
    entry.matches?.some((pattern) => pattern.includes('linkedin.com')),
  );

  assert.ok(linkedinScript, 'LinkedIn must have its own content-script entry');
  assert.equal(linkedinScript.all_frames, true);
  assert.ok(manifest.permissions.includes('webNavigation'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.equal(manifest.version, '0.4.4');
  assert.match(background, /if \(!probed\.responses\)/);
  assert.match(background, /chrome\.scripting\.executeScript/);
});
