/* global chrome */

const MENU_ROOT = 'private-reddit-chat-export';
const LINKEDIN_MENU_ROOT = 'private-linkedin-export';
let installingMenus = false;

function installMenus() {
  if (installingMenus) return;
  installingMenus = true;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ROOT, title: 'Export current Reddit chat', contexts: ['page'], documentUrlPatterns: ['https://www.reddit.com/chat/*'] });
    chrome.contextMenus.create({ id: `${MENU_ROOT}-json`, parentId: MENU_ROOT, title: 'As JSON', contexts: ['page'], documentUrlPatterns: ['https://www.reddit.com/chat/*'] });
    chrome.contextMenus.create({ id: `${MENU_ROOT}-markdown`, parentId: MENU_ROOT, title: 'As Markdown', contexts: ['page'], documentUrlPatterns: ['https://www.reddit.com/chat/*'] });
    chrome.contextMenus.create({ id: LINKEDIN_MENU_ROOT, title: 'Export LinkedIn page', contexts: ['page'], documentUrlPatterns: ['https://www.linkedin.com/*'] });
    chrome.contextMenus.create({ id: `${LINKEDIN_MENU_ROOT}-json`, parentId: LINKEDIN_MENU_ROOT, title: 'Profile or chat as JSON', contexts: ['page'], documentUrlPatterns: ['https://www.linkedin.com/*'] });
    chrome.contextMenus.create({ id: `${LINKEDIN_MENU_ROOT}-markdown`, parentId: LINKEDIN_MENU_ROOT, title: 'Profile or chat as Markdown', contexts: ['page'], documentUrlPatterns: ['https://www.linkedin.com/*'] });
    installingMenus = false;
  });
}

chrome.runtime.onInstalled.addListener(installMenus);
chrome.runtime.onStartup.addListener(installMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const linkedInFormat = info.menuItemId === `${LINKEDIN_MENU_ROOT}-json` ? 'json' : info.menuItemId === `${LINKEDIN_MENU_ROOT}-markdown` ? 'markdown' : null;
  if (linkedInFormat && tab?.id) {
    exportLinkedInAcrossFrames(tab.id, linkedInFormat).catch(() => {});
    return;
  }
  const format = info.menuItemId === `${MENU_ROOT}-json` ? 'json' : info.menuItemId === `${MENU_ROOT}-markdown` ? 'markdown' : null;
  if (!format || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'private-reddit-chat-export', format, labels: {} }).catch(() => {});
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!['private-reddit-chat-bulk-export', 'private-linkedin-coordinated-export'].includes(request?.type)) return undefined;
  const operation = request.type === 'private-linkedin-coordinated-export'
    ? exportLinkedInAcrossFrames(request.tabId ?? _sender.tab?.id, request.format)
    : bulkExportLoadedChats(request);
  operation
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Export could not start.', diagnostics: error?.diagnostics ?? null }));
  return true;
});

async function exportLinkedInAcrossFrames(tabId, format = 'json') {
  if (!Number.isInteger(tabId)) throw new Error('Open the LinkedIn page you want to export.');
  let frames = await linkedInFrames(tabId);
  let probed = await probeLinkedInFrames(tabId, frames);
  let injectionAttempted = false; let framesInjected = 0;
  // Reloading an unpacked extension invalidates existing content-script
  // listeners but leaves their injected page controls behind in Safari.
  // Reinject once when no frame can answer, then probe the fresh contexts.
  if (!probed.responses) {
    injectionAttempted = true;
    try {
      const injected = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
      framesInjected = injected?.length ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 150));
      frames = await linkedInFrames(tabId);
      probed = await probeLinkedInFrames(tabId, frames);
    } catch { /* diagnostics below distinguish failed reinjection */ }
  }
  const probes = probed.probes;
  const usable = probes.filter((probe) => probe.mode !== 'unsupported');
  const selected = usable.sort((a, b) => linkedInProbeScore(b) - linkedInProbeScore(a))[0];
  const aggregate = {
    framesFound: frames.length,
    framesResponded: probed.responses,
    framesProbedSuccessfully: probes.length,
    frameInitializationErrors: probed.initializationErrors,
    unreachableFrames: probed.unreachable,
    injectionAttempted,
    framesInjected,
    readableLinkedInFrames: usable.length,
    framesWithMessages: usable.filter((probe) => Number(probe.diagnostics?.messagesCollected) > 0).length,
  };
  if (!selected) throw diagnosticError('No readable LinkedIn document was found. Automatic reinjection was attempted; copy safe diagnostics if this persists.', aggregate);
  const response = await chrome.tabs.sendMessage(tabId, { type: 'private-social-export', format }, { frameId: selected.frameId });
  const diagnostics = { ...aggregate, ...(response?.diagnostics ?? {}) };
  if (!response?.ok) throw diagnosticError(response?.error ?? 'The selected LinkedIn frame could not be exported.', diagnostics);
  return { ...response, diagnostics };
}

