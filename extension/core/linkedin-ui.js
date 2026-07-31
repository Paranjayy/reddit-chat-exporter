// Local DOM-only LinkedIn extractors. Identity preservation is intentional:
// users choose manual redaction for their own LinkedIn exports.
export async function expandLinkedInPage(root = document) {
  const controls = [...root.querySelectorAll('button, [role="button"]')]
    .filter((node) => /show more|see more|show all|expand/i.test(`${node.getAttribute('aria-label') ?? ''} ${node.textContent ?? ''}`));
  for (const control of controls) { control.click(); await new Promise((resolve) => setTimeout(resolve, 180)); }
  return controls.length;
}

export function detectLinkedInMode(url = location.href) {
  const path = new URL(url).pathname;
  if (/^\/messaging\//.test(path)) return 'linkedin-chat-page';
  if (document.querySelector('.msg-overlay-conversation-bubble, .msg-overlay-list-bubble')) return 'linkedin-chat-popup';
  if (/^\/in\//.test(path)) return 'linkedin-profile';
  return 'unsupported';
}

export function collectLinkedInProfile(root = document) {
  const text = (selector) => root.querySelector(selector)?.textContent?.trim() || null;
  return { type: 'linkedin-profile', exportedAt: new Date().toISOString(), name: text('h1'), headline: text('.text-body-medium'), location: text('.text-body-small'), sections: [...root.querySelectorAll('section')].map((section) => ({ heading: section.querySelector('h2')?.textContent?.trim() || 'Section', text: section.innerText?.trim() || section.textContent?.trim() || '' })).filter((section) => section.text) };
}

export function collectLinkedInChat(root = document) {
  const selectors = '.msg-s-event-listitem, [data-event-urn], [data-testid*="message"], [data-test-id*="message"], [data-urn*="message"], .scaffold-finite-scroll__content > li, [role="main"] [role="listitem"]';
  const items = [...root.querySelectorAll(selectors)];
  const messages = items.map((item) => ({ sender: item.querySelector('.msg-s-message-group__name, [data-test-message-author-name], [data-entity-hovercard-id]')?.textContent?.trim() || null, timestamp: item.querySelector('time')?.getAttribute('datetime') || item.querySelector('time')?.textContent?.trim() || null, text: item.innerText?.trim() || item.textContent?.trim() || '' })).filter((message) => message.text && !/^Messaging$/i.test(message.text));
  return { type: 'linkedin-chat', exportedAt: new Date().toISOString(), messages };
}
