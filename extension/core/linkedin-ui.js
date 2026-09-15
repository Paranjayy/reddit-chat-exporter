// Local DOM-only LinkedIn extractors. Identity preservation is intentional:
// users choose manual redaction for their own LinkedIn exports.
export async function expandLinkedInPage(root = document) {
  const controls = [...root.querySelectorAll('button, [role="button"]')]
    .filter((node) => /show more|see more|show all|expand/i.test(`${node.getAttribute('aria-label') ?? ''} ${node.textContent ?? ''}`));
  for (const control of controls) { control.click(); await new Promise((resolve) => setTimeout(resolve, 180)); }
  return controls.length;
}

const MESSAGE_SELECTORS = [
  '.msg-s-event-listitem',
  '[data-event-urn]',
  '[data-testid*="message" i]',
  '[data-test-id*="message" i]',
  '[data-urn*="message" i]',
  '.scaffold-finite-scroll__content > li',
  '[role="main"] [role="listitem"]',
];

export function detectLinkedInMode(url = location.href, root = document) {
  let path = '';
  try { path = new URL(url).pathname; } catch { /* an inherited about:blank frame */ }
  if (/^\/messaging\//.test(path)) return 'linkedin-chat-page';
  if (root.querySelector('.msg-overlay-conversation-bubble, .msg-overlay-list-bubble')) return 'linkedin-chat-popup';
  if (root.querySelector(MESSAGE_SELECTORS.join(', '))) return 'linkedin-chat-frame';
  if (/^\/in\//.test(path)) return 'linkedin-profile';
  return 'unsupported';
}

export function collectLinkedInProfile(root = document) {
  const text = (selector) => root.querySelector(selector)?.textContent?.trim() || null;
  return { type: 'linkedin-profile', exportedAt: new Date().toISOString(), name: text('h1'), headline: text('.text-body-medium'), location: text('.text-body-small'), sections: [...root.querySelectorAll('section')].map((section) => ({ heading: section.querySelector('h2')?.textContent?.trim() || 'Section', text: section.innerText?.trim() || section.textContent?.trim() || '' })).filter((section) => section.text) };
}

export function collectLinkedInChat(root = document) {
  const messages = collectLinkedInSnapshot(root).map(({ key: _key, ...message }) => message);
  return { type: 'linkedin-chat', exportedAt: new Date().toISOString(), messages };
}

/** Slowly loads older rendered events and merges every observed DOM snapshot. */
export async function collectLinkedInChatHistory(root = document, options = {}) {
  const maxScrollSteps = options.maxScrollSteps ?? 240;
  const settle = options.settle ?? waitForLinkedInChange;
  const onProgress = options.onProgress;
  const surface = findLinkedInScrollSurface(root);
  const messageByKey = new Map();
  const edges = new Map();
  const firstSeen = new Map();
  let seenSequence = 0; let stableAtTop = 0; let scrollSteps = 0; let snapshotsCollected = 0; let historyComplete = false;
  const initialBottomDistance = surface ? Math.max(0, Number(surface.scrollHeight) - Number(surface.clientHeight) - Number(surface.scrollTop)) : 0;

  const capture = () => {
    const snapshot = collectLinkedInSnapshot(root);
    snapshotsCollected += 1;
    for (const message of snapshot) {
      if (!firstSeen.has(message.key)) firstSeen.set(message.key, seenSequence++);
      const prior = messageByKey.get(message.key);
      messageByKey.set(message.key, richerMessage(prior, message));
      if (!edges.has(message.key)) edges.set(message.key, new Set());
    }
    for (let index = 1; index < snapshot.length; index += 1) edges.get(snapshot[index - 1].key).add(snapshot[index].key);
    return snapshot.length;
  };

  capture();
  if (surface) {
    for (let step = 0; step < maxScrollSteps; step += 1) {
      const before = { count: messageByKey.size, height: Number(surface.scrollHeight), top: Number(surface.scrollTop) };
      const delta = Math.max(Math.floor(Number(surface.clientHeight) * 0.8), 480);
      surface.scrollTop = Math.max(0, before.top - delta);
      surface.dispatchEvent?.(new Event('scroll', { bubbles: true }));
      scrollSteps += 1;
      await settle(root, surface, before);
      capture();
      const atTop = Number(surface.scrollTop) <= 1;
      const changed = messageByKey.size > before.count || Number(surface.scrollHeight) !== before.height;
      if (changed || scrollSteps === 1 || scrollSteps % 10 === 0) onProgress?.({ scrollSteps, messagesCollected: messageByKey.size, atTop, changed });
      stableAtTop = atTop && !changed ? stableAtTop + 1 : 0;
      if (stableAtTop >= 4) { historyComplete = true; break; }
    }
    surface.scrollTop = Math.max(0, Number(surface.scrollHeight) - Number(surface.clientHeight) - initialBottomDistance);
    surface.dispatchEvent?.(new Event('scroll', { bubbles: true }));
  }

  const orderedKeys = topologicalMessageOrder(messageByKey, edges, firstSeen);
  const messages = orderedKeys.map((key) => {
    const { key: _key, ...message } = messageByKey.get(key);
    return message;
  });
  onProgress?.({ scrollSteps, messagesCollected: messages.length, historyComplete, crawlFinished: true });
  return {
    data: { type: 'linkedin-chat', exportedAt: new Date().toISOString(), messages },
    diagnostics: { scrollSurfaceFound: Boolean(surface), scrollSteps, snapshotsCollected, historyComplete, messagesCollected: messages.length },
  };
}

export function toLinkedInMarkdown(data) {
  const exported = readableDate(data.exportedAt);
  if (data.type === 'linkedin-profile') {
    const sections = (data.sections ?? []).map((section) => `## ${headingText(section.heading || 'Section')}\n\n${section.text || '_No text captured._'}`).join('\n\n');
    return `# LinkedIn Profile Export\n\n- Exported: ${exported}\n- Sections: ${(data.sections ?? []).length}\n\n${sections}\n`;
  }
  const messages = (data.messages ?? []).map((message) => {
    const sender = headingText(message.sender || 'Unknown sender');
    const timestamp = message.timestamp ? ` — ${headingText(readableDate(message.timestamp))}` : '';
    const body = message.text || '_Attachment-only message._';
    const attachments = (message.attachments ?? []).map(markdownAttachment).filter(Boolean);
    return `## ${sender}${timestamp}\n\n${body}${attachments.length ? `\n\n### Attachments\n\n${attachments.join('\n')}` : ''}`;
  });
  return `# LinkedIn Chat Export\n\n- Exported: ${exported}\n- Messages: ${(data.messages ?? []).length}\n\n${messages.join('\n\n---\n\n')}\n`;
}

export async function createLinkedInZip(data, fetchAsset = fetchLinkedInAsset) {
  const files = [];
  const localByUrl = new Map();
  const failures = [];
  const urls = [...new Set((data.messages ?? []).flatMap((message) => (message.attachments ?? []).map((entry) => entry.url).filter(Boolean)))];
  for (const [index, url] of urls.entries()) {
    try {
      const result = await fetchAsset(url);
      const extension = fileExtension(result.type, url);
      const name = `assets/${String(index + 1).padStart(3, '0')}-${safeFilePart(urlFileName(url))}${extension}`;
      files.push({ name, data: await result.blob.arrayBuffer() });
      localByUrl.set(url, name);
    } catch {
      failures.push({});
    }
  }
  const portable = JSON.parse(JSON.stringify(data));
  for (const message of portable.messages ?? []) for (const attachment of message.attachments ?? []) {
    const localPath = localByUrl.get(attachment.url);
    if (localPath) attachment.localPath = localPath;
  }
  const markdownData = JSON.parse(JSON.stringify(portable));
  let markdown = toLinkedInMarkdown(markdownData);
  for (const [url, localPath] of localByUrl) markdown = markdown.replaceAll(`<${url}>`, `<${localPath}>`);
  files.unshift({ name: 'conversation.md', data: new TextEncoder().encode(markdown).buffer });
  files.splice(1, 0, { name: 'messages.json', data: new TextEncoder().encode(`${JSON.stringify(portable, null, 2)}\n`).buffer });
  files.splice(2, 0, { name: 'export-report.json', data: new TextEncoder().encode(`${JSON.stringify({ exportedAt: portable.exportedAt, messageCount: portable.messages?.length ?? 0, assetCount: urls.length, assetsFetched: localByUrl.size, assetsFailed: failures.length }, null, 2)}\n`).buffer });
  const archive = makeZip(files);
  archive.files = files.map(({ name }) => ({ name }));
  return archive;
}

async function fetchLinkedInAsset(url) {
  const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (!response.ok) throw new Error(`Attachment request failed: ${response.status}`);
  return { blob: await response.blob(), type: response.headers.get('content-type') || '' };
}

function fileExtension(type, url) {
  const mime = String(type).split(';')[0].toLowerCase();
  const known = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf', 'video/mp4': '.mp4' };
  if (known[mime]) return known[mime];
  try { return new URL(url).pathname.match(/\.[a-z0-9]{1,8}$/i)?.[0] || ''; } catch { return ''; }
}

function urlFileName(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'attachment').replace(/\.[a-z0-9]{1,8}$/i, '') || 'attachment'; } catch { return 'attachment'; }
}

