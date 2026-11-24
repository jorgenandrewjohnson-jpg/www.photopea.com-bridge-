# Brave KDP publishing bridge

## Read an edition from native ChatGPT

Call `kdp_workflow_overview` with `{}` to summarize the one saved edition open in paired Brave, or supply `{"edition_id":"AB123"}`. If several IDs are open, the tool returns the available IDs and waits for a selection. If two formats share the selected ID, keep only the intended format open. Neither tool opens a tab or changes a KDP page.

The overview inspects up to three setup tabs, one each for Details, Content and Pricing. For duplicate tabs at a stage it uses the uniquely active copy, otherwise it skips that stage. The current stage is the uniquely active inspected tab for the edition. Each read checks the original path and returned edition identity. The result includes alert categories and recognized fields. An unavailable tab, unrecognized field or conflicting observation leaves the corresponding fact unknown. Inspection refreshes the extension's control IDs, so inspect the target again before any separate edit or upload.

Call `kdp_preflight_edition` with an exact saved ID for a checklist of outstanding release checks. A displayed Amazon.com price or selected rights option is an observation. Verify the saved pricing and territories in KDP. Print Previewer approval requires an explicit approval notice. A working Previewer button, a staged file, a present cover or an upload dispatch cannot confirm approval or acceptance of the intended file revision. The existing scanner cannot independently establish the latest manuscript and cover revisions or release-wide clearance, so preflight reports `unknown` or `blocked`.

Native ChatGPT already supports authorized attachments through the `file` parameter of `kdp_stage_attachment` (declared in `openai/fileParams`). Staging verifies delivery to Brave. Upload to Amazon and verification of Amazon's processing are separate steps. The Amazon browser workflow remains necessary unless an authorized official API provides the corresponding operation.

## Version 0.3.6

Brave checkpoints each acknowledged chunk and its next offset together in IndexedDB. After an interruption, begin the same transfer on the same saved edition and Content tab. Use the returned byte count and next index for chunked MCP delivery. A private HTTPS exporter can send the complete original file to the fresh one-use receipt. The bridge skips already stored bytes and verifies the full stream SHA-256. Partial transfers expire after 20 minutes. Check staged files after an uncertain commit and inspect Amazon before retrying an upload.

The existing native helper accepts PDFs directly in `~/Library/Application Support/KDP Brave Bridge/Publishing`. The edition-specific `kdp_stage_attachment` tool also accepts an authorized ChatGPT file reference. It streams the attachment into a private temporary file and checks the receipt from Brave. Separate Amazon inspection is required after upload.

## Version 0.3.4: connection diagnostics and macOS privacy errors

The live bridge now exposes `last_paired_at` and `last_disconnect` in `kdp_bridge_status`, recording only timestamp, WebSocket code and a short sanitized reason, not pairing secrets. The server pings the paired socket periodically to preserve connectivity and identify stale connections; Brave schedules an early reconnect alarm after unexpected closure, retaining the existing periodic fallback. Expired incomplete remote transfer sessions are pruned when a new transfer begins.

When the native helper reports `Operation not permitted` for a Desktop/Downloads PDF, this is an OS-level macOS Files & Folders (TCC) privacy denial. Do not modify macOS TCC databases or bypass the permission. The owner may authorize the relevant Brave/native Python process in System Settings > Privacy & Security > Files & Folders, or use an approved cloud export transfer. Permission denial is **not** evidence that Amazon KDP has rejected an AI upload.

This release improves diagnostics and reconnection but does not itself grant native host permission to protected folders, solve ChatGPT workspace DNS access to the private HTTPS ingress, or implement a complete Google Docs/Photopea binary handoff. Verify actual Amazon processing separately.


## Version 0.3.3: direct ChatGPT-to-Brave PDF receiving (requires deployment)

This release adds two MCP commands:

