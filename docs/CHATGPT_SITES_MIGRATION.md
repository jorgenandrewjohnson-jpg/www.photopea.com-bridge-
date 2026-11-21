# ChatGPT Sites migration — Photopea Book Cover Studio

## Goal

Make the already-running Photopea bridge available as a **web-compatible ChatGPT Sites plugin**, without changing its existing Render service or GitHub repository. This document is the full handoff brief for a Sites-capable ChatGPT Work / Plugin Creator environment. Do not register the existing standalone `mcp.json` package as though it were web-compatible: standalone plugin MCP declarations receive a Desktop only badge.

## Existing system (verified)

- Source: https://github.com/jorgenandrewjohnson-jpg/www.photopea.com-bridge-
- Render bridge: https://photopea-kdp-bridge.onrender.com
- MCP: https://photopea-kdp-bridge.onrender.com/mcp (Streamable HTTP)
- Browser editor: https://photopea-kdp-bridge.onrender.com/workspace (must remain open and paired)
- Service health: https://photopea-kdp-bridge.onrender.com/health
- OAuth discovery: https://photopea-kdp-bridge.onrender.com/.well-known/oauth-protected-resource/mcp
- OAuth issuer discovery: https://photopea-kdp-bridge.onrender.com/.well-known/oauth-authorization-server
- OAuth flow: authorization code + PKCE S256, Dynamic Client Registration, scope `photopea:edit`
- Existing owner-side secrets are in Render environment settings. Do not print, commit, or ask to paste their values into chat. Do not change or rotate them as part of migration.
- The browser-to-Render WebSocket pairing has already been fixed; a live screenshot confirmed `Connected to Photopea`. Do not rebuild that bridge unnecessarily.
- The currently saved personal plugin, Photopea Book Cover Studio, is Desktop only because it declares `mcp.json` / `.mcp.json`. Preserve it until the web-compatible version is confirmed working.

## Tool surface

Expose these eight existing actions in a ChatGPT web-compatible Sites MCP plugin:

1. `bridge_status` — read-only; reports pairing and editor responsiveness.
2. `job_status` — read-only; poll a job ID until terminal state.
3. `photopea_open_document` — create/activate/open a document.
4. `photopea_add_text` — editable text layer.
5. `photopea_place_image` — embedded editable Smart Object.
6. `photopea_manage_layers` — list, rename, show/hide, edit text, transform or reorder.
7. `photopea_run_script` — user-approved arbitrary Photopea scripting DOM call; do not bypass approval.
8. `photopea_export` — editable PSD; flattened PNG/JPG/PDF; completed job exposes export.

The source-of-truth schemas, argument validation, and tool annotations are in `server.mjs`; Photopea script implementation is in `photopea.mjs`. Keep `request_id` idempotency, `job_status` polling, approval screens, and execution status behavior.

## Site architecture / connection requirement

Use **ChatGPT Sites** (not Render Static Sites and not a standalone desktop plugin) to publish the cloud MCP tools. Publish a private Site with a minimal informational UI and a tool implementation that forwards authorized calls to the existing Render MCP backend. Reuse the existing Render bridge rather than running another copy of Photopea or replacing its browser WebSocket.

Before implementing server-to-server forwarding, check the Sites runtime's official `sites` skill and `references/site-mcp-server.md` for supported MCP/App imports, remote-server connection, authentication, storage and secrets. Choose the supported Sites connection mechanism. If the existing Render OAuth DCR callback restrictions are incompatible with a Site-based credential flow, do not weaken the bridge's OAuth redirect validation; use a Sites-side secret stored in secure server-side configuration if officially supported, or follow the supported Site connector flow. No browser-exposed or hardcoded credentials.

The Site's MCP tools should be unavailable if the Render endpoint cannot be reached, and should report precise errors. Do not silently simulate edits or claim a PSD was exported until `job_status` says completed.

## Publication and verification

1. Create/publish the private Site through @Plugin Creator in **ChatGPT Work** with Sites authoring enabled. Publishing generates its associated *new canonical Site plugin*; do not mislabel the old Desktop only plugin as converted.
2. Install and connect the new plugin on ChatGPT web and verify `bridge_status` and tool discovery. Confirm all eight tool schemas.
3. With the user's existing Photopea workspace still open and paired, create a disposable document and one editable text layer. Poll `job_status` to completion.
4. Export as PSD; confirm actual PSD in Photopea and the downloaded file. Only then report ChatGPT web editing as functional.
5. Keep the original standalone plugin until successful verification. Afterward, rename/disconnect it only at the owner's direction.

## Target user workflow

Create a 6 x 9 in (trim), black-and-white interior, white-paper KDP paperback wrap for a 317-page commentary on First Corinthians, Second Corinthians, and Joel, with a continuous ornate background across back/spine/front, precisely seven separate lampstands across the spine, and larger vertically-running spine title and author name above them. Preserve background, lampstands, and text as separately editable layers in a Photopea PSD. Use official KDP calculator to verify final spine width and bleed before publishing the print cover.

## Important practical limitation

The Sites builder/publisher is a host capability, not a tool provided by this GitHub repository. The existing GitHub/Render/standalone-plugin connectors cannot publish a ChatGPT Site by themselves. Building or editing Sites currently counts toward Codex usage on ChatGPT Plus/Pro. If the user is out of Codex usage, do not promise an immediate Site build. Complete this migration when Sites/Work authoring becomes available.
