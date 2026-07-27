# Reddit Chat Exporter — Design

Build two local-only tools for backing up the Reddit chat open in the signed-in browser: a paste-in console script and a Chromium Manifest V3 extension.

The tools only read rendered chat UI. They do not call Reddit APIs, access credentials, send telemetry, or upload content. They traverse open shadow roots, scroll virtualized timelines in bounded steps, and deduplicate rendered messages. For every reply control, they open the reply panel, collect its timeline, and attach the result to the parent message. A failed thread remains in the export with an incomplete status.

Exports redact usernames, profile/source URLs, room IDs, and raw event IDs by default. The console uses neutral aliases. The extension asks for optional local-only labels and stores them in `chrome.storage.local`. JSON is canonical and Markdown is a readable copy. Filenames are neutral.
