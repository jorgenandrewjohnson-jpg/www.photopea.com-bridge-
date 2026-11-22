# KDP Brave Bridge: video-derived acceptance checks (2026-11-22)

Source: user's 90-second screen recording of Brave/KDP. This document does not prove who or what removed a cover.

## Observed
- 0-10s: Hardcover Content page and macOS manuscript file chooser. Opening picker does not prove upload.
- 15-25s: KDP requests a cover and preview approval; Bookshelf contains existing paperback and hardcover drafts.
- 30-35s: A NEW paperback Details page shows unsaved-changes dialog. Must not confuse with saved paperback.
- 45-50s: A Saving overlay is visible. Do not treat the initial click as a confirmed save.
- 60-70s: Paperback Content displays Cover Creator selected, No Cover Uploaded, an alternative Upload Existing Cover PDF radio, a disabled Previewer, and errors requiring cover and preview approval.
- 70-90s: Further navigation. No successful cover upload or final preview approval is visible.

## Mandatory improvements
1. Require exact saved edition ID, format, tab ID, stage, inspected document and URL for every mutation. Verify visible Paperback/Hardcover Content heading. Fail closed on /new/ routes for existing-book tasks.
2. Before changing cover mode or replacing a file, capture existing cover status, thumbnail/filename when visible and manuscript status. If an existing cover appears, require explicit owner approval to replace it. Never delete the cover or silently switch modes.
3. Distinguish KDP Cover Creator from Upload an existing print-ready cover PDF. After radio selection, re-inspect and use the actual inspected file input; avoid stale controls.
4. Stage local PDFs with file digest and exact edition/kind. Filename-picker open or transfer dispatched is not Amazon acceptance. Poll processing, inspect notices, and report accepted, rejected or unknown separately.
5. Detect disabled Previewer and classify blocking messages cover_missing and preview_not_approved. Do not click disabled controls; report prerequisites.
6. Detect unsaved-changes dialogs and Saving overlays. Never select Continue without Saving automatically, and verify persistence before further edits.
7. Maintain per-edition audit trail: basename, file hash, bytes, actual page count, target kind, cover mode, transfer, Amazon result, preview coverage; never leak local paths or credentials.
8. Check paperback versus hardcover cover dimensions against final manuscript page count and binding. Do not silently reuse wrong cover geometry.
9. Invalidate preview approval whenever manuscript or cover changes; require new Previewer inspection. Enumerate actually inspected page ranges and warnings.
10. Keep existing Brave extension ID, pairing, native host, GitHub repository, and Render service. Verify installed extension/server versions separately. Existing repo code is 0.3.1 whereas previously reported runtime status was 0.3.0.

## Regression tests required
- Existing hardcover and paperback with identical title cannot be mixed.
- Cover already uploaded: no silent mode toggle or replacement.
- File picker canceled: no success status.
- Upload dispatched but Amazon processing pending/error: not marked accepted.
- Disabled Previewer due missing cover: prerequisite reported.
- Saving overlay and unsaved-changes dialog block navigation.
- New paperback details route cannot substitute for saved paperback.
- Extension reconnect does not replay uncertain uploads.
- Content replacement invalidates earlier preview result.
- No tests publish, order proofs, delete covers, or create a duplicate edition.

## Implementation targets
Use existing branch kdp-browser-bridge and folder kdp-bridge: extension/content.js, extension/background.js, extension/files.js, tools.mjs, tests and README. Validate code locally, then deploy existing service only in confirmed Render workspace. Final status must distinguish committed, deployed, connected, uploaded, processed, and preview-approved.