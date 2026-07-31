import test from 'node:test';
import assert from 'node:assert/strict';
import { collectChatWithThreads, collectTimeline, findActiveThreadTimeline, findLoadedRoomLinks, findMainTimeline, queryAllDeep } from '../src/shared/reddit-ui.js';

class FakeNode {
  constructor({ attrs = {}, text = '', selectors = {}, children = [] } = {}) { this.attrs = attrs; this.textContent = text; this.selectors = selectors; this.children = children; this.scrollTop = 0; this.clientHeight = 600; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  querySelectorAll(selector) { return this.selectors[selector] ?? []; }
  click() { this.onClick?.(); }
}

test('queries open shadow roots without requiring Reddit DOM data', () => {
  const leaf = new FakeNode();
  const host = new FakeNode(); host.shadowRoot = new FakeNode({ selectors: { '.target': [leaf] } });
  const root = new FakeNode({ children: [host] });
  assert.deepEqual(queryAllDeep(root, '.target'), [leaf]);
});

test('returns only distinct currently rendered Reddit chat-room links', () => {
  const first = new FakeNode({ attrs: { href: '/chat/room/first?ignored=1' } });
  const duplicate = new FakeNode({ attrs: { href: 'https://www.reddit.com/chat/room/first#ignored' } });
  const second = new FakeNode({ attrs: { href: 'https://www.reddit.com/chat/room/second' } });
  const other = new FakeNode({ attrs: { href: 'https://example.test/chat/room/not-reddit' } });
  const root = new FakeNode({ selectors: { 'a[href*="/chat/room/"]': [first, duplicate, second, other] } });
  assert.deepEqual(findLoadedRoomLinks(root), [
    'https://www.reddit.com/chat/room/first',
    'https://www.reddit.com/chat/room/second',
  ]);
});

test('collects Reddit rs timeline events through its open virtual-scroll shadow root', async () => {
  const event = new FakeNode({ attrs: { 'data-id': 'reddit-event-1' }, text: 'visible message' });
  const virtualScroll = new FakeNode({ selectors: { 'rs-timeline-event[data-id], [data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [event] } });
  const timeline = new FakeNode({ selectors: { 'rs-timeline-event[data-id], [data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [] } });
  timeline.shadowRoot = new FakeNode({ selectors: { 'rs-timeline-event[data-id], [data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [event] }, children: [virtualScroll] });
  const root = new FakeNode({ selectors: { 'rs-timeline': [timeline] }, children: [timeline] });
  assert.equal(findMainTimeline(root), timeline);
  const result = await collectTimeline(timeline, { extractMessage: (node) => ({ eventId: node.getAttribute('data-id'), text: node.textContent }) });
  assert.deepEqual(result.messages.map((message) => message.eventId), ['reddit-event-1']);
});

test('uses the second rendered rs timeline as an unlabeled active thread panel', () => {
  const messageSelector = 'rs-timeline-event[data-id], [data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article';
  const main = new FakeNode({ selectors: { [messageSelector]: [new FakeNode({ attrs: { 'data-id': 'main' } })] } });
  const thread = new FakeNode({ selectors: { [messageSelector]: [new FakeNode({ attrs: { 'data-id': 'thread' } })] } });
  const root = new FakeNode({ selectors: { 'rs-timeline': [main, thread] } });
  assert.equal(findActiveThreadTimeline(root), thread);
});

test('walks a virtualized timeline upward, dedupes event ids, and reports completion', async () => {
  const a = new FakeNode({ attrs: { 'data-event-id': 'a' }, text: 'first' });
  const b = new FakeNode({ attrs: { 'data-event-id': 'b' }, text: 'second' });
  const timeline = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [b] } });
  timeline.scrollTop = 100; timeline.scrollHeight = 700;
  const result = await collectTimeline(timeline, { settle: async () => { timeline.selectors['[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article'] = [a, b]; }, extractMessage: (node) => ({ eventId: node.getAttribute('data-event-id'), timestamp: node.getAttribute('data-event-id') === 'a' ? '2026-01-01T00:00:00Z' : '2026-01-01T00:01:00Z', text: node.textContent }) });
  assert.deepEqual(result.messages.map((m) => m.eventId), ['a', 'b']);
  assert.equal(result.complete, true);
});

test('cancellation stops scrolling before more DOM work', async () => {
  const timeline = new FakeNode(); timeline.scrollTop = 100;
  const signal = AbortSignal.abort('stop');
  await assert.rejects(() => collectTimeline(timeline, { signal }), /stop|Aborted/);
});

test('dedupes repeated renders without an event id while retaining snapshot occurrences', async () => {
  const rendered = new FakeNode({ text: 'same visible message' });
  const timeline = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [rendered] } });
  timeline.scrollTop = 100;
  const result = await collectTimeline(timeline, { settle: async () => {}, extractMessage: (node) => ({ sender: 'Person A', timestamp: 'today', text: node.textContent }) });
  assert.equal(result.messages.length, 1);
});

test('inherits the preceding visible sender for consecutive rendered messages', async () => {
  const named = new FakeNode({ attrs: { 'data-event-id': 'one' }, text: 'first' });
  const continuation = new FakeNode({ attrs: { 'data-event-id': 'two' }, text: 'second' });
  const nextNamed = new FakeNode({ attrs: { 'data-event-id': 'three' }, text: 'third' });
  const timeline = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [named, continuation, nextNamed] } });
  const result = await collectTimeline(timeline, {
    extractMessage: (node) => ({ eventId: node.getAttribute('data-event-id'), sender: node === named ? 'first-handle' : node === nextNamed ? 'second-handle' : 'unknown', text: node.textContent }),
  });
  assert.deepEqual(result.messages.map((message) => message.sender), ['first-handle', 'first-handle', 'second-handle']);
});

test('opens reply controls, captures side-panel replies, and closes the panel', async () => {
  const reply = new FakeNode({ attrs: { 'data-event-id': 'r' }, text: 'reply' });
  const thread = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [reply] } });
  const button = new FakeNode({ attrs: { 'aria-label': '2 replies' } });
  const parent = new FakeNode({ attrs: { 'data-event-id': 'p' }, text: 'parent', selectors: { 'button, [role="button"]': [button] } });
  const main = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [parent] } });
  const close = new FakeNode({ attrs: { 'aria-label': 'Close thread' } });
  const root = new FakeNode({ selectors: { 'button, [role="button"]': [close] } });
  button.onClick = () => { root.threadOpen = true; }; close.onClick = () => { root.threadOpen = false; };
  const result = await collectChatWithThreads(root, { mainTimeline: main, findActiveThreadTimeline: () => root.threadOpen ? thread : null, settle: async () => {}, extractMessage: (node) => ({ eventId: node.getAttribute('data-event-id'), text: node.textContent }) });
  assert.equal(result.messages[0].replies[0].eventId, 'r');
  assert.equal(root.threadOpen, false);
  assert.deepEqual(result.warnings, []);
});

