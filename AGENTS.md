# Contributor etiquette

## Privacy is the product boundary

- The exporter is local-only. Do not add telemetry, analytics, remote APIs, credentials, or network requests.
- Never commit, paste into issues, or push chat text, DOM captures, room/event IDs, exports, browser downloads, screenshots, attachments, account names, phone numbers, email addresses, or other user data.
- Preserve ordinary message URLs in the export. Do not include source URLs or internal Reddit identifiers as metadata.
- Keep detected participants anonymous in the UI and output by default. Rename choices are per-export, in memory only, and must never be persisted.

## Implementation workflow

- Keep shared logic in `src/shared/`; copy it to `extension/core/` whenever it changes.
- Run `npm test` and `npm run build:console` after changing exporter logic. Load the `extension/` directory directly for Chromium development.
- Keep diagnostics count-only: no message text, URLs, usernames, IDs, or content snippets.
- Maintain graceful fallbacks for DOM changes: neutral participant slots and a usable export are preferable to guessing an identity.

## Version control and releases

- Use semantic versions. Bump the extension patch version for fixes and small user-visible changes; use a minor version for new capabilities.
- Every user-visible extension change must bump `extension/manifest.json`; keep `DESIGN.md` current when a new page mode or privacy rule is added.
- Before every push, inspect `git status`, `git diff --cached`, and `git log --all -p` for private data. Use a generic no-reply commit identity.
- The repository stays private unless the owner explicitly changes that decision. Do not force-push, publish, or change repository visibility without explicit approval.
