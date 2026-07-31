/* global chrome */

const form = document.querySelector('#export-form');
const button = document.querySelector('#export-button');
const previewButton = document.querySelector('#preview-button');
const status = document.querySelector('#status');
const labelsContainer = document.querySelector('#participant-labels');
const copyDiagnosticsButton = document.querySelector('#copy-diagnostics-button');
const bulkExportButton = document.querySelector('#bulk-export-button');
let discoveredParticipants = [];
let latestDiagnostics = null;

configurePopup();

previewButton.addEventListener('click', previewParticipants);
copyDiagnosticsButton.addEventListener('click', copyDiagnostics);
bulkExportButton.addEventListener('click', bulkExportLoadedChats);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  setStatus('Reading the visible chat and its reply threads…', 'working');
  try {
    const labels = readLabels();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(www\.)?(reddit\.com\/chat\/|linkedin\.com\/)/.test(tab.url)) {
      throw new Error('Open a supported Reddit chat or LinkedIn page, then use this button again.');
    }
    const isLinkedIn = /linkedin\.com\//.test(tab.url);
    const request = {
      type: isLinkedIn ? 'private-linkedin-coordinated-export' : 'private-reddit-chat-export',
      tabId: tab.id,
      format: new FormData(form).get('format'),
      labels,
      dedupeExact: new FormData(form).get('dedupeExact') === 'on',
    };
    const response = isLinkedIn ? await chrome.runtime.sendMessage(request) : await chrome.tabs.sendMessage(tab.id, request);
    latestDiagnostics = response?.diagnostics ?? null;
    showDiagnosticsButton();
    if (!response?.ok) throw new Error(response?.error ?? 'The chat export did not finish.');
    const warning = response.warnings?.[0];
    setStatus(`Downloaded ${response.count} message${response.count === 1 ? '' : 's'}.${warning ? ` ${warning}` : ''}`, warning ? 'warning' : 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'The chat could not be exported.', 'error');
  } finally {
    button.disabled = false;
  }
});

async function bulkExportLoadedChats() {
  setBusy(true);
  setStatus('Exporting chats currently loaded in the sidebar…', 'working');
  try {
    const tab = await currentChatTab();
    const response = await chrome.runtime.sendMessage({
      type: 'private-reddit-chat-bulk-export', tabId: tab.id,
      format: new FormData(form).get('format'), dedupeExact: new FormData(form).get('dedupeExact') === 'on',
    });
    if (!response?.ok) throw new Error(response?.error ?? 'Bulk export did not finish.');
    setStatus(`Bulk export: ${response.completed}/${response.attempted} chats downloaded, ${response.messages} messages; ${response.skipped} skipped.`, response.skipped ? 'warning' : 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Bulk export did not finish.', 'error');
  } finally {
    setBusy(false);
  }
}

function readLabels() {
  return Object.fromEntries([...labelsContainer.querySelectorAll('input[data-participant-id]')]
    .map((input) => [input.dataset.participantId, input.value.trim()])
    .filter(([, label]) => label));
}

async function previewParticipants() {
  previewButton.disabled = true;
  setStatus('Reading the visible chat and its reply threads…', 'working');
  try {
    const tab = await currentChatTab();
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'private-reddit-chat-preview' });
    if (!response?.ok) throw new Error(response?.error ?? 'The participant preview did not finish.');
    discoveredParticipants = response.participants ?? [];
    latestDiagnostics = response.diagnostics ?? null;
    showDiagnosticsButton();
    if (!discoveredParticipants.length) {
      setStatus('Reddit has not exposed sender labels yet. You can still export with neutral names.', 'warning');
      return;
    }
    renderParticipantLabels(discoveredParticipants);
    setStatus(`${discoveredParticipants.length} participant${discoveredParticipants.length === 1 ? '' : 's'} found locally. Choose labels or export with neutral names.`, 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'The participant preview could not finish.', 'error');
  } finally {
    previewButton.disabled = false;
  }
}

async function copyDiagnostics() {
  if (!latestDiagnostics) return;
  const lines = ['Private Social Export safe diagnostics'];
  for (const [key, value] of Object.entries(latestDiagnostics)) lines.push(`${key}: ${value}`);
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    setStatus('Safe diagnostics copied. It contains counts only—no chat text or identifiers.', 'success');
  } catch {
    setStatus('Could not copy diagnostics in this browser.', 'warning');
  }
}

function showDiagnosticsButton() { copyDiagnosticsButton.hidden = !latestDiagnostics; }

function renderParticipantLabels(participants) {
  labelsContainer.replaceChildren(...participants.map((participant, index) => {
    const label = document.createElement('label');
    const description = document.createElement('span');
    description.textContent = `${displayHandle(participant.handle)} → ${participant.fallbackLabel}`;
    const input = document.createElement('input');
    input.name = `participant-label-${index}`;
    input.dataset.participantId = participant.id;
    input.type = 'text';
    input.maxLength = 80;
    input.autocomplete = 'off';
    input.placeholder = participant.fallbackLabel || `Person ${letterSequence(index)}`;
    label.append(description, input);
    return label;
  }));
}

function displayHandle(handle) {
  return /^u\//i.test(handle) ? handle : `u/${handle}`;
}

async function currentChatTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith('https://www.reddit.com/chat/')) {
    throw new Error('Open the Reddit chat you want to save, then use this button again.');
  }
  return tab;
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

function setStatus(message, state = '') {
  status.textContent = message;
  status.dataset.state = state;
}

function setBusy(busy) {
  button.disabled = busy;
  previewButton.disabled = busy;
  bulkExportButton.disabled = busy;
}

async function configurePopup() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/linkedin\.com\//.test(tab?.url ?? '')) return;
  document.querySelector('h1').textContent = 'Export this LinkedIn page.';
  document.querySelector('.lede').textContent = 'Profile, full chat, or an open messaging popup is read locally. Nothing is sent anywhere.';
  button.innerHTML = 'Export LinkedIn page <span aria-hidden="true">↓</span>';
  previewButton.hidden = true;
  bulkExportButton.hidden = true;
  document.querySelector('#participant-labels').closest('fieldset').hidden = true;
}