test('captures replies before virtual scrolling disconnects their parent control', async () => {
  const reply = new FakeNode({ attrs: { 'data-event-id': 'r' }, text: 'reply' });
  const thread = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [reply] } });
  const control = new FakeNode({ attrs: { 'aria-label': '1 reply' } });
  const parent = new FakeNode({ attrs: { 'data-event-id': 'p' }, text: 'parent', selectors: { 'button, [role="button"]': [control] } });
  const main = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [parent] } });
  main.scrollTop = 100;
  const close = new FakeNode({ attrs: { 'aria-label': 'Close thread' } });
  const root = new FakeNode({ selectors: { 'button, [role="button"]': [close] } });
  control.onClick = () => { assert.equal(control.disconnected, undefined); root.threadOpen = true; };
  close.onClick = () => { root.threadOpen = false; };
  const settle = async () => {
    if (!root.threadOpen) {
      control.disconnected = true;
      parent.selectors['button, [role="button"]'] = [];
      main.selectors['[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article'] = [];
    }
  };
  const result = await collectChatWithThreads(root, { mainTimeline: main, findActiveThreadTimeline: () => root.threadOpen ? thread : null, settle, extractMessage: (node) => ({ eventId: node.getAttribute('data-event-id'), text: node.textContent }) });
  assert.equal(result.messages[0].replies[0].eventId, 'r');
  assert.equal(control.disconnected, true);
});

