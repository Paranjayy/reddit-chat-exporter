/* global chrome */

// This is deliberately a classic content script: MV3 does not support a
// `type: module` content_scripts entry.  The two audited shared modules are
// loaded from this extension package only; this script never fetches anything.
const core = Promise.all([
  import(chrome.runtime.getURL('core/exporter.js')),
  import(chrome.runtime.getURL('core/reddit-ui.js')),
]);
const linkedinCore = import(chrome.runtime.getURL('core/linkedin-ui.js'));

if (/^https:\/\/(www\.)?linkedin\.com\//.test(location.href) && window.top === window) installLinkedInExportControl();

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
    .catch((error) => sendResponse({ ok: false, error: friendlyError(error), diagnostics: error?.diagnostics ?? null }));
  return true;
});

async function exportLinkedInPage({ format = 'json' } = {}) {
  const { detectLinkedInMode, expandLinkedInPage, collectLinkedInProfile, collectLinkedInChat, createLinkedInDiagnostics } = await linkedinCore;
  const mode = detectLinkedInMode(location.href, document);
  if (mode === 'unsupported') throw new Error('Open a LinkedIn profile or chat before exporting.');
  const expandedControls = await expandLinkedInPage(document);
  const data = mode === 'linkedin-profile' ? collectLinkedInProfile(document) : collectLinkedInChat(document);
  const diagnostics = { ...createLinkedInDiagnostics(document, mode, window.top === window), expandedControls };
  if (mode !== 'linkedin-profile' && !data.messages.length) {
    const error = new Error('No LinkedIn message frame was readable. Copy safe diagnostics and send those counts to Codex.');
    error.diagnostics = diagnostics;
    throw error;
  }
  const body = format === 'markdown' ? `# LinkedIn export\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n` : `${JSON.stringify(data, null, 2)}\n`;
  downloadLocally(body, `linkedin-${mode}-${new Date().toISOString().slice(0, 10)}.${format === 'markdown' ? 'md' : 'json'}`, format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8');
  return { count: data.messages?.length ?? data.sections?.length ?? 0, mode, diagnostics };
}

async function probeLinkedInPage() {
  const { detectLinkedInMode, createLinkedInDiagnostics } = await linkedinCore;
  const mode = detectLinkedInMode(location.href, document);
  return { mode, diagnostics: createLinkedInDiagnostics(document, mode, window.top === window) };
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
