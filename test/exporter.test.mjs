import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPrivateExport,
  createDownloadFilename,
  createLocalParticipantPreview,
  deriveExportStats,
  removeExactDuplicates,
  toCanonicalJson,
  toMarkdown,
} from '../src/shared/exporter.js';

test('removes only exact duplicates at the same thread level', () => {
  const backup = createPrivateExport({ messages: [
    { sender: 'a', timestamp: '2026-01-01T00:00:00Z', text: 'same' },
    { sender: 'a', timestamp: '2026-01-01T00:00:00Z', text: 'same' },
    { sender: 'a', timestamp: '2026-01-01T00:00:01Z', text: 'same' },
  ] });
  const result = removeExactDuplicates(backup);
  assert.equal(result.removed, 1);
  assert.equal(result.exportData.messages.length, 2);
});

const source = {
  roomId: 't2_secret-room',
  title: 'Alex and Sam',
  messages: [
    {
      id: 'event-987',
      sender: 'u/alex_private',
      timestamp: '2026-07-27T14:30:00.000Z',
      text: 'hello',
      profileUrl: 'https://reddit.com/user/alex_private',
      sourceUrl: 'https://reddit.com/chat/room/t2_secret-room',
      replies: [
        {
          id: 'event-988',
          sender: 'sam-actual-name',
          timestamp: '2026-07-27T14:31:00.000Z',
          text: 'hi back',
          sourceUrl: 'https://reddit.com/chat/room/t2_secret-room?event=event-988',
        },
      ],
    },
  ],
};

test('creates a nested private export with deterministic neutral aliases and local IDs', () => {
  const result = createPrivateExport(source, { exportedAt: '2026-07-27T15:00:00.000Z' });

  assert.deepEqual(result.participants, [
    { id: 'person-a', label: 'Person A' },
    { id: 'person-b', label: 'Person B' },
  ]);
  assert.equal(result.messages[0].id, 'message-0001');
  assert.equal(result.messages[0].authorId, 'person-b');
  assert.equal(result.messages[0].replies[0].id, 'message-0002');
  assert.equal(result.messages[0].replies[0].authorId, 'person-a');
  assert.equal(result.title, 'Private chat export');
  assert.match(result.exportedAt, /^2026-07-27T20:30:00\.000\+05:30$/);
});

test('preserves an explicit local timestamp offset and uses Unknown sender for unreliable tokens', () => {
  const result = createPrivateExport({ messages: [
    { sender: 'GIF', timestamp: '2026-07-27T22:47:20+05:30', text: 'media' },
  ] }, { exportedAt: '2026-07-27T23:00:00+05:30' });
  assert.equal(result.exportedAt, '2026-07-27T23:00:00+05:30');
  assert.equal(result.messages[0].timestamp, '2026-07-27T22:47:20+05:30');
  assert.deepEqual(result.participants, [{ id: 'person-unknown', label: 'Unknown sender' }]);
});

