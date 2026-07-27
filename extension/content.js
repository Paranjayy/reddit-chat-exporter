/* global chrome */

// This is deliberately a classic content script: MV3 does not support a
// `type: module` content_scripts entry.  The two audited shared modules are
// loaded from this extension package only; this script never fetches anything.
const core = Promise.all([
  import(chrome.runtime.getURL('core/exporter.js')),
  import(chrome.runtime.getURL('core/reddit-ui.js')),
]);

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!['private-reddit-chat-preview', 'private-reddit-chat-export', 'private-reddit-chat-list-rooms', 'private-reddit-chat-download-index'].includes(request?.type)) return undefined;

  const operation = request.type === 'private-reddit-chat-preview' ? previewCurrentChat()
    : request.type === 'private-reddit-chat-list-rooms' ? listLoadedRooms()
      : request.type === 'private-reddit-chat-download-index' ? downloadBulkIndex(request.index)
        : exportCurrentChat(request);
  operation
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
  return true;
});

async function exportCurrentChat({ format = 'json', labels = {}, dedupeExact = false, filenameSuffix = '' } = {}) {
  const [{ createPrivateExport, removeExactDuplicates, toCanonicalJson, toMarkdown, createDownloadFilename }, { collectChatWithThreads }] = await core;
  const collected = await getCurrentChat(collectChatWithThreads);
  if (!collected.messages.length) {
    throw new Error('No messages are visible yet. Open a Reddit chat, wait for it to load, then try again.');
  }

  let exportData = createPrivateExport({ messages: collected.messages });
  applyLocalLabels(exportData, labels);
  const dedupe = dedupeExact ? removeExactDuplicates(exportData) : { exportData, removed: 0 };
  exportData = dedupe.exportData;
  const body = format === 'markdown' ? toMarkdown(exportData) : toCanonicalJson(exportData);
  const filename = createDownloadFilename(format, new Date(), filenameSuffix);
  downloadLocally(body, filename, format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8');
  return {
    count: exportData.messages.length,
    stats: exportData.stats,
    warnings: collected.warnings ?? [],
    diagnostics: { ...(collected.diagnostics ?? {}), exactDuplicatesRemoved: dedupe.removed },
  };
}

async function downloadBulkIndex(index) {
  const [{ toCanonicalJson, createDownloadFilename }] = await core;
  downloadLocally(toCanonicalJson(index), createDownloadFilename('json', new Date(), 'bulk-index'), 'application/json;charset=utf-8');
  return { count: index?.rooms?.length ?? 0 };
}

async function listLoadedRooms() {
  const [, { findLoadedRoomLinks }] = await core;
  return { rooms: findLoadedRoomLinks(document) };
}

async function previewCurrentChat() {
  const [{ createLocalParticipantPreview }, { collectChatWithThreads }] = await core;
  const collected = await getCurrentChat(collectChatWithThreads);
  if (!collected.messages.length) {
    throw new Error('No messages are visible yet. Open a Reddit chat, wait for it to load, then try again.');
  }
  // Handles are returned only to the open popup to make a one-off label
  // choice. They are never placed in an exported object or diagnostics.
  return {
    participants: createLocalParticipantPreview(collected.messages),
    count: collected.messages.length,
    diagnostics: collected.diagnostics ?? {},
  };
}

function applyLocalLabels(exportData, labels) {
  for (const participant of exportData.participants ?? []) {
    const label = String(labels?.[participant.id] ?? '').trim();
    if (label) participant.label = label.slice(0, 80);
  }
}

async function getCurrentChat(collectChatWithThreads) {
  const cache = getCurrentChat.cache;
  if (cache?.path === location.pathname && cache.expiresAt > Date.now()) return cache.collected;
  const collected = await collectChatWithThreads(document);
  // Raw participant tokens remain only in this page's memory for a short
  // preview-to-export handoff. They are not logged or persisted.
  getCurrentChat.cache = { path: location.pathname, collected, expiresAt: Date.now() + 120_000 };
  return collected;
}

function downloadLocally(body, filename, type) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.documentElement.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function friendlyError(error) {
  return error instanceof Error ? error.message : 'The current chat could not be exported.';
}