- `kdp_receive_file`: start a transfer using `action:"begin"` and the exact saved Content tab, edition format and ID, PDF name, size and SHA-256. The server issues a transient transfer ID. Submit sequential base64 PDF chunks with `action:"append"`, `transfer_id`, zero-based `index` and `data_base64` (24 KiB decoded maximum per call). Complete with `action:"commit"` to validate the byte count, PDF header and SHA-256 and stage the file inside the **paired Brave extension**, not on the Mac Desktop. `action:"abort"` discards incomplete data. The transfer expires after 20 minutes.
- `kdp_upload_file`: use the staged `file_id` and a **freshly inspected** file-input control, tab, document ID and expected URL to dispatch the file to the existing KDP edition. Inspect/poll Amazon's actual processing state using `kdp_upload_status`. Dispatch is not evidence of acceptance.

### Efficient cloud PDF delivery

The `begin` response also provides an **HTTPS one-use upload URL** and a secret `X-KDP-Transfer-Token` header. A trusted exporter or cloud file-handling client that already has the approved PDF bytes can stream the complete `application/pdf` payload with HTTP POST. The KDP service validates the one-time bearer secret and forwards bounded binary chunks to Brave without writing the document to Render disk. The upload token is sensitive; do not paste it in chats, logs, or public pages. It expires after 20 minutes, can be used only once, and is invalidated on restart. The response returns a staged `file_id`, which must be explicitly passed to `kdp_upload_file`.

This does **not** grant the KDP server access to Google Drive or Photopea secrets. Automatic export handoff will work only after the exporter/client is wired to send its bytes to the private endpoint. Do not pass publicly shared Drive links or attempt server-side fetching of arbitrary URLs.

The receive path is authenticated through the existing owner-scoped MCP connection and paired Brave. It never fetches arbitrary URLs or gives the Render server private Google/Photopea credentials. It rejects filenames with paths, non-PDF files, invalid hashes, oversize files, changed editions and possible cover replacements. Each incomplete transfer is ephemeral in extension memory; a Brave worker restart safely discards it, so callers must restart rather than blindly replay.

**Current limitation:** The MCP client must supply the PDF bytes in ordered base64 chunks. Google Drive's opaque `file_uri` and Photopea's private export URLs are not themselves accessible to this tool. A future authenticated connector-to-connector binary handoff (or explicitly authorized private streaming endpoint) is needed for efficient, fully automatic large Google Docs/Photopea exports. This is not yet an end-to-end Google Docs -> Photopea -> KDP workflow; do not claim it is.

The update script now installs `remote-policy.js` into the same existing unpacked Brave extension alongside background.js and the other scripts. Updating Render alone will NOT update the Mac extension: use the approved in-place updater and reload, keeping the existing extension ID and pairing. The currently connected ChatGPT plugin may need tool inventory refresh and reauthorization after deploy.


## Version 0.3.2: video-driven safety hardening (source only until deployed)

The 2026-11-22 screen recording revealed absent covers, disabled Previewer controls, a macOS file picker that was not evidence of upload acceptance, and an unsaved-changes dialog on a NEW paperback page. The bridge now returns a conservative `content_state` object when inspecting KDP Content pages, blocks cover-upload mode changes and cover replacement when an existing cover is detected **or cover status cannot be established**, reports saving/unsaved conditions, and classifies upload observations without treating browser transfer as Amazon acceptance. If Amazon's content signals conflict, cover protection fails closed.

The native PDF helper now responds to malformed JSON without crashing. New regression tests and `.github/workflows/kdp-bridge-tests.yml` cover these cases. A passing CI and a successful live browser upload/preview remain necessary before calling this version production-verified.

**Install/update without replacing your extension:** The existing Mac updater fetches v0.3.2 scripts and the native helper into the same unpacked extension directory and backs up the earlier scripts. Run its updater **only after reviewing and obtaining the current source**; reload the existing extension at `brave://extensions`. Do not select Remove or Load unpacked again. Preserve pairing. The running Render service must be separately updated from the correct `kdp-browser-bridge` deployment target and should report v0.3.2 after deployment. Do not redeploy the separate Photopea Render service.

