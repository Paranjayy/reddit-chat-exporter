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
  const items = [...new Set(MESSAGE_SELECTORS.flatMap((selector) => [...root.querySelectorAll(selector)]))]
    .filter((item) => !itemsContainAnotherCandidate(item));
  const messages = items.map((item) => ({ sender: item.querySelector('.msg-s-message-group__name, [data-test-message-author-name], [data-entity-hovercard-id]')?.textContent?.trim() || null, timestamp: item.querySelector('time')?.getAttribute('datetime') || item.querySelector('time')?.textContent?.trim() || null, text: item.innerText?.trim() || item.textContent?.trim() || '' })).filter((message) => message.text && !/^Messaging$/i.test(message.text));
  return { type: 'linkedin-chat', exportedAt: new Date().toISOString(), messages };
}

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
