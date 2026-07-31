import assert from 'node:assert/strict';
import test from 'node:test';

import { toLinkedInMarkdown } from '../extension/core/linkedin-ui.js';

test('renders LinkedIn chat as readable Markdown with embedded attachment URLs', () => {
  const markdown = toLinkedInMarkdown({
    type: 'linkedin-chat',
    exportedAt: '2026-07-31T12:00:00.000Z',
    messages: [{
      sender: 'Person One',
      timestamp: '2026-07-31T11:55:00.000Z',
      text: 'A message body',
      attachments: [
        { type: 'image', url: 'https://media.example.test/image.png', alt: 'Shared image' },
        { type: 'file', url: 'https://media.example.test/document.pdf', alt: 'Document' },
      ],
    }],
  });

  assert.match(markdown, /^# LinkedIn Chat Export/m);
  assert.match(markdown, /^## Person One — /m);
  assert.match(markdown, /^A message body$/m);
  assert.match(markdown, /!\[Shared image\]\(<https:\/\/media\.example\.test\/image\.png>\)/);
  assert.match(markdown, /\[Document\]\(<https:\/\/media\.example\.test\/document\.pdf>\)/);
  assert.doesNotMatch(markdown, /```json/);
});