**Important:** Existing cover protection intentionally prevents unattended replacement. To replace an existing cover in a future release, implement a separate exact-edition confirmation backed by a before/after snapshot and regression test. Do not bypass this guard by clearing the cover or switching modes silently. Amazon acceptance and full Previewer approval are still read-only observations and may require user review.


## Version 0.3.1: PDF filename validation and larger-file support

The KDP bridge registers `kdp_stage_file` (refresh the ChatGPT app's MCP tool inventory if it is missing even when Render is live). The 0.3.1 extension corrects PDF filename validation so paths ending in `.pdf` are accepted. The native helper and bridge now accept PDFs up to 250 MiB and use 256 KiB chunks. The KDP bridge now exposes `kdp_stage_file` for PDFs directly in the Mac owner's `~/Desktop` or `~/Downloads`. It requires explicit one-time native messaging host installation and does **not** grant filesystem access to Render or ChatGPT. The native helper permits read-only access to ordinary PDF files directly in those two folders, refuses symlinks and other folders, validates PDF headers, limits files to 250 MiB, and returns bounded chunks. Installing the helper is a trust decision: the paired bridge can thereafter stage eligible PDF files from these folders for the authenticated edition. Files are staged inside Brave, not permanently uploaded to Render.

For the Mac already using `~/Developer/kdp-browser-bridge/kdp-bridge/extension`, preserve the existing unpacked extension, extension ID and pairing. Find its **Extension ID** in `brave://extensions` with Developer mode enabled. Download `kdp-bridge/native-host/update-existing-mac.sh` from this branch and run `sh update-existing-mac.sh YOUR_32_CHARACTER_EXTENSION_ID`. The updater fetches the source-controlled extension scripts and native host, checks the version and JavaScript syntax, backs up the previous scripts, installs the host with only this extension ID allowed, and leaves Brave pairing storage untouched. Then click **Reload** on the existing extension in `brave://extensions`. Do not install a duplicate extension.

Call `kdp_list_tabs` and verify the exact saved hardcover Content tab before calling `kdp_stage_file` with e.g. `{tab_id,edition:"hardcover",edition_id:"MDYZRKK4ZHV",kind:"manuscript",path:"/Users/jorgen/Desktop/Corinthians_Joel_6x9_Images_Aligned_REVIEW.pdf"}`. Use the same pattern with `kind:"cover"` and the 500-DPI hardcover PDF after it has been saved locally. List staged files to obtain the returned UUID, inspect the upload targets, invoke `kdp_upload_staged_file`, then inspect Amazon and call `kdp_upload_status` until processing is confirmed. Upload dispatch is **not** proof of Amazon acceptance.

The KDP scanner now exposes buttons, radios, checkboxes, select options, visible text fields, and context-associated file inputs while excluding publication, ordering and destructive account controls. The separate publication confirmation remains mandatory. It also checks the visible Paperback/Hardcover Content heading to protect editions that happen to share a setup ID. Browser commands execute in a queue instead of failing with a busy error.

**Boundaries:** This update does not bypass ChatGPT Library raw-file authorization, circumvent Amazon sign-in/captcha, or provide a hidden route into Mac's entire filesystem. It does not automatically verify the full Cover Creator or every Previewer page; these require live browser checks and explicit captures. The native helper only operates after Mac-side installation.


Deploy the existing repository's `kdp-browser-bridge` branch as its own single-instance Render Node web service. Build with `cd kdp-bridge && npm ci --omit=dev --ignore-scripts` and start with `node kdp-bridge/server.mjs`. The root Dockerfile serves the separate Photopea project. Use a new random 48-byte `KDP_OWNER_KEY` in Render Environment. Render supplies the service origin. For local testing set `PORT` and use the default loopback origin. Run `npm ci`, `npm run check`, and `npm test` inside this directory.

## Connect Brave and ChatGPT

Load the `extension` folder with Brave's Load unpacked command. Open its action, enter the service's HTTPS origin, then select Start pairing. The popup displays a time-limited enrollment code. Using the displayed code and your owner key, send a JSON POST to the same origin's `/device/approve` endpoint with the object `{"code":"<displayed code>"}` and the owner key in the Authorization Bearer header. Only authorize codes from your own Brave popup. Browser credentials are separate from the owner key and expire after 30 days. Disconnect removes the local credential. Rotating the owner key and restarting the service invalidates all issued credentials. Reconnect is automatic after service worker suspension or a network interruption.

Connect the existing personal plugin to `/mcp` with Streamable HTTP and OAuth. The owner consents using the KDP bridge owner key. Dynamic registration, S256 PKCE, audience checks and rotating refresh tokens are supported. Restarting this single-instance service clears OAuth grants and pending operations. Reauthorize if prompted. GET /health is public. Authenticated kdp_bridge_status reports Brave pairing.

## Updating an existing unpacked Brave extension

When Amazon uses `/en_US/print-setup/hardcover/<edition-id>/content`, use extension **0.2.1 or newer**. It recognizes both `title-setup` and `print-setup` Details, Content and Pricing routes with the existing KDP hostname and edition-ID checks.

Brave does **not** automatically synchronize an unpacked extension with GitHub commits or Render deploys. Update the local `kdp-browser-bridge` worktree from the `kdp-browser-bridge` branch, then open `brave://extensions` and click **Reload** for the existing **Brave KDP Bridge (Private)** extension. Keep its same extension entry and local extension directory; do not remove it or install a second copy, because doing so can discard the stored pairing. Confirm `kdp_bridge_status` returns `paired: true`, then inspect the exact hardcover Content tab. Do not rotate `KDP_OWNER_KEY` as part of this update.

## Publishing and recovery

Start at Bookshelf. Read the selected work, edition and KDP identifier from the page. Reconcile them with the existing Google Drive publishing ledger. On a repeated request, find the existing edition before using Create. Page controls are tied to the selected tab, document and inspected path. Inspect again after navigation. Tools support an allowlist of English-language publishing pages and controls. A missing control, editor embedded in another origin or unsupported Previewer requires direct user interaction. Never proceed through an Amazon challenge.

Export the correct revision using the connected Google Docs/Drive or Photopea workflow. Download the completed export to this Mac. Open the saved edition's Content page and select the local manuscript or cover using the extension. The extension stores the chosen file in local IndexedDB with its role, edition ID, byte count and SHA-256. Maximum size is 250 MiB per file. Remove files from the popup when finished. Uploads require a matching file input and edition. After dispatch, inspect Amazon's processing notices and filenames before recording acceptance. The bridge never fetches arbitrary supplied export URLs.

Launch Cover Creator and Previewer from the selected edition's Content page. Open the extension on the active preview tab to grant active-tab capture access. Capture each inspected page, check layout, bleed, spine, images and numbering, record inaccessible pages, then correct and re-export if needed. Mark previous preview results obsolete after replacing an artifact. Save the observed Amazon status, each file version, unresolved warnings, preview coverage and next action to the existing ledger under the same edition. A dispatched click or changed URL establishes no save or publication status.

The final publication request requires explicit chat approval of the exact title, edition, ID, price, rights and displayed warnings. Only a matching publication control on the same pricing document is eligible. The extension shows the requested details for a second confirmation, expires it after 90 seconds, and rechecks the page before dispatching once. If Amazon's displayed details cannot be matched, the request fails closed. Inspect Bookshelf afterward. Never publish during setup tests.

### Native ChatGPT publishing dashboard

The existing authenticated MCP endpoint exposes `kdp_publishing_dashboard`. Call it with an optional exact saved edition ID to return an MCP Apps UI resource and structured edition observations. The widget shows bridge connectivity, observed format, current stage, ISBN, US price, rights, blockers, and preflight checks; use Refresh or select an edition when several are open. It never uploads, saves, or publishes. Unknown checks are not approvals. The existing headless tools and Brave confirmation gates remain unchanged. Refresh the existing ChatGPT plugin's tool connection after deployment; no extension replacement is required for this server-only feature.