function safeFilePart(value) { return String(value).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'attachment'; }

function makeZip(files) {
  const encoder = new TextEncoder(); const chunks = []; const central = []; let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name); const data = new Uint8Array(file.data); const crc = crc32(data);
    const header = new Uint8Array(30 + name.length); const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(8, 0, true); view.setUint16(10, 0, true); view.setUint16(14, 0, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint16(26, name.length, true); header.set(name, 30);
    chunks.push(header, data);
    const entry = new Uint8Array(46 + name.length); const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true); entryView.setUint16(4, 20, true); entryView.setUint16(6, 20, true); entryView.setUint32(16, crc, true); entryView.setUint32(20, data.length, true); entryView.setUint32(24, data.length, true); entryView.setUint16(28, name.length, true); entryView.setUint32(42, offset, true); entry.set(name, 46); central.push(entry); offset += header.length + data.length;
  }
  const centralBytes = concatBytes(central); const end = new Uint8Array(22); const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, files.length, true); endView.setUint16(10, files.length, true); endView.setUint32(12, centralBytes.length, true); endView.setUint32(16, offset, true);
  return new Blob([...chunks, centralBytes, end], { type: 'application/zip' });
}

function concatBytes(chunks) { const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; }
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }

export function createLinkedInDiagnostics(root = document, mode = detectLinkedInMode(location.href, root), isTopFrame = true) {
  const selectorCounts = Object.fromEntries(MESSAGE_SELECTORS.map((selector, index) => [
    `candidateFamily${index + 1}`,
    root.querySelectorAll(selector).length,
  ]));
  const collected = mode === 'linkedin-profile' ? collectLinkedInProfile(root).sections.length : collectLinkedInChat(root).messages.length;
  return {
    mode,
    isTopFrame,
    ...selectorCounts,
    listItems: root.querySelectorAll('li, [role="listitem"]').length,
    timeElements: root.querySelectorAll('time, [datetime]').length,
    iframeElements: root.querySelectorAll('iframe').length,
    dialogs: root.querySelectorAll('dialog, [role="dialog"]').length,
    attachmentCandidates: root.querySelectorAll('img, video, [data-testid*="attachment" i], [aria-label*="attachment" i]').length,
    messagesCollected: mode === 'linkedin-profile' ? 0 : collected,
    sectionsCollected: mode === 'linkedin-profile' ? collected : 0,
  };
}

