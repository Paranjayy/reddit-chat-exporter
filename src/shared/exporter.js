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
export function createPrivateExport(input = {}, options = {}) {
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

  return {
    schemaVersion: '1.0',
    title: 'Private chat export',
    exportedAt: normaliseTimestamp(options.exportedAt) ?? new Date().toISOString(),
    redaction: { ...DEFAULT_REDACTION },
    participants,
    messages: messages.map(normaliseMessage),
  };
}

/**
 * Transient UI-only mapping aid. Callers must never serialise or persist this
 * return value: its handles are deliberately excluded from export data.
 */
export function createLocalParticipantPreview(messages = []) {
  return [...collectSenderTokens(messages)].sort(compareText)
    .map((handle, index) => ({ id: personId(index), handle, fallbackLabel: personLabel(index) }));
}

export function toCanonicalJson(exportData) {
  return `${JSON.stringify(sortKeys(exportData), null, 2)}\n`;
}

/** Remove only exact, already-sanitized duplicates within the same thread level. */
export function removeExactDuplicates(exportData) {
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
  return { exportData: { ...exportData, messages: visit(exportData.messages) }, removed };
}

export function toMarkdown(exportData) {
  const lines = ['# Private chat export', '', `Exported: ${formatMarkdownTimestamp(exportData.exportedAt)}`, ''];
  const names = new Map((exportData.participants ?? []).map((person) => [person.id, person.label]));

  for (const message of exportData.messages ?? []) renderMessage(message, 2, names, lines);
  return `${lines.join('\n').trimEnd()}\n`;
}

export function createDownloadFilename(format, date = new Date(), suffix = '') {
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

export function isReliableSenderToken(value) {
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
