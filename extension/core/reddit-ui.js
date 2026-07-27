/**
 * DOM-only collector for a Reddit chat already open in the browser.  It never
 * fetches data: it only reads elements that Reddit has rendered for the signed
 * in user.  Selectors are deliberately broad because the UI changes often.
 */
const LEGACY_MESSAGE_SELECTOR = '[data-event-id], [data-message-id], [data-testid*="message"], [role="listitem"], article';
const MESSAGE_SELECTOR = `rs-timeline-event[data-id], ${LEGACY_MESSAGE_SELECTOR}`;
const TIMELINE_SELECTORS = [
  'rs-timeline', 'rs-virtual-scroll-dynamic',
  '[data-testid*="message-list"]', '[data-testid*="conversation"]',
  '[aria-label*="chat" i]', '[role="log"]', '[role="feed"]',
];
const THREAD_SELECTORS = [
  '[data-testid*="thread"]', '[aria-label*="thread" i]', '[role="complementary"]',
];

export function allOpenShadowRoots(root) {
  const found = [];
  const visit = (node) => {
    if (!node) return;
    if (node.shadowRoot?.mode !== 'closed') {
      found.push(node.shadowRoot);
      visit(node.shadowRoot);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return found;
}

export function queryAllDeep(root, selector) {
  const scopes = [root, ...allOpenShadowRoots(root)];
  return unique(scopes.flatMap((scope) => [...(scope?.querySelectorAll?.(selector) ?? [])]));
}

/** Return only room links already rendered in the current Reddit chat UI. */
export function findLoadedRoomLinks(root) {
  const rooms = new Set();
  for (const link of queryAllDeep(root, 'a[href*="/chat/room/"]')) {
    try {
      const url = new URL(link.getAttribute?.('href') ?? link.href, 'https://www.reddit.com');
      if (!/(^|\.)reddit\.com$/i.test(url.hostname) || !/^\/chat\/room\/[^/?#]+/.test(url.pathname)) continue;
      url.search = '';
      url.hash = '';
      rooms.add(url.href);
    } catch { /* Ignore malformed rendered links. */ }
  }
  return [...rooms];
}

export function findMainTimeline(root) {
  return findTimeline(root, TIMELINE_SELECTORS, false);
}

export function findActiveThreadTimeline(root) {
  // Reddit mounts reply content beneath rs-thread after the reply control has
  // been clicked. Search that host first; its timeline is otherwise easy to
  // mistake for the main chat's timeline.
  for (const panel of queryAllDeep(root, 'rs-thread')) {
    const timeline = findTimeline(panel, ['rs-timeline', 'rs-virtual-scroll-dynamic', ...THREAD_SELECTORS], false);
    if (timeline) return timeline;
  }
  const labelled = findTimeline(root, THREAD_SELECTORS, true);
  if (labelled) return labelled;
  // Reddit's current DOM often renders the side panel as a second rs-timeline
  // without an accessible thread label. The later timeline is that panel.
  const timelines = queryAllDeep(root, 'rs-timeline').filter((node) => findMessageNodes(node).length > 0);
  return timelines.length > 1 ? timelines.at(-1) : null;
}

async function waitForActiveThreadTimeline(root, findThread, settle, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const timeline = findThread(root);
    if (timeline) return timeline;
    await settle();
  }
  return null;
}

/** Collect every currently-loadable item by walking a virtualized list upward. */
export async function collectTimeline(timeline, options = {}) {
  const {
    signal,
    maxScrollSteps = 80,
    settle = defaultSettle,
    extractMessage = extractRenderedMessage,
    onMessage,
  } = options;
  const byKey = new Map();
  const initialTop = Number(timeline.scrollTop ?? 0);
  const collectSnapshot = async () => {
    const snapshotOccurrences = new Map(); let senderFromPriorEvent;
    for (const node of findMessageNodes(timeline)) {
      const message = extractMessage(node); if (!message) continue;
      if (isReliableSender(message.sender)) senderFromPriorEvent = message.sender;
      else if (senderFromPriorEvent) message.sender = senderFromPriorEvent;
      if (!message.node) message.node = node;
      const signature = stableVisibleSignature(message); const occurrence = snapshotOccurrences.get(signature) ?? 0;
      snapshotOccurrences.set(signature, occurrence + 1);
      const key = message.eventId || `${signature}\u0000${occurrence}`;
      if (!byKey.has(key)) { byKey.set(key, message); await onMessage?.(message, node); }
    }
  };
  const sweep = async (direction) => {
    let unchanged = 0; let reached = false;
    for (let step = 0; step <= maxScrollSteps; step += 1) {
      throwIfAborted(signal); await collectSnapshot();
      if (step === maxScrollSteps) break;
      const before = byKey.size; const priorTop = Number(timeline.scrollTop ?? 0);
      const delta = Math.max(Number(timeline.clientHeight ?? 0), 600);
      const nextTop = direction < 0 ? Math.max(0, priorTop - delta) : Math.min(Number(timeline.scrollHeight ?? priorTop), priorTop + delta);
      if ((direction < 0 && priorTop <= 0) || (direction > 0 && nextTop === priorTop)) { reached = true; break; }
      timeline.scrollTop = nextTop; await settle();
      if (byKey.size === before && Number(timeline.scrollTop ?? 0) === priorTop) unchanged += 1; else unchanged = 0;
      if (unchanged >= 2) break;
    }
    return reached;
  };

  const reachedStart = await sweep(-1);
  timeline.scrollTop = initialTop; await settle();
  const reachedEnd = await sweep(1);
  const complete = reachedStart && reachedEnd;
  return { messages: [...byKey.values()], complete, reason: complete ? undefined : 'Timeline may not include all older or newer messages.' };
}

/**
 * Opens every visible reply control, collects the active side panel, then
 * restores the main view. Failed panels are explicitly reported, never hidden.
 */
export async function collectChatWithThreads(root, options = {}) {
  const main = options.mainTimeline ?? findMainTimeline(root);
  if (!main) return { messages: [], warnings: ['Chat timeline is unavailable; nothing was exported.'], diagnostics: { mainTimelineFound: false, messagesCollected: 0, replyControlsFound: 0, replyThreadsOpened: 0, replyThreadsCompleted: 0, replyThreadsIncomplete: 0 } };
  const warnings = [];
  const diagnostics = { mainTimelineFound: true, messagesCollected: 0, replyControlsFound: 0, replyThreadsOpened: 0, replyThreadsCompleted: 0, replyThreadsIncomplete: 0 };
  const collectRepliesForMessage = async (message) => {
    if (message.node?.isConnected === false) {
      markThreadIncomplete(message, 'Reply control was no longer rendered before its thread could be opened.', warnings); diagnostics.replyThreadsIncomplete += 1;
      return;
    }
    const control = findReplyControl(message.node);
    if (!control) return;
    diagnostics.replyControlsFound += 1;
    throwIfAborted(options.signal);
    let abortError;
    try {
      control.click();
      diagnostics.replyThreadsOpened += 1;
      await (options.settle ?? defaultSettle)();
      const thread = await waitForActiveThreadTimeline(root, options.findActiveThreadTimeline ?? findActiveThreadTimeline, options.settle ?? defaultSettle);
      if (!thread) throw new Error('thread panel unavailable');
      const collected = await collectTimeline(thread, { ...options, onMessage: undefined });
      message.replies = collected.messages;
      if (!collected.complete) { markThreadIncomplete(message, collected.reason, warnings); diagnostics.replyThreadsIncomplete += 1; }
      else diagnostics.replyThreadsCompleted += 1;
    } catch (error) {
      // Cancellation must stop the outer main-list traversal, but only after
      // the finally block has restored the UI to its main chat state.
      if (options.signal?.aborted || error?.name === 'AbortError') abortError = error;
      else { markThreadIncomplete(message, 'A reply thread could not be opened or exported completely.', warnings); diagnostics.replyThreadsIncomplete += 1; }
    } finally {
      closeThread(root);
      await (options.settle ?? defaultSettle)();
    }
    if (abortError) throw abortError;
    throwIfAborted(options.signal);
  };
  const primary = await collectTimeline(main, {
    ...options,
    onMessage: async (message, node) => {
      await options.onMessage?.(message, node);
      await collectRepliesForMessage(message);
    },
  });
  if (!primary.complete) warnings.unshift(primary.reason);
  diagnostics.messagesCollected = primary.messages.length;
  return { messages: primary.messages, warnings: unique(warnings), diagnostics };
}

export function extractRenderedMessage(node) {
  const eventId = node.getAttribute?.('data-id') ?? node.getAttribute?.('data-event-id') ?? node.getAttribute?.('data-message-id') ?? undefined;
  const candidate = firstText(node, ['[data-testid*="author"]', '[data-testid*="sender"]', '[data-testid*="user"]', '[class*="author" i]', '[class*="sender" i]', '[class*="username" i]', '[aria-label*="sent by" i]']) ?? senderFromProfileLink(node) ?? inferSenderFromEventText(node);
  const sender = isReliableSender(candidate) ? candidate : undefined;
  const timeNode = queryAllDeep(node, 'time')[0];
  const timestamp = timeNode?.getAttribute?.('datetime') ?? timeNode?.textContent?.trim();
  const text = firstText(node, ['[data-testid*="message-content"]', '[data-testid*="text"]', '[dir="auto"]']) ?? node.textContent?.trim() ?? '';
  return { eventId, sender: sender || 'unknown', timestamp, text, node };
}

function senderFromProfileLink(node) {
  const link = queryAllDeep(node, 'a[href*="/user/"], a[href*="/u/"]')[0];
  const match = link?.getAttribute?.('href')?.match(/\/(?:user|u)\/([^/?#]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function inferSenderFromEventText(node) {
  const lines = String(node?.innerText ?? node?.textContent ?? '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const header = lines[0] ?? '';
  // Reddit's event header is rendered as "sender 12:34 PM" when its custom
  // element does not expose an author-specific selector. Never guess from a
  // message body: absent a time-shaped header we retain the neutral fallback.
  const match = header.match(/^(.+?)\s+(?:\d{1,2}:\d{2}(?:\s*[AP]M)?|Yesterday|Today)$/i);
  const candidate = match?.[1]?.trim();
  return isReliableSender(candidate) ? candidate : undefined;
}

function isReliableSender(value) {
  const candidate = String(value ?? '').trim();
  return Boolean(candidate) && !/^(?:unknown|gif|giphy|media|image|photo|video|attachment|sticker|reaction|reactions?)$/i.test(candidate);
}

function findTimeline(root, selectors, threadOnly) {
  const candidates = unique(selectors.flatMap((selector) => queryAllDeep(root, selector)));
  return candidates.find((node) => {
    const label = `${node.getAttribute?.('aria-label') ?? ''} ${node.getAttribute?.('data-testid') ?? ''}`.toLowerCase();
    const hasMessages = findMessageNodes(node).length > 0;
    return hasMessages && (!threadOnly || /thread|repl/.test(label) || hasThreadHeading(node));
  }) ?? null;
}

function findMessageNodes(timeline) {
  const candidates = unique([...queryAllDeep(timeline, MESSAGE_SELECTOR), ...queryAllDeep(timeline, LEGACY_MESSAGE_SELECTOR)])
    .filter((node) => node !== timeline && !node.closest?.('[data-testid*="composer"]'));
  // Event IDs are the most stable dedupe key.  If they exist, avoid treating
  // nested content elements as additional messages.
  const identified = candidates.filter((node) => node.getAttribute?.('data-id') || node.getAttribute?.('data-event-id') || node.getAttribute?.('data-message-id'));
  return identified.length ? identified : candidates;
}

function findReplyControl(node) {
  return queryAllDeep(node, 'button, [role="button"]').find((button) => /\b\d+ repl(?:y|ies)\b|view repl(?:y|ies)|open thread|replies/i.test(accessibleName(button))) ?? null;
}

function closeThread(root) {
  const close = queryAllDeep(root, 'button, [role="button"]').find((button) => /close (thread|repl)|back to chat|dismiss thread/i.test(accessibleName(button)));
  close?.click();
}

function accessibleName(node) { return `${node?.getAttribute?.('aria-label') ?? ''} ${node?.textContent ?? ''}`.trim(); }
function hasThreadHeading(node) { return queryAllDeep(node, '[role="heading"], h1, h2, h3').some((heading) => /thread|repl/i.test(heading.textContent ?? '')); }
function firstText(node, selectors) { for (const selector of selectors) { const value = queryAllDeep(node, selector)[0]?.textContent?.trim(); if (value) return value; } return undefined; }
function stableVisibleSignature(message) { return `${normaliseVisibleText(message.sender)}\u0000${message.timestamp ?? ''}\u0000${normaliseVisibleText(message.text)}`; }
function normaliseVisibleText(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function markThreadIncomplete(message, reason, warnings) {
  message.threadIncomplete = true;
  message.threadIncompleteReason = reason;
  warnings.push(reason === 'Timeline may not include all older messages.' ? 'A reply thread may not include all older messages.' : reason);
}
function unique(values) { return [...new Set(values)]; }
function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); }
function defaultSettle() { return new Promise((resolve) => setTimeout(resolve, 50)); }
