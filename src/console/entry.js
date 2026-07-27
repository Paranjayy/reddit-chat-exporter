/*
 * This module is bundled into dist/reddit-chat-exporter.console.js.  It is
 * intentionally dependency-free and uses only the DOM of the currently open
 * Reddit Chat room.  It makes no network requests and never changes a chat.
 */
async function runRedditChatExporter() {
  if (!isRedditChatRoom(location)) {
    throw new Error('Open one Reddit Chat room (reddit.com/chat/room/…) before running the exporter.');
  }

  const controller = new AbortController();
  const progress = createProgressOverlay(controller);
  let downloadsStarted = 0;
  try {
    progress.update('Finding the visible chat…');
    const result = await collectChatWithThreads(document, {
      signal: controller.signal,
      maxScrollSteps: 160,
      settle: () => wait(175),
      onMessage: (message) => progress.update(`Reading messages (${messageCountHint()})…`),
    });
    if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Cancelled', 'AbortError');

    progress.update('Redacting names and private identifiers…');
    const exported = createPrivateExport({ messages: result.messages });
    const warnings = result.warnings?.filter(Boolean) ?? [];
    if (warnings.length) exported.warnings = warnings;

    progress.update('Preparing local downloads…');
    throwIfConsoleExportAborted(controller.signal);
    downloadText(toCanonicalJson(exported), createDownloadFilename('json'), 'application/json');
    downloadsStarted += 1;
    // Let the first browser download registration finish before the second.
    await wait(80);
    throwIfConsoleExportAborted(controller.signal);
    downloadText(toMarkdown(exported), createDownloadFilename('markdown'), 'text/markdown');
    downloadsStarted += 1;
    throwIfConsoleExportAborted(controller.signal);
    progress.done(`Saved ${exported.messages.length} top-level message${exported.messages.length === 1 ? '' : 's'} as JSON and Markdown.`);
    return exported;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      progress.done(cancellationMessage(downloadsStarted));
      return null;
    }
    progress.fail(`Export stopped: ${error?.message ?? 'unknown error'}`);
    throw error;
  }
}

function isRedditChatRoom(url) {
  return /(^|\.)reddit\.com$/i.test(url.hostname) && /^\/chat\/room\/[^/?#]+/.test(url.pathname);
}

function downloadText(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.documentElement.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createProgressOverlay(controller) {
  const host = document.createElement('div');
  host.setAttribute('role', 'status');
  host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;width:min(360px,calc(100vw - 32px));padding:14px 14px 12px;border:1px solid #666;border-radius:12px;background:#181818;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 28px #0009';
  const message = document.createElement('div');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.style.cssText = 'margin-top:10px;border:0;border-radius:7px;padding:7px 10px;background:#d93a00;color:#fff;font:inherit;cursor:pointer';
  cancel.onclick = () => controller.abort(new DOMException('Cancelled by user', 'AbortError'));
  host.append(message, cancel);
  document.documentElement.append(host);
  const finish = (text, error) => {
    message.textContent = text;
    cancel.remove();
    if (error) host.style.borderColor = '#e34b4b';
    setTimeout(() => host.remove(), 7000);
  };
  return {
    update: (text) => { message.textContent = text; },
    done: (text) => finish(text, false),
    fail: (text) => finish(text, true),
  };
}

function messageCountHint() {
  return document.querySelectorAll('[data-event-id], [data-message-id]').length || 'visible';
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function throwIfConsoleExportAborted(signal) {
  if (signal.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
}

function cancellationMessage(downloadsStarted) {
  if (downloadsStarted === 0) return 'Export cancelled. No files were saved.';
  if (downloadsStarted === 1) return 'Export cancelled. The JSON file may already be saved; remaining downloads were stopped.';
  return 'Export cancelled. JSON and Markdown files may already be saved.';
}

runRedditChatExporter().catch((error) => console.error('[Private Reddit chat exporter]', error));