async function linkedInFrames(tabId) {
  try { return await chrome.webNavigation.getAllFrames({ tabId }) || [{ frameId: 0 }]; }
  catch { return [{ frameId: 0 }]; }
}

async function probeLinkedInFrames(tabId, frames) {
  const probes = []; let responses = 0; let initializationErrors = 0; let unreachable = 0;
  for (const frame of frames) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'private-linkedin-probe' }, { frameId: frame.frameId });
      responses += 1;
      if (response?.ok) probes.push({ frameId: frame.frameId, ...response });
      else initializationErrors += 1;
    } catch { unreachable += 1; }
  }
  return { probes, responses, initializationErrors, unreachable };
}

function linkedInProbeScore(probe) {
  const diagnostics = probe.diagnostics ?? {};
  return Number(diagnostics.messagesCollected ?? 0) * 10_000
    + Object.entries(diagnostics).filter(([key]) => key.startsWith('candidateFamily')).reduce((sum, [, value]) => sum + Number(value || 0), 0) * 100
    + Number(diagnostics.sectionsCollected ?? 0) * 10
    + (diagnostics.isTopFrame ? 1 : 0);
}

function diagnosticError(message, diagnostics) {
  const error = new Error(message);
  error.diagnostics = diagnostics;
  return error;
}

async function bulkExportLoadedChats({ tabId, format = 'json', dedupeExact = false }) {
  if (!Number.isInteger(tabId)) throw new Error('Open the Reddit Chat tab you want to export.');
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith('https://www.reddit.com/chat/')) throw new Error('Open Reddit Chat before using bulk export.');
  const originalUrl = tab.url;
  const listed = await sendWhenReady(tabId, { type: 'private-reddit-chat-list-rooms' });
  const rooms = [...new Set(listed?.rooms ?? [])].slice(0, 20);
  if (!rooms.length) throw new Error('No loaded chat rooms were found in the sidebar.');

  const totals = { attempted: 0, completed: 0, skipped: 0, messages: 0 };
  const roomsIndex = [];
  try {
    for (const [index, room] of rooms.entries()) {
      totals.attempted += 1;
      try {
        const loaded = waitForTabComplete(tabId, room, 20_000);
        await chrome.tabs.update(tabId, { url: room });
        await loaded;
        const result = await sendWhenReady(tabId, {
          type: 'private-reddit-chat-export', format, labels: {}, dedupeExact,
          filenameSuffix: `bulk-${String(index + 1).padStart(3, '0')}`,
        }, 20_000);
        totals.completed += 1;
        totals.messages += Number(result?.count ?? 0);
        roomsIndex.push({ roomNumber: index + 1, status: 'exported', stats: result?.stats ?? {} });
      } catch {
        totals.skipped += 1;
        roomsIndex.push({ roomNumber: index + 1, status: 'skipped', stats: {} });
      }
    }
  } finally {
    await chrome.tabs.update(tabId, { url: originalUrl }).catch(() => {});
  }
  await waitForTabComplete(tabId, originalUrl, 20_000).catch(() => {});
  await sendWhenReady(tabId, { type: 'private-reddit-chat-download-index', index: { schemaVersion: '1.0', title: 'Private chat bulk index', exportedAt: new Date().toISOString(), summary: totals, rooms: roomsIndex } }).catch(() => {});
  return totals;
}

function waitForTabComplete(tabId, targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Timed out while opening a chat.')), timeoutMs);
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      if (tab.url?.replace(/[?#].*$/, '') !== targetUrl.replace(/[?#].*$/, '')) return;
      finish();
    };
    const finish = (error) => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendWhenReady(tabId, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (!response?.ok) throw new Error(response?.error ?? 'The chat page did not respond.');
      return response;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The chat page did not become ready.');
}
