# Design

## Goal

Export supported Reddit and LinkedIn pages as local JSON or Markdown backups. The extension reads only rendered page data and writes the chosen file through the browser download flow.

## Architecture

- `src/shared/exporter.js` normalizes messages, assigns neutral participant IDs, applies redaction, renders JSON/Markdown, and optionally removes exact duplicates.
- `src/shared/reddit-ui.js` collects the rendered timeline and opens reply threads. It reports count-only diagnostics for incomplete thread loading.
- `extension/content.js` connects the Reddit page to the shared logic and downloads the result locally.
- `extension/popup.js` offers export format, opt-in exact deduplication, and per-export participant labels.
- `extension/core/linkedin-ui.js` expands and collects LinkedIn profiles, full-page chats, and popup chats. LinkedIn messaging is probed across readable frames because Safari may isolate the rendered conversation from the top document.
- `dist/reddit-chat-exporter.console.js` is the standalone console variant.

## Privacy model

Raw page identifiers are transient parsing inputs, never export fields. Participants become neutral slots such as `Person A` and `Person B`. Preview may show a currently visible Reddit handle solely as a local mapping aid; the user can replace its neutral slot label for one export only, and the handle is never written to output, diagnostics, logs, or storage. If a sender cannot be identified reliably—especially media/GIF UI—it becomes `Unknown sender`, not a guessed new participant. Ordinary URLs written in message text remain intact.

Message and export timestamps use the browser’s local RFC 3339 date/time and UTC offset. When Reddit already supplies an explicit offset, it is retained. JSON keeps that precise representation; Markdown renders it as a readable local calendar date and clock time. Reddit’s grouped-message UI may omit a sender header for consecutive events, so the collector inherits the preceding visible sender only within the same rendered snapshot and never across an off-screen boundary.

## Reliability model

Reddit’s UI is not a stable API. The collector operates on loaded messages, attempts each visible reply thread, and records count-only diagnostics. Exact duplicate removal is explicitly opt-in and only removes structurally identical sanitized messages at the same thread level. Bulk export is intentionally bounded: it visits at most 20 room links already rendered in Reddit’s sidebar, downloads each as a separate neutral-name file, skips failures individually, and restores the initially open chat. It does not fetch, search, or paginate chats.

LinkedIn’s UI is likewise unstable and may render messaging inside an embedded frame. Its collector is prebuilt as a classic content script because Safari does not initialize the dynamically imported module reliably. The background worker probes all readable LinkedIn frames using count-only diagnostics, selects the frame with actual message candidates, and then performs one download there. If an unpacked-extension reload leaves stale page controls with dead listeners, one local content-script reinjection repairs the current tab before probing again. Chat export slowly walks the rendered message surface toward its oldest stable position, merges overlapping DOM snapshots in page order, and restores the user’s relative scroll position. Rendered message, GIF, image, video, and file URLs are preserved without fetching or downloading their contents; Markdown embeds rendered images and links other files. Chat mode refuses to create a misleading empty backup. Safe diagnostics and console logs contain only stages, modes, booleans, and DOM counts—never text, names, URLs, or thread identifiers.

## Release checklist

1. Run `npm test` and `npm run build:console`.
2. Sync `src/shared/` to `extension/core/`.
3. Bump `extension/manifest.json` using semantic versioning.
4. Audit staged changes and all reachable history for private data.
5. Commit with the generic identity and push only to the private repository.