function itemsContainAnotherCandidate(item) {
  return MESSAGE_SELECTORS.some((selector) => item.querySelector(selector));
}

function findMessageItems(root) {
  return [...new Set(MESSAGE_SELECTORS.flatMap((selector) => [...root.querySelectorAll(selector)]))]
    .filter((item) => !itemsContainAnotherCandidate(item));
}

function collectLinkedInSnapshot(root) {
  const occurrences = new Map(); let inheritedSender = null;
  return findMessageItems(root).map((item) => {
    const sender = item.querySelector('.msg-s-message-group__name, .msg-s-message-group__profile-link, [data-test-message-author-name], [data-entity-hovercard-id]')?.textContent?.trim() || null;
    if (sender) inheritedSender = sender;
    const timestamp = item.querySelector('time')?.getAttribute('datetime') || item.querySelector('time')?.textContent?.trim() || null;
    const body = item.querySelector('.msg-s-event-listitem__body, .msg-s-event-listitem__message-bubble, [data-testid*="message-body" i], [data-test-id*="message-body" i]');
    const text = body?.innerText?.trim() || body?.textContent?.trim() || item.innerText?.trim() || item.textContent?.trim() || '';
    const attachments = collectLinkedInAttachments(item);
    const signature = `${inheritedSender ?? ''}\u0000${timestamp ?? ''}\u0000${text}\u0000${attachments.map((entry) => entry.url).join('\u0000')}`;
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    const stableId = item.getAttribute('data-event-urn') || item.getAttribute('data-urn') || item.getAttribute('data-event-id') || item.getAttribute('data-message-id');
    return { key: stableId || `${signature}\u0000${occurrence}`, sender: inheritedSender, timestamp, text, attachments };
  }).filter((message) => (message.text || message.attachments.length) && !/^Messaging$/i.test(message.text));
}

