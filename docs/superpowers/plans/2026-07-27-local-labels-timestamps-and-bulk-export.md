# Local Labels, Timestamps, and Bulk Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map visible handles to private labels, retain local timestamps, reject media as senders, and batch-export already loaded sidebar rooms.

**Architecture:** Shared modules own normalized export data and DOM queries. The popup displays transient handle mappings. The MV3 worker coordinates room-by-room navigation because content scripts are replaced after every navigation.

**Tech Stack:** ECMAScript modules, Chrome MV3 APIs, DOM/shadow-DOM traversal, Node test runner.

---

### Task 1: Local timestamps and reliable sender identification

**Files:**
- Modify: `src/shared/exporter.js`
- Modify: `src/shared/reddit-ui.js`
- Test: `test/exporter.test.mjs`
- Test: `test/reddit-ui.test.mjs`

- [ ] Write failing tests for an explicit `+05:30` timestamp, a locally formatted parsed timestamp, and a media-only event whose sender is `unknown`.
- [ ] Run `node --test test/exporter.test.mjs test/reddit-ui.test.mjs`; expect failures.
- [ ] Implement `formatLocalTimestamp(value)` so an explicit RFC 3339 offset is retained and an instant without one receives the browser local offset. Keep unparseable values absent.
- [ ] Make `inferSenderFromEventText` reject GIF, media, image, attachment, reaction, and blank header candidates. Set the fallback participant label to `Unknown sender`.
- [ ] Re-run focused tests; expect PASS.
- [ ] Commit with `git commit -m "fix: preserve local timestamps and reject media senders"`.

### Task 2: Local-only handle-to-label picker

**Files:**
- Modify: `src/shared/exporter.js`
- Modify: `extension/content.js`
- Modify: `extension/popup.js`
- Modify: `extension/popup.html`
- Test: `test/exporter.test.mjs`

- [ ] Write a failing test for `createLocalParticipantPreview([{ sender: 'visible-handle', text: 'hi' }])` returning `[{ id: 'person-a', handle: 'visible-handle', fallbackLabel: 'Person A' }]`, while `toCanonicalJson(createPrivateExport(...))` must not contain `visible-handle`.
- [ ] Run `node --test test/exporter.test.mjs`; expect failure because the preview helper does not exist.
- [ ] Implement `createLocalParticipantPreview(messages)` using the same reliable token sorting and neutral IDs as `createPrivateExport`. It must not be used by JSON/Markdown renderers.
- [ ] Return the preview only for `private-reddit-chat-preview`; apply submitted labels by neutral participant ID on export.
- [ ] Render `u/<handle> →` beside each label input. Keep handles only in the popup DOM/message response and state that they never enter exports, logs, diagnostics, or storage.
- [ ] Re-run focused tests; expect PASS. Commit with `git commit -m "feat: map local Reddit handles to private labels"`.

### Task 3: Loaded-room discovery and bulk coordinator

**Files:**
- Modify: `src/shared/reddit-ui.js`
- Modify: `extension/content.js`
- Modify: `extension/background.js`
- Modify: `extension/popup.js`
- Modify: `extension/popup.html`
- Test: `test/reddit-ui.test.mjs`

- [ ] Write a failing `findLoadedRoomLinks(root)` test that returns distinct Reddit `/chat/room/` links currently rendered in a fixture and excludes non-Reddit/non-room anchors.
- [ ] Run `node --test test/reddit-ui.test.mjs`; expect failure.
- [ ] Implement `findLoadedRoomLinks(root)` with `queryAllDeep`, absolute Reddit URLs, query/fragment removal, deduplication, and no scrolling.
- [ ] Add `private-reddit-chat-list-rooms` to the content-script protocol. Extend export requests with a neutral `filenameSuffix`, never a room title.
- [ ] Add a service-worker handler `private-reddit-chat-bulk-export`: list rooms, cap at 20, navigate sequentially, wait for the tab load, send one export request per room without labels, count attempted/completed/skipped/messages, apply a 20-second room timeout, and restore the original URL in `finally`.
- [ ] Add a popup button labelled `Export loaded chats` with a note that it exports up to 20 currently visible sidebar chats as separate private files. Disable controls during operation and render aggregate counts only.
- [ ] Re-run focused tests; expect PASS. Commit with `git commit -m "feat: export loaded Reddit chats in bulk"`.

### Task 4: Release verification

**Files:**
- Modify: `extension/core/exporter.js`
- Modify: `extension/core/reddit-ui.js`
- Modify: `extension/manifest.json`
- Modify: `dist/reddit-chat-exporter.console.js`
- Modify: `DESIGN.md`

- [ ] Synchronize both shared files into `extension/core/` and run `npm run build:console`.
- [ ] Document timestamp, picker, media fallback, and bounded bulk behavior in `DESIGN.md`; bump the manifest from `0.1.1` to `0.2.0`.
- [ ] Run `npm test`, `git diff --check`, the manifest JSON parse check, and `cmp -s` checks for both shared/core pairs; expect success.
- [ ] Stage only source/docs/generated extension files; audit staged file names for exports/captures, commit `release: add private loaded-chat bulk export`, and push the private branch.
