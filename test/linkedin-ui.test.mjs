import assert from 'node:assert/strict';
import test from 'node:test';

import { collectLinkedInChat, toLinkedInMarkdown } from '../extension/core/linkedin-ui.js';

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

test('captures a rendered LinkedIn GIF URL as an embeddable image attachment', () => {
  const previousLocation = globalThis.location;
  globalThis.location = { href: 'https://www.linkedin.com/messaging/' };
  const image = {
    tagName: 'IMG', currentSrc: 'https://media.example.test/animated.gif', width: 200, height: 120,
    getAttribute(name) { return name === 'alt' ? 'Animated reply' : null; },
    getBoundingClientRect() { return { width: 200, height: 120 }; },
    closest(selector) { return selector.includes('__gif') ? {} : null; },
  };
  const attachment = { currentSrc: '', getAttribute() { return null; }, querySelectorAll() { return [image]; }, closest() { return null; } };
  const body = { innerText: 'Message with GIF' };
  const item = {
    innerText: 'Message with GIF', parentElement: null,
    getAttribute(name) { return name === 'data-event-urn' ? 'local-test-event' : null; },
    querySelector(selector) { return selector.includes('message-bubble') ? body : null; },
    querySelectorAll(selector) {
      if (selector.includes('__attachment-item')) return [attachment];
      if (selector === 'img, video, source') return [image];
      return [];
    },
  };
  const root = { querySelectorAll(selector) { return selector === '.msg-s-event-listitem' || selector === '[data-event-urn]' ? [item] : []; } };

  try {
    const data = collectLinkedInChat(root);
    assert.deepEqual(data.messages[0].attachments, [{ type: 'image', url: 'https://media.example.test/animated.gif', alt: 'Animated reply' }]);
  } finally {
    globalThis.location = previousLocation;
  }
});
