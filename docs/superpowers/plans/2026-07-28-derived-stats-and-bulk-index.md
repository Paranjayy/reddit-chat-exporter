# Derived Stats and Bulk Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dynamically calculated export statistics and a privacy-preserving bulk index.

**Architecture:** `src/shared/exporter.js` derives stats from sanitized messages. Content export returns per-room stats to the service worker, which creates a neutral aggregate index through the existing local download mechanism.

**Tech Stack:** ECMAScript modules, Chrome MV3, Node test runner.

---

### Task 1: Derive export stats

**Files:** `src/shared/exporter.js`, `test/exporter.test.mjs`

- [ ] Add a failing test covering nested messages, anonymous participant counts, reactions, attachments, complete/incomplete threads, and zero-safe empty exports.
- [ ] Implement `deriveExportStats(exportData)` from sanitized messages only; attach its result during export and after optional deduplication.
- [ ] Render the same dynamically derived values in a Markdown `## Summary` section.
- [ ] Run `node --test test/exporter.test.mjs`; commit the passing unit.

### Task 2: Add the bulk index

**Files:** `extension/content.js`, `extension/background.js`, `src/shared/exporter.js`, `test/exporter.test.mjs`

- [ ] Extend export responses with sanitized per-room stats, never room URLs/names.
- [ ] Accumulate only `{ roomNumber, status, stats }` in the service worker and ask the original content script to download the neutral index after restoring the room.
- [ ] Test the index renderer never serializes an input URL/handle and uses a neutral filename.
- [ ] Run the full suite, synchronize generated files, bump the minor version, and commit/push.