function collectLinkedInAttachments(item) {
  const results = new Map();
  const explicitSelector = '.msg-s-event-listitem__attachment, .msg-s-event-listitem__attachment-item, .msg-s-event-listitem__image-container, .msg-s-event-listitem__gif, .msg-s-message-list__attachment, .msg-s-event-listitem__media, .update-components-image, .ivm-image-view-model, [data-testid*="attachment" i], [data-test-id*="attachment" i], [aria-label*="attachment" i]';
  const explicit = [...item.querySelectorAll(explicitSelector)];
  const candidates = new Set(explicit.flatMap((node) => [node, ...node.querySelectorAll('a[href], img, video, source') ]));
  for (const media of item.querySelectorAll('img, video, source')) {
    const width = Number(media.getBoundingClientRect?.().width ?? media.width ?? 0);
    const height = Number(media.getBoundingClientRect?.().height ?? media.height ?? 0);
    if ((width >= 96 || height >= 96) && !media.closest?.('a[href*="/in/"]')) candidates.add(media);
  }
  for (const link of item.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') || '';
    if (/media\.licdn\.com|\/dms\/|\.(?:pdf|docx?|xlsx?|pptx?|zip)(?:[?#]|$)/i.test(href)) candidates.add(link);
  }
  for (const node of candidates) {
    const sources = [node.currentSrc, node.getAttribute?.('src'), node.getAttribute?.('href'), srcFromSet(node.getAttribute?.('srcset')), backgroundImageUrl(node)];
    for (const source of sources) {
      const url = renderedHttpUrl(source);
      if (!url || results.has(url)) continue;
      const tag = String(node.tagName || '').toLowerCase();
      const gifContainer = Boolean(node.closest?.('.msg-s-event-listitem__gif')) || /\.gif(?:[?#]|$)/i.test(url);
      const type = gifContainer || tag === 'img' ? 'image' : tag === 'video' || tag === 'source' ? 'video' : /\.(?:png|jpe?g|gif|webp)(?:[?#]|$)/i.test(url) ? 'image' : 'file';
      const alt = String(node.getAttribute?.('alt') || node.getAttribute?.('aria-label') || (gifContainer ? 'LinkedIn GIF attachment' : type === 'image' ? 'LinkedIn image attachment' : 'LinkedIn attachment')).trim();
      results.set(url, { type, url, alt: alt.slice(0, 240) });
    }
  }
  return [...results.values()];
}

function findLinkedInScrollSurface(root) {
  const items = findMessageItems(root);
  const first = items[0];
  for (let node = first?.parentElement; node; node = node.parentElement) {
    const containsConversation = findMessageItems(node).length >= Math.min(items.length, 2);
    let overflow = '';
    try { overflow = getComputedStyle(node).overflowY; } catch { /* non-browser test root */ }
    const scrollableOverflow = /auto|scroll|overlay/i.test(overflow) || Number(node.scrollTop) > 0;
    if (containsConversation && scrollableOverflow && Number(node.scrollHeight) > Number(node.clientHeight) + 8) return node;
  }
  return [...root.querySelectorAll('.msg-s-message-list-content, .msg-s-message-list-container, [role="log"]')]
    .find((node) => Number(node.scrollHeight) > Number(node.clientHeight) + 8) || null;
}

async function waitForLinkedInChange(root, surface, before) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (findMessageItems(root).length !== before.count || Number(surface.scrollHeight) !== before.height || Number(surface.scrollTop) !== before.top) return;
  }
}

function richerMessage(prior, next) {
  if (!prior) return next;
  return {
    ...prior,
    sender: next.sender || prior.sender,
    timestamp: next.timestamp || prior.timestamp,
    text: next.text.length >= prior.text.length ? next.text : prior.text,
    attachments: [...new Map([...(prior.attachments ?? []), ...(next.attachments ?? [])].map((entry) => [entry.url, entry])).values()],
  };
}

function topologicalMessageOrder(messageByKey, edges, firstSeen) {
  const indegree = new Map([...messageByKey.keys()].map((key) => [key, 0]));
  for (const [from, targets] of edges) for (const target of targets) if (from !== target && indegree.has(target)) indegree.set(target, indegree.get(target) + 1);
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([key]) => key).sort((a, b) => firstSeen.get(a) - firstSeen.get(b));
  const ordered = [];
  while (ready.length) {
    const key = ready.shift(); ordered.push(key);
    for (const target of edges.get(key) ?? []) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) { ready.push(target); ready.sort((a, b) => firstSeen.get(a) - firstSeen.get(b)); }
    }
  }
  for (const key of messageByKey.keys()) if (!ordered.includes(key)) ordered.push(key);
  return ordered;
}

function renderedHttpUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return null;
  try { const url = new URL(candidate, location.href); return /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; }
}
function srcFromSet(value) { return String(value || '').split(',').at(-1)?.trim().split(/\s+/)[0] || ''; }
function backgroundImageUrl(node) {
  let value = node.getAttribute?.('style') || '';
  try { value += ` ${getComputedStyle(node).backgroundImage || ''}`; } catch { /* detached or test DOM */ }
  return value.match(/url\(["']?([^"')]+)["']?\)/i)?.[1] || '';
}
function headingText(value) { return String(value || '').replace(/[\r\n]+/g, ' ').replace(/#/g, '\\#').trim(); }
function readableDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value || 'Unknown time') : date.toLocaleString(); }
function markdownAttachment(entry) {
  if (!/^https?:\/\//i.test(entry?.url || '')) return '';
  const label = String(entry.alt || 'LinkedIn attachment').replace(/[\[\]\\]/g, '\\$&');
  return entry.type === 'image' ? `- ![${label}](<${entry.url}>)` : `- [${label}](<${entry.url}>)`;
}
