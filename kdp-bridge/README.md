# Brave KDP publishing bridge

Deploy the existing repository's `kdp-browser-bridge` branch as its own single-instance Render Node web service. Build with `cd kdp-bridge && npm ci --omit=dev --ignore-scripts` and start with `node kdp-bridge/server.mjs`. The root Dockerfile serves the separate Photopea project. Use a new random 48-byte `KDP_OWNER_KEY` in Render Environment. Render supplies the service origin. For local testing set `PORT` and use the default loopback origin. Run `npm ci`, `npm run check`, and `npm test` inside this directory.

## Connect Brave and ChatGPT

Load the `extension` folder with Brave's Load unpacked command. Open its action, enter the service's HTTPS origin, then select Start pairing. The popup displays a time-limited enrollment code. Using the displayed code and your owner key, send a JSON POST to the same origin's `/device/approve` endpoint with the object `{"code":"<displayed code>"}` and the owner key in the Authorization Bearer header. Only authorize codes from your own Brave popup. Browser credentials are separate from the owner key and expire after 30 days. Disconnect removes the local credential. Rotating the owner key and restarting the service invalidates all issued credentials. Reconnect is automatic after service worker suspension or a network interruption.

Connect the existing personal plugin to `/mcp` with Streamable HTTP and OAuth. The owner consents using the KDP bridge owner key. Dynamic registration, S256 PKCE, audience checks and rotating refresh tokens are supported. Restarting this single-instance service clears OAuth grants and pending operations. Reauthorize if prompted. GET /health is public. Authenticated kdp_bridge_status reports Brave pairing.

## Updating an existing unpacked Brave extension

When Amazon uses `/en_US/print-setup/hardcover/<edition-id>/content`, use extension **0.2.1 or newer**. It recognizes both `title-setup` and `print-setup` Details, Content and Pricing routes with the existing KDP hostname and edition-ID checks.

Brave does **not** automatically synchronize an unpacked extension with GitHub commits or Render deploys. Update the local `kdp-browser-bridge` worktree from the `kdp-browser-bridge` branch, then open `brave://extensions` and click **Reload** for the existing **Brave KDP Bridge (Private)** extension. Keep its same extension entry and local extension directory; do not remove it or install a second copy, because doing so can discard the stored pairing. Confirm `kdp_bridge_status` returns `paired: true`, then inspect the exact hardcover Content tab. Do not rotate `KDP_OWNER_KEY` as part of this update.

## Publishing and recovery

Start at Bookshelf. Read the selected work, edition and KDP identifier from the page. Reconcile them with the existing Google Drive publishing ledger. On a repeated request, find the existing edition before using Create. Page controls are tied to the selected tab, document and inspected path. Inspect again after navigation. Tools support an allowlist of English-language publishing pages and controls. A missing control, editor embedded in another origin or unsupported Previewer requires direct user interaction. Never proceed through an Amazon challenge.

Export the correct revision using the connected Google Docs/Drive or Photopea workflow. Download the completed export to this Mac. Open the saved edition's Content page and select the local manuscript or cover using the extension. The extension stores the chosen file in local IndexedDB with its role, edition ID, byte count and SHA-256. Maximum size is 80 MiB per file. Remove files from the popup when finished. Uploads require a matching file input and edition. After dispatch, inspect Amazon's processing notices and filenames before recording acceptance. The bridge never fetches arbitrary supplied export URLs.

Launch Cover Creator and Previewer from the selected edition's Content page. Open the extension on the active preview tab to grant active-tab capture access. Capture each inspected page, check layout, bleed, spine, images and numbering, record inaccessible pages, then correct and re-export if needed. Mark previous preview results obsolete after replacing an artifact. Save the observed Amazon status, each file version, unresolved warnings, preview coverage and next action to the existing ledger under the same edition. A dispatched click or changed URL establishes no save or publication status.

The final publication request requires explicit chat approval of the exact title, edition, ID, price, rights and displayed warnings. Only a matching publication control on the same pricing document is eligible. The extension shows the requested details for a second confirmation, expires it after 90 seconds, and rechecks the page before dispatching once. If Amazon's displayed details cannot be matched, the request fails closed. Inspect Bookshelf afterward. Never publish during setup tests.
