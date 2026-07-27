# Derived stats and bulk index

Each export gains a calculated `stats` object: total messages and replies, per-anonymous-participant counts, unknown-sender count, attachment/reaction counts, reply/thread completeness, earliest/latest message timestamp, calendar span, and exact duplicates removed. JSON stores this structured data; Markdown renders a compact summary. All values are calculated from sanitized export objects and have zero-safe fallbacks.

Bulk export additionally downloads one neutral `private-chat-bulk-index-YYYY-MM-DD.json` index. It contains only sequential room numbers, per-room export status, top-level/reply message totals, and date ranges. It does not retain room links, titles, handles, or text. Existing per-chat files remain unchanged.