test('keeps an Unknown sender participant alongside recognised participants', () => {
  const result = createPrivateExport({ messages: [
    { sender: 'visible-handle', text: 'named' },
    { sender: 'GIF', text: 'media' },
  ] });
  assert.deepEqual(result.participants, [
    { id: 'person-a', label: 'Person A' },
    { id: 'person-unknown', label: 'Unknown sender' },
  ]);
  assert.equal(result.messages[1].authorId, 'person-unknown');
  assert.match(toMarkdown(result), /## Unknown sender — Unknown time/);
});

test('offers a raw handle only in local preview, never in an export', () => {
  const messages = [{ sender: 'visible-handle', text: 'hello' }];
  assert.deepEqual(createLocalParticipantPreview(messages), [{ id: 'person-a', handle: 'visible-handle', fallbackLabel: 'Person A' }]);
  assert.doesNotMatch(toCanonicalJson(createPrivateExport({ messages })), /visible-handle/);
});

test('derives zero-safe granular stats from sanitized export messages', () => {
  const stats = deriveExportStats(createPrivateExport({ messages: [{ sender: 'a', timestamp: '2026-01-01T00:00:00+05:30', text: 'x', reactions: [{ emoji: '👍', count: 2 }], attachments: [{ type: 'image' }], replies: [{ sender: 'b', timestamp: '2026-01-02T00:00:00+05:30', text: 'y' }] }] }));
  assert.deepEqual(stats.messagesByParticipant.map((item) => item.count), [1, 1]);
  assert.equal(stats.totalMessages, 2); assert.equal(stats.replies, 1); assert.equal(stats.attachments, 1); assert.equal(stats.reactionTotal, 2);
  assert.deepEqual(deriveExportStats({ messages: [] }).messagesByParticipant, []);
});

test('does not retain account names, source URLs, room IDs, or raw event IDs', () => {
  const result = createPrivateExport(source, { exportedAt: '2026-07-27T15:00:00.000Z' });
  const serialised = JSON.stringify(result);

  for (const forbidden of ['alex_private', 'sam-actual-name', 'secret-room', 'event-987', 'event-988']) {
    assert.equal(serialised.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.deepEqual(result.redaction, {
    accountNames: true,
    rawEventIds: true,
    roomIds: true,
    sourceUrls: false,
  });
});

test('redacts known identifiers when they appear in message text or attachment alt text', () => {
  const input = {
    roomId: 'room-hidden-42',
    sourceUrl: 'https://www.reddit.com/chat/room/room-hidden-42?event=evt-hidden-99',
    messages: [{
      id: 'evt-hidden-99',
      sender: { id: 'acct-hidden', username: 'u/acct-hidden' },
      text: 'acct-hidden linked reddit.com/chat/room/room-hidden-42 and /chat/room/room-hidden-42 (evt-hidden-99)',
      attachments: [{ type: 'image', alt: 'from acct-hidden at /chat/room/room-hidden-42, event evt-hidden-99' }],
    }],
  };
  const result = createPrivateExport(input, { exportedAt: '2026-07-27T15:00:00.000Z' });
  const serialised = JSON.stringify(result);

  for (const forbidden of ['acct-hidden']) {
    assert.equal(serialised.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.match(result.messages[0].text, /reddit\.com\/chat\/room\/room-hidden-42/);
  assert.match(result.messages[0].attachments[0].alt, /\[redacted\]/);
});

test('redacts identifiers inside surrounding text while retaining ordinary URLs', () => {
  const input = {
    roomId: 'room-hidden-42',
    messages: [{
      id: 'evt-hidden-99',
      sender: 'acct-hidden',
      text: 'prefixacct-hiddensuffix room-hidden-42tail evt-hidden-99end //192.0.2.9/private?invite=abc 192.0.2.8:8443/path ../private/path?invite=abc',
      attachments: [{ type: 'image', alt: 'startacct-hiddenend ../private/path?invite=abc //192.0.2.9/private?invite=abc' }],
    }],
  };
  const result = createPrivateExport(input, { exportedAt: '2026-07-27T15:00:00.000Z' });
  const serialised = JSON.stringify(result);

  for (const forbidden of ['acct-hidden', 'room-hidden-42', 'evt-hidden-99']) {
    assert.equal(serialised.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.match(result.messages[0].text, /192\.0\.2\.9\/private/);
  assert.match(result.messages[0].attachments[0].alt, /192\.0\.2\.9\/private/);
});

test('redacts a full bracketed IPv6 URL while preserving surrounding delimiters', () => {
  const result = createPrivateExport({
    messages: [{
      id: 'event-private',
      sender: 'private-account',
      text: 'Before (http://[2001:db8::1]/secret?token=abc), after.',
    }],
  }, { exportedAt: '2026-07-27T15:00:00.000Z' });

  assert.equal(result.messages[0].text, 'Before (http://[2001:db8::1]/secret?token=abc), after.');
  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes('http://[2001:db8::1]/secret?token=abc'), true);
});

test('redacts bare IPv6 addresses, email addresses, and phone numbers from visible content', () => {
  const result = createPrivateExport({
    messages: [{
      id: 'event-private',
      sender: 'private-account',
      text: 'Email person@example.test, IPv6 2001:db8::9, phone +1 (202) 555-0199.',
      attachments: [{ type: 'image', alt: 'owner+archive@example.test at 2001:db8:1::4; call 202-555-0188' }],
    }],
  }, { exportedAt: '2026-07-27T15:00:00.000Z' });
  const serialised = JSON.stringify(result);

  for (const forbidden of ['person@example.test', 'owner+archive@example.test', 'person@', 'owner+archive@', '2001:db8::9', '2001:db8:1::4', '555-0199', '555-0188']) {
    assert.equal(serialised.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.match(result.messages[0].text, /\[redacted\]/);
  assert.match(result.messages[0].attachments[0].alt, /\[redacted\]/);
});

test('redacts punctuation and Unicode email forms without consuming surrounding punctuation', () => {
  const result = createPrivateExport({
    messages: [{
      id: 'event-private',
      sender: 'private-account',
      text: "Emails: (o'connor@example.test), bang!user@example.test, tag=archive@example.test, 用户@例子.测试.",
      attachments: [{ type: 'image', alt: "[o'connor@example.test] and 用户@例子.测试!" }],
    }],
  }, { exportedAt: '2026-07-27T15:00:00.000Z' });
  const serialised = JSON.stringify(result);

  for (const forbidden of ["o'connor@example.test", 'bang!user@example.test', 'tag=archive@example.test', '用户@例子.测试']) {
    assert.equal(serialised.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.equal(result.messages[0].text, 'Emails: ([redacted]), [redacted], [redacted], [redacted].');
  assert.equal(result.messages[0].attachments[0].alt, '[[redacted]] and [redacted]!');
});

test('masks quoted and unusual email tokens as a whole before domain masking', () => {
  const result = createPrivateExport({
    messages: [{
      id: 'event-private',
      sender: 'private-account',
      text: 'Addresses: "bob"@example.test, a:b@example.test, user@sub.example.test.',
    }],
  }, { exportedAt: '2026-07-27T15:00:00.000Z' });

  assert.equal(result.messages[0].text, 'Addresses: [redacted], [redacted], [redacted].');
  const serialised = JSON.stringify(result);
  for (const forbidden of ['"bob"@example.test', 'a:b@example.test', 'user@sub.example.test', 'example.test', 'sub.example.test']) {
    assert.equal(serialised.includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test('masks quoted local-part emails with spaces and Unicode while preserving outer punctuation', () => {
  const result = createPrivateExport({
    messages: [{
      id: 'event-private',
      sender: 'private-account',
      text: 'Quoted: ("Alice Smith"@example.test), "नमस्ते दुनिया"@sub.例子.测试.',
    }],
  }, { exportedAt: '2026-07-27T15:00:00.000Z' });

  assert.equal(result.messages[0].text, 'Quoted: ([redacted]), [redacted].');
  const serialised = JSON.stringify(result);
  for (const forbidden of ['"Alice Smith"@example.test', '"नमस्ते दुनिया"@sub.例子.测试']) {
    assert.equal(serialised.includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test('preserves sanitized incomplete-thread state and renders a non-sensitive Markdown notice', () => {
  const result = createPrivateExport({
    messages: [{
      id: 'event-private',
      sender: 'private-account',
      text: 'A parent message',
      threadIncomplete: true,
      threadIncompleteReason: 'Could not scroll past raw-event-77 in room-hidden-42',
    }],
  }, { exportedAt: '2026-07-27T15:00:00.000Z' });
  const json = toCanonicalJson(result);
  const markdown = toMarkdown(result);

  assert.equal(result.messages[0].threadIncomplete, true);
  assert.equal(result.messages[0].threadIncompleteReason, 'Could not load the full reply history.');
  assert.equal(json.includes('raw-event-77'), false);
  assert.equal(json.includes('room-hidden-42'), false);
  assert.match(markdown, /> \*\*Thread incomplete:\*\* Some replies could not be loaded\./);
});

test('canonical JSON is stable and Markdown is readable without source metadata', () => {
  const result = createPrivateExport(source, { exportedAt: '2026-07-27T15:00:00.000Z' });
  const json = toCanonicalJson(result);
  const markdown = toMarkdown(result);

  assert.equal(json, toCanonicalJson(JSON.parse(json)));
  assert.match(markdown, /# Private chat export/);
  assert.match(markdown, /## Person B — Jul 27, 2026, 8:00:00 PM/);
  assert.match(markdown, /## Replies/);
  assert.equal(markdown.includes('reddit.com'), false);
});

test('uses neutral filenames regardless of source title or room', () => {
  assert.equal(createDownloadFilename('json', new Date('2026-07-27T15:00:00.000Z')), 'private-chat-export-2026-07-27.json');
  assert.equal(createDownloadFilename('md', new Date('2026-07-27T15:00:00.000Z')), 'private-chat-export-2026-07-27.md');
});
