/* Private Reddit Chat Exporter — local DOM only; generated file. */
(() => {
'use strict';
// src/shared/reddit-ui.js
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

function allOpenShadowRoots(root) {
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

function queryAllDeep(root, selector) {
  const scopes = [root, ...allOpenShadowRoots(root)];
  return unique(scopes.flatMap((scope) => [...(scope?.querySelectorAll?.(selector) ?? [])]));
}

/** Return only room links already rendered in the current Reddit chat UI. */
function findLoadedRoomLinks(root) {
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

function findMainTimeline(root) {
  return findTimeline(root, TIMELINE_SELECTORS, false);
}

function findActiveThreadTimeline(root) {
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
async function collectTimeline(timeline, options = {}) {
  const {
    signal,
    maxScrollSteps = 160,
    settle = defaultSettle,
    extractMessage = extractRenderedMessage,
    onMessage,
    scanBothDirections = true,
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
  const reachedEnd = scanBothDirections ? (timeline.scrollTop = initialTop, await settle(), await sweep(1)) : true;
  const complete = reachedStart && reachedEnd;
  return { messages: [...byKey.values()], complete, reason: complete ? undefined : 'Timeline may not include all older or newer messages.' };
}

/**
 * Opens every visible reply control, collects the active side panel, then
 * restores the main view. Failed panels are explicitly reported, never hidden.
 */
async function collectChatWithThreads(root, options = {}) {
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
      const collected = await collectTimeline(thread, { ...options, onMessage: undefined, scanBothDirections: false });
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
  diagnostics.mainTimelineComplete = primary.complete;
  return { messages: primary.messages, warnings: unique(warnings), diagnostics };
}

function extractRenderedMessage(node) {
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


// src/shared/exporter.js
const DEFAULT_REDACTION = Object.freeze({
  accountNames: true,
  rawEventIds: true,
  roomIds: true,
  sourceUrls: false,
});

/**
 * Convert chat DOM data into a shareable, offline-only export. Input identifiers
 * are used only while this function runs and are never included in its result.
 */
function createPrivateExport(input = {}, options = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const senderTokens = [...collectSenderTokens(messages)].sort(compareText);
  const aliases = new Map(senderTokens.map((token, index) => [token, personId(index)]));
  const sensitiveTokens = collectSensitiveTokens(input, messages);
  let nextMessageNumber = 1;

  const normaliseMessage = (message) => {
    const localId = `message-${String(nextMessageNumber++).padStart(4, '0')}`;
    const senderToken = getSenderToken(message);
    return removeUndefined({
      id: localId,
      authorId: aliases.get(senderToken) ?? 'person-unknown',
      timestamp: normaliseTimestamp(message?.timestamp ?? message?.createdAt),
      text: redactText(message?.text ?? message?.body ?? '', sensitiveTokens),
      reactions: normaliseReactions(message?.reactions),
      attachments: normaliseAttachments(message?.attachments ?? message?.media, sensitiveTokens),
      threadIncomplete: Boolean(message?.threadIncomplete),
      threadIncompleteReason: message?.threadIncomplete ? normaliseThreadIncompleteReason(message?.threadIncompleteReason) : undefined,
      replies: (Array.isArray(message?.replies) ? message.replies : []).map(normaliseMessage),
    });
  };

  const participants = senderTokens.map((_, index) => ({ id: personId(index), label: personLabel(index) }));
  if (hasUnknownSender(messages)) participants.push({ id: 'person-unknown', label: 'Unknown sender' });

  const exportData = {
    schemaVersion: '1.0',
    title: 'Private chat export',
    exportedAt: normaliseTimestamp(options.exportedAt) ?? new Date().toISOString(),
    redaction: { ...DEFAULT_REDACTION },
    participants,
    messages: messages.map(normaliseMessage),
  };
  exportData.stats = deriveExportStats(exportData);
  return exportData;
}

function deriveExportStats(exportData = {}) {
  const counts = new Map(); let topLevelMessages = 0; let replies = 0; let attachments = 0; let reactionItems = 0; let reactionTotal = 0; let incompleteThreads = 0;
  const times = [];
  const visit = (messages, depth = 0) => (messages ?? []).forEach((message) => {
    if (depth === 0) topLevelMessages += 1; else replies += 1;
    counts.set(message.authorId ?? 'person-unknown', (counts.get(message.authorId ?? 'person-unknown') ?? 0) + 1);
    attachments += message.attachments?.length ?? 0;
    for (const reaction of message.reactions ?? []) { reactionItems += 1; reactionTotal += Number(reaction.count ?? 0); }
    if (message.threadIncomplete) incompleteThreads += 1;
    if (message.timestamp && !Number.isNaN(new Date(message.timestamp).valueOf())) times.push(message.timestamp);
    visit(message.replies, depth + 1);
  });
  visit(exportData.messages);
  const sortedTimes = [...times].sort();
  return {
    topLevelMessages, replies, totalMessages: topLevelMessages + replies,
    messagesByParticipant: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => ({ id, count })),
    attachments, reactionItems, reactionTotal, incompleteThreads,
    earliestMessageAt: sortedTimes[0] ?? null, latestMessageAt: sortedTimes.at(-1) ?? null,
  };
}

/**
 * Transient UI-only mapping aid. Callers must never serialise or persist this
 * return value: its handles are deliberately excluded from export data.
 */
function createLocalParticipantPreview(messages = []) {
  return [...collectSenderTokens(messages)].sort(compareText)
    .map((handle, index) => ({ id: personId(index), handle, fallbackLabel: personLabel(index) }));
}

function toCanonicalJson(exportData) {
  return `${JSON.stringify(sortKeys(exportData), null, 2)}\n`;
}

/** Remove only exact, already-sanitized duplicates within the same thread level. */
function removeExactDuplicates(exportData) {
  let removed = 0;
  const visit = (messages = []) => {
    const seen = new Set();
    return messages.flatMap((message) => {
      const replies = visit(message.replies);
      const copy = { ...message, replies };
      const fingerprint = JSON.stringify(sortKeys({
        authorId: copy.authorId,
        timestamp: copy.timestamp,
        text: copy.text,
        reactions: copy.reactions,
        attachments: copy.attachments,
        threadIncomplete: copy.threadIncomplete,
        threadIncompleteReason: copy.threadIncompleteReason,
        replies,
      }));
      if (seen.has(fingerprint)) { removed += 1; return []; }
      seen.add(fingerprint);
      return [copy];
    });
  };
  const next = { ...exportData, messages: visit(exportData.messages) };
  return { exportData: { ...next, stats: deriveExportStats(next) }, removed };
}

function toMarkdown(exportData) {
  const lines = ['# Private chat export', '', `Exported: ${formatMarkdownTimestamp(exportData.exportedAt)}`, '', '## Summary', '', `- Messages: ${exportData.stats?.totalMessages ?? 0} (${exportData.stats?.topLevelMessages ?? 0} top-level, ${exportData.stats?.replies ?? 0} replies)`, `- Attachments: ${exportData.stats?.attachments ?? 0}; reactions: ${exportData.stats?.reactionTotal ?? 0}`, `- Thread warnings: ${exportData.stats?.incompleteThreads ?? 0}`, `- Range: ${formatMarkdownTimestamp(exportData.stats?.earliestMessageAt)} to ${formatMarkdownTimestamp(exportData.stats?.latestMessageAt)}`, ''];
  const names = new Map((exportData.participants ?? []).map((person) => [person.id, person.label]));

  for (const message of exportData.messages ?? []) renderMessage(message, 2, names, lines);
  return `${lines.join('\n').trimEnd()}\n`;
}

function createDownloadFilename(format, date = new Date(), suffix = '') {
  const extension = format === 'markdown' ? 'md' : format;
  if (!['json', 'md'].includes(extension)) throw new TypeError('format must be json, md, or markdown');
  const day = date.toISOString().slice(0, 10);
  const safeSuffix = String(suffix).replace(/[^a-z0-9-]/gi, '').slice(0, 32);
  return `private-chat-export-${day}${safeSuffix ? `-${safeSuffix}` : ''}.${extension}`;
}

function renderMessage(message, headingLevel, names, lines) {
  const label = names.get(message.authorId) ?? 'Unknown person';
  lines.push(`${'#'.repeat(headingLevel)} ${label} — ${formatMarkdownTimestamp(message.timestamp)}`, '');
  if (message.text) lines.push(message.text, '');
  if (message.threadIncomplete) lines.push('> **Thread incomplete:** Some replies could not be loaded.', '');
  if (message.attachments?.length) {
    for (const attachment of message.attachments) lines.push(`- Attachment: ${attachment.type}${attachment.alt ? ` — ${attachment.alt}` : ''}`);
    lines.push('');
  }
  if (message.replies?.length) {
    lines.push(`${'#'.repeat(headingLevel + 1)} Replies`, '');
    for (const reply of message.replies) renderMessage(reply, headingLevel + 2, names, lines);
  }
}

function formatMarkdownTimestamp(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(date);
}

function collectSenderTokens(messages, tokens = new Set()) {
  for (const message of messages) {
    const token = getSenderToken(message);
    if (token) tokens.add(token);
    if (Array.isArray(message?.replies)) collectSenderTokens(message.replies, tokens);
  }
  return tokens;
}

function hasUnknownSender(messages) {
  return messages.some((message) => !getSenderToken(message) || hasUnknownSender(Array.isArray(message?.replies) ? message.replies : []));
}

function collectSensitiveTokens(input, messages) {
  const tokens = new Set();
  collectSensitiveValues(input, tokens);
  collectMessageSensitiveValues(messages, tokens);
  return [...tokens].filter((token) => token.length > 0).sort((left, right) => right.length - left.length || compareText(left, right));
}

function collectMessageSensitiveValues(messages, tokens) {
  for (const message of messages) {
    for (const value of senderValues(message?.sender ?? message?.author)) addSensitiveValue(tokens, value);
    for (const key of ['id', 'eventId', 'messageId', 'roomId', 'sourceUrl', 'profileUrl', 'url', 'link']) {
      addSensitiveValue(tokens, message?.[key]);
    }
    if (Array.isArray(message?.replies)) collectMessageSensitiveValues(message.replies, tokens);
  }
}

function collectSensitiveValues(value, tokens, key = '') {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (/(?:room|event|message|account|author|sender|user|profile|source|url|link|\bid$)/i.test(key)) addSensitiveValue(tokens, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveValues(item, tokens, key);
    return;
  }
  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) collectSensitiveValues(childValue, tokens, childKey);
  }
}

function senderValues(sender) {
  if (typeof sender === 'string') return [sender];
  if (!sender || typeof sender !== 'object') return [];
  return [sender.id, sender.username, sender.name, sender.displayName].filter((value) => typeof value === 'string');
}

function addSensitiveValue(tokens, value) {
  if (typeof value !== 'string' || value.length === 0) return;
  tokens.add(value);
  const username = value.match(/^u\/([a-z0-9_-]+)$/i);
  if (username) tokens.add(username[1]);
  try {
    const parsed = new URL(value);
    for (const [, parameter] of parsed.searchParams) if (parameter) tokens.add(parameter);
    addRouteIdentifiers(tokens, parsed.pathname);
  } catch {
    addRouteIdentifiers(tokens, value);
    // Opaque IDs are handled as their complete input values.
  }
}

function addRouteIdentifiers(tokens, path) {
  for (const match of String(path).matchAll(/\/(?:room|user|u|event|message)\/([^/?#\s]+)/gi)) tokens.add(match[1]);
}

function getSenderToken(message) {
  const sender = message?.sender ?? message?.author ?? message?.senderId;
  if (typeof sender === 'string') return isReliableSenderToken(sender) ? sender : '';
  if (sender && typeof sender === 'object') {
    const token = String(sender.id ?? sender.username ?? sender.name ?? '');
    return isReliableSenderToken(token) ? token : '';
  }
  return '';
}

function isReliableSenderToken(value) {
  const token = String(value ?? '').trim();
  return Boolean(token) && !/^(?:unknown|gif|giphy|media|image|photo|video|attachment|sticker|reaction|reactions?)$/i.test(token);
}

function normaliseTimestamp(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const original = typeof value === 'string' ? value.trim() : '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return undefined;
  // If Reddit supplied a local offset, keep the exact instant and offset the
  // viewer saw. Zulu timestamps are converted to the browser's local zone.
  if (/\d{2}:\d{2}$/.test(original) && /T/.test(original)) return original;
  return formatDateInLocalTimezone(date);
}

function formatDateInLocalTimezone(date) {
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function normaliseReactions(reactions) {
  if (!Array.isArray(reactions) || reactions.length === 0) return undefined;
  return reactions.map((reaction) => {
    if (typeof reaction === 'string') return { emoji: reaction, count: 1 };
    return removeUndefined({
      emoji: String(reaction?.emoji ?? reaction?.name ?? ''),
      count: Number.isSafeInteger(reaction?.count) ? reaction.count : 1,
    });
  });
}

function normaliseAttachments(attachments, sensitiveTokens) {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  return attachments.map((attachment) => removeUndefined({
    type: String(attachment?.type ?? attachment?.kind ?? 'media'),
    alt: attachment?.alt ? redactText(attachment.alt, sensitiveTokens) : undefined,
  }));
}

function normaliseThreadIncompleteReason(reason) {
  const value = String(reason ?? '').toLowerCase();
  if (/(?:history|oldest|scroll)/.test(value)) return 'Could not load the full reply history.';
  if (/(?:access|permission|unavailable)/.test(value)) return 'Some replies were unavailable.';
  return 'Some replies could not be loaded.';
}

function redactText(value, sensitiveTokens = []) {
  const urlPattern = /(https?:\/\/[^\s<>"']+|\/\/[^\s<>"']+|www\.[^\s<>"']+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?)/gi;
  const withoutEmails = String(value)
    .replace(/"(?:[^"\\]|\\.)*"@[^\s<>()\[\]{},;.!?]+(?:\.[^\s<>()\[\]{},;.!?]+)+/gu, '[redacted]')
    .replace(/[^\s<>()\[\]{},;"]+@[^\s<>()\[\]{},;"]+\.[^\s<>()\[\]{},;".!?]+/gu, '[redacted]');
  return withoutEmails.split(urlPattern).map((part) => /^(?:https?:\/\/|\/\/|www\.)|^(?:[a-z0-9-]+\.)+[a-z]{2,}/i.test(part) ? part : redactNonUrl(part, sensitiveTokens)).join('');
}

function redactNonUrl(value, sensitiveTokens) {
  let result = String(value)
    .replace(/(?<![a-f0-9:])(?:(?:[a-f0-9]{1,4}:){1,7}:[a-f0-9]{0,4}|(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4})(?![a-f0-9:])/gi, '[redacted]')
    .replace(/(?<![\w+])\+?\d[\d\s().-]{6,}\d(?!\w)/g, '[redacted]')
    .replace(/\bu\/[a-z0-9_-]+\b/gi, 'u/[redacted]');
  for (const token of sensitiveTokens) {
    const escaped = escapeRegExp(token);
    result = result.replace(new RegExp(escaped, 'gi'), '[redacted]');
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function personId(index) {
  return `person-${letterSequence(index)}`.toLowerCase();
}

function personLabel(index) {
  return `Person ${letterSequence(index)}`;
}

function letterSequence(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, sortKeys(value[key])]));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function removeUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}


// src/console/entry.js
/*
 * This module is bundled into dist/reddit-chat-exporter.console.js.  It is
 * intentionally dependency-free and uses only the DOM of the currently open
 * Reddit Chat room.  It makes no network requests and never changes a chat.
 */
async function runRedditChatExporter() {
  if (!isRedditChatRoom(location)) {
    throw new Error('Open one Reddit Chat room (reddit.com/chat/room/…) before running the exporter.');
  }

  const controller = new AbortController();
  const progress = createProgressOverlay(controller);
  let downloadsStarted = 0;
  try {
    progress.update('Finding the visible chat…');
    const result = await collectChatWithThreads(document, {
      signal: controller.signal,
      maxScrollSteps: 160,
      settle: () => wait(175),
      onMessage: (message) => progress.update(`Reading messages (${messageCountHint()})…`),
    });
    if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Cancelled', 'AbortError');

    progress.update('Redacting names and private identifiers…');
    const exported = createPrivateExport({ messages: result.messages });
    const warnings = result.warnings?.filter(Boolean) ?? [];
    if (warnings.length) exported.warnings = warnings;

    progress.update('Preparing local downloads…');
    throwIfConsoleExportAborted(controller.signal);
    downloadText(toCanonicalJson(exported), createDownloadFilename('json'), 'application/json');
    downloadsStarted += 1;
    // Let the first browser download registration finish before the second.
    await wait(80);
    throwIfConsoleExportAborted(controller.signal);
    downloadText(toMarkdown(exported), createDownloadFilename('markdown'), 'text/markdown');
    downloadsStarted += 1;
    throwIfConsoleExportAborted(controller.signal);
    progress.done(`Saved ${exported.messages.length} top-level message${exported.messages.length === 1 ? '' : 's'} as JSON and Markdown.`);
    return exported;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      progress.done(cancellationMessage(downloadsStarted));
      return null;
    }
    progress.fail(`Export stopped: ${error?.message ?? 'unknown error'}`);
    throw error;
  }
}

function isRedditChatRoom(url) {
  return /(^|\.)reddit\.com$/i.test(url.hostname) && /^\/chat\/room\/[^/?#]+/.test(url.pathname);
}

function downloadText(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.documentElement.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createProgressOverlay(controller) {
  const host = document.createElement('div');
  host.setAttribute('role', 'status');
  host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;width:min(360px,calc(100vw - 32px));padding:14px 14px 12px;border:1px solid #666;border-radius:12px;background:#181818;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 28px #0009';
  const message = document.createElement('div');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.style.cssText = 'margin-top:10px;border:0;border-radius:7px;padding:7px 10px;background:#d93a00;color:#fff;font:inherit;cursor:pointer';
  cancel.onclick = () => controller.abort(new DOMException('Cancelled by user', 'AbortError'));
  host.append(message, cancel);
  document.documentElement.append(host);
  const finish = (text, error) => {
    message.textContent = text;
    cancel.remove();
    if (error) host.style.borderColor = '#e34b4b';
    setTimeout(() => host.remove(), 7000);
  };
  return {
    update: (text) => { message.textContent = text; },
    done: (text) => finish(text, false),
    fail: (text) => finish(text, true),
  };
}

function messageCountHint() {
  return document.querySelectorAll('[data-event-id], [data-message-id]').length || 'visible';
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function throwIfConsoleExportAborted(signal) {
  if (signal.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
}

function cancellationMessage(downloadsStarted) {
  if (downloadsStarted === 0) return 'Export cancelled. No files were saved.';
  if (downloadsStarted === 1) return 'Export cancelled. The JSON file may already be saved; remaining downloads were stopped.';
  return 'Export cancelled. JSON and Markdown files may already be saved.';
}

runRedditChatExporter().catch((error) => console.error('[Private Reddit chat exporter]', error));

})();
