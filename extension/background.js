/* global chrome */

const MENU_ROOT = 'private-reddit-chat-export';
let installingMenus = false;

function installMenus() {
  if (installingMenus) return;
  installingMenus = true;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ROOT, title: 'Export current Reddit chat', contexts: ['page'], documentUrlPatterns: ['https://www.reddit.com/chat/*'] });
    chrome.contextMenus.create({ id: `${MENU_ROOT}-json`, parentId: MENU_ROOT, title: 'As JSON', contexts: ['page'], documentUrlPatterns: ['https://www.reddit.com/chat/*'] });
    chrome.contextMenus.create({ id: `${MENU_ROOT}-markdown`, parentId: MENU_ROOT, title: 'As Markdown', contexts: ['page'], documentUrlPatterns: ['https://www.reddit.com/chat/*'] });
    installingMenus = false;
  });
}

chrome.runtime.onInstalled.addListener(installMenus);
chrome.runtime.onStartup.addListener(installMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const format = info.menuItemId === `${MENU_ROOT}-json` ? 'json' : info.menuItemId === `${MENU_ROOT}-markdown` ? 'markdown' : null;
  if (!format || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'private-reddit-chat-export', format, labels: {} }).catch(() => {});
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type !== 'private-reddit-chat-bulk-export') return undefined;
  bulkExportLoadedChats(request)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Bulk export could not start.' }));
  return true;
});

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