test('marks a reply incomplete when a prior panel close disconnects its parent node', async () => {
  const firstControl = new FakeNode({ attrs: { 'aria-label': '1 reply' } });
  const secondControl = new FakeNode({ attrs: { 'aria-label': '1 reply' } });
  const first = new FakeNode({ attrs: { 'data-event-id': 'first' }, selectors: { 'button, [role="button"]': [firstControl] } });
  const second = new FakeNode({ attrs: { 'data-event-id': 'second' }, selectors: { 'button, [role="button"]': [secondControl] } });
  const reply = new FakeNode({ attrs: { 'data-event-id': 'reply' } });
  const thread = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [reply] } });
  const main = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [first, second] } });
  const close = new FakeNode({ attrs: { 'aria-label': 'Close thread' } });
  const root = new FakeNode({ selectors: { 'button, [role="button"]': [close] } });
  firstControl.onClick = () => { root.threadOpen = true; };
  close.onClick = () => { root.threadOpen = false; second.isConnected = false; };
  const result = await collectChatWithThreads(root, { mainTimeline: main, findActiveThreadTimeline: () => root.threadOpen ? thread : null, settle: async () => {}, extractMessage: (node) => ({ eventId: node.getAttribute('data-event-id'), text: node.textContent }) });
  assert.equal(result.messages[0].replies[0].eventId, 'reply');
  assert.equal(result.messages[1].threadIncomplete, true);
  assert.match(result.messages[1].threadIncompleteReason, /no longer rendered/i);
  assert.match(result.warnings.join(' '), /no longer rendered/i);
});

test('propagates an abort during thread collection after closing its panel', async () => {
  const firstControl = new FakeNode({ attrs: { 'aria-label': '1 reply' } });
  const secondControl = new FakeNode({ attrs: { 'aria-label': '1 reply' } });
  const first = new FakeNode({ attrs: { 'data-event-id': 'first' }, selectors: { 'button, [role="button"]': [firstControl] } });
  const second = new FakeNode({ attrs: { 'data-event-id': 'second' }, selectors: { 'button, [role="button"]': [secondControl] } });
  const reply = new FakeNode({ attrs: { 'data-event-id': 'reply' } });
  const thread = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [reply] } });
  thread.scrollTop = 100;
  const main = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [first, second] } });
  const close = new FakeNode({ attrs: { 'aria-label': 'Close thread' } });
  const root = new FakeNode({ selectors: { 'button, [role="button"]': [close] } });
  const controller = new AbortController();
  firstControl.onClick = () => { root.threadOpen = true; };
  secondControl.onClick = () => { assert.fail('main collection continued after abort'); };
  close.onClick = () => { root.closed = true; root.threadOpen = false; };
  let settles = 0;
  await assert.rejects(() => collectChatWithThreads(root, {
    mainTimeline: main,
    findActiveThreadTimeline: () => root.threadOpen ? thread : null,
    signal: controller.signal,
    settle: async () => { if (++settles === 2) controller.abort(new DOMException('stop', 'AbortError')); },
    extractMessage: (node) => ({ eventId: node.getAttribute('data-event-id'), text: node.textContent }),
  }), /stop|Abort/);
  assert.equal(root.closed, true);
});

test('marks thread export as incomplete instead of silently dropping it', async () => {
  const parent = new FakeNode({ attrs: { 'data-event-id': 'p' }, text: 'parent', selectors: { 'button, [role="button"]': [new FakeNode({ attrs: { 'aria-label': '1 reply' } })] } });
  const main = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [parent] } });
  const result = await collectChatWithThreads(new FakeNode(), { mainTimeline: main, settle: async () => {}, extractMessage: (node) => ({ eventId: node.getAttribute('data-event-id'), text: node.textContent }) });
  assert.equal(result.messages[0].threadIncomplete, true);
  assert.match(result.warnings.join(' '), /could not be opened/i);
});

test('marks a successfully opened but stalled thread incomplete on its parent', async () => {
  const reply = new FakeNode({ attrs: { 'data-event-id': 'r' }, text: 'reply' });
  const thread = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [reply] } });
  thread.scrollTop = 50;
  const button = new FakeNode({ attrs: { 'aria-label': '1 reply' } });
  const parent = new FakeNode({ attrs: { 'data-event-id': 'p' }, text: 'parent', selectors: { 'button, [role="button"]': [button] } });
  const main = new FakeNode({ selectors: { '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article': [parent] } });
  const root = new FakeNode(); button.onClick = () => { root.threadOpen = true; };
  const result = await collectChatWithThreads(root, { mainTimeline: main, findActiveThreadTimeline: () => root.threadOpen ? thread : null, maxScrollSteps: 0, settle: async () => {}, extractMessage: (node) => ({ eventId: node.getAttribute('data-event-id'), text: node.textContent }) });
  assert.equal(result.messages[0].threadIncomplete, true);
  assert.equal(result.messages[0].threadIncompleteReason, 'Timeline may not include all older or newer messages.');
  assert.match(result.warnings.join(' '), /older or newer/i);
});
