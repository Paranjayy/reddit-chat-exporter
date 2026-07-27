# Reddit Chat Exporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create private console and extension exports of the current Reddit chat, including reply threads.

**Architecture:** A dependency-free shared module extracts and sanitizes rendered UI; thin console and MV3 extension wrappers provide the two entry points. Tests use synthetic data and do not contain chat content.

**Tech Stack:** JavaScript ES modules, Node built-in test runner, Chromium Manifest V3.

---

### Task 1: Core data and export module

**Files:**
- Create: `package.json`
- Create: `src/shared/exporter.js`
- Create: `test/exporter.test.mjs`

- [ ] Implement deterministic aliases, local IDs, default redaction, JSON/Markdown rendering, and neutral download filenames.
- [ ] Test no raw username, source URL, room ID, or event ID survives the default export.
- [ ] Run `npm test` and commit `feat: add private export core`.

### Task 2: Reddit UI collector with reply threads

**Files:**
- Create: `src/shared/reddit-ui.js`
- Create: `test/reddit-ui.test.mjs`
- Modify: `src/shared/exporter.js`

- [ ] Traverse open shadow roots; locate the main and active thread timelines; collect virtualized event IDs with bounded scrolling and deduplication.
- [ ] Open each visible reply control, collect the side-panel thread, then close it; record a generic incomplete warning on failures.
- [ ] Test repeated virtual windows, thread success/failure, cancellation, and bounded termination with synthetic adapters.
- [ ] Run `npm test` and commit `feat: collect main chats and reply threads`.

### Task 3: Console script and standalone bundle

**Files:**
- Create: `src/console/reddit-chat-exporter.js`
- Create: `scripts/build-console.mjs`
- Modify: `package.json`

- [ ] Validate the current page, show non-sensitive progress, and download JSON plus Markdown using neutral aliases.
- [ ] Bundle to `dist/reddit-chat-exporter.console.js` as a pasteable IIFE without dependencies.
- [ ] Run `npm test && npm run build:console` and commit `feat: add console chat exporter`.

### Task 4: Chromium extension

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/content.js`
- Create: `extension/popup.html`
- Create: `extension/popup.js`
- Create: `extension/styles.css`

- [ ] Keep permissions to `activeTab` and `storage`; declare no host permissions outside Reddit chat content injection and no networking permissions.
- [ ] Ask locally for optional export labels, persist only with `chrome.storage.local`, and invoke the content script export.
- [ ] Manually test an unpacked extension in a direct chat and a reply thread; run `npm test`; commit `feat: add local browser extension`.

### Task 5: Documentation and privacy verification

**Files:**
- Create: `README.md`

- [ ] Document console use, unpacked-extension installation, replies, cancellation/partial status, UI-change maintenance, and the local-only privacy model.
- [ ] Run `npm test && npm run build:console && rg -n "fetch\\(|XMLHttpRequest|chrome\\.cookies" src extension dist` and require no scan hits.
- [ ] Commit `docs: add installation and privacy guide`.
