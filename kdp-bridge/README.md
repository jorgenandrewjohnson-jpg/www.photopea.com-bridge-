# Brave KDP Browser Bridge

Private Brave-compatible Manifest V3 extension plus a separate Render MCP server for Amazon KDP and Cover Creator. It uses your existing Brave tabs and does not require Google Chrome.

## Separate deployment

The existing Photopea Render service follows main. Deploy this bridge from branch kdp-browser-bridge as a SECOND Render Node service; do not change the Photopea service.

- Root repository: https://github.com/jorgenandrewjohnson-jpg/www.photopea.com-bridge-
- Branch: kdp-browser-bridge
- Build command: cd kdp-bridge && npm install --omit=dev
- Start command: node kdp-bridge/server.mjs
- Health: /health
- MCP: /mcp, authenticated with Authorization Bearer BRIDGE_TOKEN
- Set a different, secret BRIDGE_TOKEN of 32 or more characters in Render Environment. Never put that value in a GitHub file or a chat message.

## Pair your current Brave browser

1. Download this branch ZIP from GitHub and extract it.
2. Open brave://extensions in Brave, enable Developer mode, choose Load unpacked, and select the extracted kdp-bridge/extension folder.
3. Open https://kdp.amazon.com/en_US/bookshelf IN BRAVE and sign into Amazon normally, using Amazon's own login UI.
4. Click the Brave KDP Bridge extension icon, enter your Render KDP bridge service HTTPS URL and its BRIDGE_TOKEN, then Pair.
5. Test /health and read-only MCP calls first, including kdp_bridge_status, kdp_list_tabs, kdp_inspect_page and kdp_capture.
6. Stage the exact manuscript or cover in the extension popup before calling kdp_upload_staged_file. Verify KDP truly processes the upload; a populated input control is not proof of acceptance.
7. Launch Amazon Cover Creator from that book's Content page. Do not reuse the session-bearing Cover Creator URL of another title.
8. Before a Publish click, explicitly approve the named title and edition in ChatGPT AND authorize the exact title and edition once in the extension. Check KDP Bookshelf afterward to verify real state.

Brave uses chrome.* browser extension APIs and a chrome-extension:// extension origin because it is Chromium-based. These API names do not require the Google Chrome browser.

## Limits

- The initial service has token-based MCP authorization, not OAuth. ChatGPT may require an OAuth-compatible endpoint before registering this MCP server. Do not claim the KDP custom plugin is connected solely because this service is deployed.
- This version is experimental. Browser commands, PDF uploads, screenshot review, Cover Creator controls and KDP publication require in-browser tests. Never bypass Amazon login, anti-automation controls or publishing restrictions.
- Extension actions are limited to kdp.amazon.com and cc.amazon.com browser tabs. It cannot control arbitrary websites.
- Staged files are held temporarily in Brave extension memory and may be lost on restart. Use a Google Drive publishing ledger for durable project progress.
- Only active visible browser tabs can be screenshotted. Graphical Cover Creator areas may lack ordinary HTML controls.
- This extension is an unreviewed development build. Carefully inspect its extension permissions before installing. Disable it if not in use.