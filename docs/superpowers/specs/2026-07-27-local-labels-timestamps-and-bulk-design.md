# Local labels, timestamps, and loaded-chat bulk export

## Scope

The exporter will retain the browser viewer's local timestamp and UTC offset, avoid treating media/GIF UI text as a sender, let the user map locally visible Reddit handles to private export labels, and add a bulk export mode for chats already loaded in Reddit's sidebar.

## Local labels

The collector may transiently read a rendered profile handle to associate a message with a participant. The popup displays that handle only as a local mapping aid. It sends the mapping to the content script in memory; the export replaces every handle with the chosen label or a neutral `Person A/B/...` label. Handles never appear in JSON, Markdown, diagnostics, browser storage, console output, or downloads.

When no reliable handle exists, the message uses the single `Unknown sender` slot. Media/GIF descriptions, attachment alt text, and generic UI labels must never generate a participant.

## Timestamps

Each parsed instant is rendered as a local RFC 3339 timestamp with the browser's current UTC offset (for example `2026-07-27T22:47:20+05:30`). Existing relative/non-parseable text remains absent rather than being guessed. Export creation time follows the same local format.

## Bulk export

Bulk export is intentionally limited to direct/chat-room links present in the already rendered sidebar. The content script visits one loaded room at a time, waits for the active room path and timeline, exports it through the existing pipeline, restores the original room, and downloads one neutral-name file per room. It does not fetch, paginate the sidebar, discover unseen rooms, or call Reddit APIs.

The popup makes bulk an explicit button with a confirmation-style status. Per-export label mappings are not reused across rooms; this avoids applying a handle’s label to a different conversation accidentally. Bulk has a fixed conservative limit of 20 loaded rooms and reports only aggregate counts: rooms attempted, completed, skipped, and messages exported.

## Failure handling

An inaccessible room, unloaded timeline, or timeout skips only that room and appears only as an aggregate count. Reply-thread warnings remain inside each individual export. The original chat is restored in a `finally` path. The user can still run a single-chat export if bulk stops early.

## Validation

Unit tests cover local timestamp formatting, sender rejection for media-like labels, local label replacement without raw-handle output, loaded-room discovery filters, per-room failure isolation, and the 20-room bound. Existing privacy, URL, reply-thread, and exact-deduplication tests remain required.
