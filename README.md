# Photopea Book Cover Studio bridge

The bridge connects a remote MCP client to the official Photopea editor inside
a paired browser tab. The existing Render service deploys the Dockerfile from
the GitHub repository’s `main` branch.

## Connect Photopea and ChatGPT

1. Open [the Photopea workspace](https://photopea-kdp-bridge.onrender.com/workspace).
   Enter the existing bridge key and choose **Pair workspace**. If Photopea
   shows its welcome page, choose **Start using Photopea**. Keep the tab open.
2. Connect `https://photopea-kdp-bridge.onrender.com/mcp` using **OAuth** and
   **Dynamic Client Registration**. In the existing plugin’s settings, use
   **Open in desktop app** and use the desktop plugin’s MCP authorization.
   In ChatGPT on the web, the separate connector
   workflow is **Plugins → + → Add custom MCP server**. That flow creates a
   separate plugin entry and should only be used with the owner’s approval.
3. On the bridge’s authorization page, enter the owner authorization key.
   This is the value of the optional `MCP_OWNER_KEY` environment variable, or
   the existing `BRIDGE_TOKEN` when a separate key has not been configured.
   Keep the key out of ChatGPT messages and plugin configuration.
4. Check that the plugin discovers the eight tools below. Ask ChatGPT to
   create a document, add an editable text layer, and export a PSD. Check the
   editor and the export’s final job status.

The OAuth issuer on the bridge offers code flow with S256 PKCE, scoped opaque
tokens, and rotating refresh tokens to the private owner. It accepts ChatGPT’s
stable and per-connection callback URLs, and the desktop application’s
loopback callback. A server reboot invalidates currently
issued tokens and jobs. Reauthorize ChatGPT if it cannot refresh after a deploy.
The existing bearer key and `X-API-Key` continue to work for trusted clients.
Only one browser workspace can be paired at a time.

## Tools

| Tool | Operation |
| --- | --- |
| `bridge_status` | Check HTTP health, browser pairing and independent Photopea responsiveness. |
| `photopea_open_document` | Create an RGB document, activate an already open document by exact name, or open a PSD, PNG or JPG from base64. For large files, use **Open local PSD or image** in the paired tab. |
| `photopea_add_text` | Add editable point text with position, color, size, font, alignment and rotation. |
| `photopea_place_image` | Place a PNG or JPG as an embedded Smart Object with a top-left position and relative scale. Tool inputs support about 2 MiB per file. |
| `photopea_manage_layers` | List, rename, reorder within a group, show, hide, update editable text, move, scale or rotate. Use exact layer paths. |
| `photopea_run_script` | Run a Photopea scripting DOM command after the paired browser operator approves the displayed script. Use typed tools for ordinary edits. |
| `photopea_export` | Export PSD, PNG, JPG or a single-page flattened RGB PDF at the document’s physical size. PDF uses a high-quality JPEG embedded without intermediate PNG decoding and supports up to 100 megapixels (subject to file and browser memory limits). |
| `job_status` | Check completion, get confirmed results, and retrieve a private download URL. |

Mutating tools return a job ID. Poll `job_status` and check the final state.
Repeat the same `request_id` with the same arguments to get the existing job
within its retention period. If a connection is lost while a command runs,
inspect the workspace before submitting another edit. The bridge will not
automatically replay a command whose result is uncertain.

Exported files appear in the paired workspace as download buttons. Trusted
clients can also download the URL using an authorization header. Results and
downloads are retained for up to one hour and depend on the running service
instance. Save any needed PSD locally. The browser can only control the editor
embedded in its paired workspace.

## Run and test locally

Use Node.js 22 or later. Set `BRIDGE_TOKEN` to a random secret of at least 32
characters in your shell environment, then run:

```sh
npm ci
npm test
npm start
```

Automated tests exercise the MCP handshake and discovery in both protocol eras,
OAuth and browser authentication, edit dispatch, timeout/reconnect handling,
and downloads using a mocked Photopea editor. For a live test, open
`http://localhost:3000/workspace`, pair it with the local key, then run
`node test/live.mjs`. The test creates a disposable document, edits it and
reopens its PSD. Set `TEST_SCRIPT_APPROVAL=1` to include the interactive
script approval. Use `MCP_URL` to target a different service and its own
disposable workspace. The test writes exports under the system temp directory.

The existing service uses its configured `BRIDGE_TOKEN`. Render supplies
`RENDER_EXTERNAL_URL` for OAuth discovery and origin validation. For another
host, set `PUBLIC_ORIGIN` to the HTTPS origin without a trailing slash. Docker
uses its ephemeral `/tmp/photopea-exports` directory. `/health` reports the
running version. The MCP endpoint uses the maintained TypeScript SDK with the
2026-07-28 revision and legacy 2025 Streamable HTTP compatibility.

- [Photopea Live Messaging API](https://www.photopea.com/api/live)
- [OpenAI custom MCP server setup](https://developers.openai.com/api/docs/guides/custom-mcp-server)
