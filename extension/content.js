/* global chrome */

// This is deliberately a classic content script: MV3 does not support a
// `type: module` content_scripts entry.  The two audited shared modules are
// loaded from this extension package only; this script never fetches anything.
const isLinkedInPage = /^https:\/\/(www\.)?linkedin\.com\//.test(location.href);
const core = isLinkedInPage ? null : Promise.all([
  import(chrome.runtime.getURL('core/exporter.js')),
  import(chrome.runtime.getURL('core/reddit-ui.js')),
]);

if (isLinkedInPage) {
  safeLinkedInLog('content-ready', { coreAvailable: Boolean(globalThis.__PRIVATE_SOCIAL_LINKEDIN_CORE__), isTopFrame: window.top === window });
  if (window.top === window) installLinkedInExportControl();
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!['private-reddit-chat-preview', 'private-reddit-chat-export', 'private-reddit-chat-list-rooms', 'private-reddit-chat-download-index', 'private-social-export', 'private-linkedin-probe'].includes(request?.type)) return undefined;

  const operation = request.type === 'private-linkedin-probe' ? probeLinkedInPage()
    : request.type === 'private-social-export' ? exportLinkedInPage(request)
    : request.type === 'private-reddit-chat-preview' ? previewCurrentChat()
    : request.type === 'private-reddit-chat-list-rooms' ? listLoadedRooms()
      : request.type === 'private-reddit-chat-download-index' ? downloadBulkIndex(request.index)
        : exportCurrentChat(request);
  operation
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      const diagnostics = { ...(error?.diagnostics ?? {}), failureStage: error?.failureStage ?? 'operation', failureName: error?.name ?? 'Error' };
      if (isLinkedInPage) safeLinkedInLog('operation-failed', diagnostics);
      sendResponse({ ok: false, error: friendlyError(error), diagnostics });
    });
  return true;
});

async function exportLinkedInPage({ format = 'json' } = {}) {
  const { detectLinkedInMode, expandLinkedInPage, collectLinkedInProfile, collectLinkedInChatHistory, createLinkedInDiagnostics, toLinkedInMarkdown } = requireLinkedInCore();
  const mode = await atLinkedInStage('mode-detection', () => detectLinkedInMode(location.href, document));
  if (mode === 'unsupported') throw new Error('Open a LinkedIn profile or chat before exporting.');
  safeLinkedInLog('export-started', { mode, isTopFrame: window.top === window });
  const expandedControls = await atLinkedInStage('expand-controls', () => expandLinkedInPage(document));
  const collected = mode === 'linkedin-profile'
    ? await atLinkedInStage('profile-collection', () => ({ data: collectLinkedInProfile(document), diagnostics: {} }))
    : await atLinkedInStage('history-crawl', () => collectLinkedInChatHistory(document, {
      onProgress: (details) => safeLinkedInLog('crawl-progress', details),
    }));
  const data = collected.data;
  const diagnostics = {
    ...createLinkedInDiagnostics(document, mode, window.top === window),
    ...collected.diagnostics,
    attachmentsCaptured: data.messages?.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0) ?? 0,
    expandedControls,
  };
  if (mode !== 'linkedin-profile' && !data.messages.length) {
    const error = new Error('No LinkedIn message frame was readable. Copy safe diagnostics and send those counts to Codex.');
    error.diagnostics = diagnostics;
    throw error;
  }
  const body = await atLinkedInStage('serialization', () => format === 'markdown' ? toLinkedInMarkdown(data) : `${JSON.stringify(data, null, 2)}\n`);
  downloadLocally(body, `linkedin-${mode}-${new Date().toISOString().slice(0, 10)}.${format === 'markdown' ? 'md' : 'json'}`, format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8');
  const warnings = mode !== 'linkedin-profile' && !diagnostics.historyComplete
    ? ['LinkedIn stopped changing before the oldest-history boundary could be confirmed; review the first exported message.']
    : [];
  safeLinkedInLog('export-complete', { mode, messagesCollected: diagnostics.messagesCollected ?? 0, attachmentsCaptured: diagnostics.attachmentsCaptured, historyComplete: diagnostics.historyComplete ?? false });
  return { count: data.messages?.length ?? data.sections?.length ?? 0, mode, diagnostics, warnings };
}

async function probeLinkedInPage() {
  const { detectLinkedInMode, createLinkedInDiagnostics } = requireLinkedInCore();
  const mode = await atLinkedInStage('probe-mode', () => detectLinkedInMode(location.href, document));
  const diagnostics = await atLinkedInStage('probe-collection', () => createLinkedInDiagnostics(document, mode, window.top === window));
  safeLinkedInLog('probe-complete', { mode, isTopFrame: diagnostics.isTopFrame, messagesCollected: diagnostics.messagesCollected });
  return { mode, diagnostics };
}

function requireLinkedInCore() {
  const value = globalThis.__PRIVATE_SOCIAL_LINKEDIN_CORE__;
  if (value) return value;
  const error = new Error('The LinkedIn collector did not initialize. Reload the extension and try again.');
  error.failureStage = 'core-bootstrap';
  throw error;
}

async function atLinkedInStage(stage, operation) {
  try { return await operation(); }
  catch (error) { if (error && !error.failureStage) error.failureStage = stage; throw error; }
}

function safeLinkedInLog(event, details = {}) {
  const allowed = Object.fromEntries(Object.entries(details).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)));
  console.info('[Private Social Export]', event, allowed);
}

function installLinkedInExportControl() {
  if (document.getElementById('private-social-export-control')) return;
  const control = document.createElement('button');
  control.id = 'private-social-export-control'; control.type = 'button';
  control.textContent = 'Export LinkedIn chat / profile';
  control.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;border:0;border-radius:999px;padding:10px 14px;background:#0a66c2;color:white;font:600 13px system-ui;box-shadow:0 3px 14px #0004;cursor:pointer';
  control.addEventListener('click', async () => {
    const original = control.textContent; control.disabled = true; control.textContent = 'Exporting…';
    try {
      const response = await chrome.runtime.sendMessage({ type: 'private-linkedin-coordinated-export', format: 'json' });
      if (!response?.ok) throw Object.assign(new Error(response?.error ?? 'Export failed'), { diagnostics: response?.diagnostics });
      control.textContent = `Saved ${response.mode.replace('linkedin-', '')}`;
    }
    catch (error) { control.textContent = error instanceof Error ? error.message : 'Export failed'; }
    setTimeout(() => { control.disabled = false; control.textContent = original; }, 2500);
  });
  document.documentElement.append(control);
}

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
