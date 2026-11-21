# Photopea Book Cover Studio — MCP Bridge (prototype 0.2)

**Status:** deployable starter source. It has **not** been hosted or connected to ChatGPT. It uses Photopea's official Live Messaging API, not an undocumented direct API and not remote control of an arbitrary existing photopea.com tab.

## What it does

- Runs a token-protected HTTP MCP endpoint at `/mcp`, including `bridge_status`, `photopea_run_script`, `photopea_export`, and `job_status`.
- Hosts a browser companion at `/workspace`, which embeds the official Photopea site. The companion must remain open and connected.
- Opens locally selected PSD/image files into the embedded Photopea tab, runs JavaScript scripts there, and saves exported PSD/PNG/JPG files on the bridge service.
- Export download links are relative (`/download/<job id>`) and require a Bearer token. A remote MCP client needs compatible authenticated file download support, or the export must be retrieved through a different authorized method.

## Quick local check

1. Install Node.js 20+.
2. Run `npm install`.
3. Generate a strong secret, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. Set environment variable `BRIDGE_TOKEN` to the generated secret and run `npm start`.
5. Open `http://localhost:3000/workspace`, paste that secret and press **Connect**. Photopea loads in the embedded frame.
6. Test JSON-RPC at `http://localhost:3000/mcp` with `Authorization: Bearer <token>` and `Content-Type: application/json`.

Example:

```bash
curl -s http://localhost:3000/mcp \
  -H "Authorization: Bearer $BRIDGE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bridge_status","arguments":{}}}'
```

A connected workspace should show both `connected` and `photopea_ready` as true. Running a script returns a job ID; poll `job_status` to verify completion. A queued command **does not** indicate that Photopea edited a file.

## Deploy to HTTPS hosting

Host the files on a Node-compatible HTTPS service (for example, Render using `render.yaml` or a Docker host). On Render, create a repository from this folder, choose **New Blueprint**, and deploy `render.yaml`. The hosting account and deployment authorization are user actions. Retrieve the secret stored in `BRIDGE_TOKEN` from the host's environment settings. Open the resulting `https://YOUR-HOST/workspace` in a browser and pair it by pasting the secret.

**ChatGPT connection is separate:** Your current `photopea-book-cover-studio` is a skill-only personal plugin, not an MCP app. To expose these MCP tools inside ChatGPT, an eligible custom MCP app/connector must be created or configured to point to `https://YOUR-HOST/mcp`, with authenticated access. ChatGPT access to custom MCP connectors depends on the account's supported features and accepted authentication method. Do not paste the bridge secret into ordinary chat. If ChatGPT does not allow a Bearer-token MCP connector, this prototype requires an authentication layer compatible with the offered connector flow. Uploading this ZIP by itself does **not** connect the existing plugin.

## Production limitations

- This is a starter implementation, not a security-audited production service. A single workspace session is supported.
- The bridge currently accepts arbitrary Photopea scripts from an authenticated client. Treat the key like a password.
- Export files are stored in the host filesystem and may disappear on an ephemeral host. Configure durable storage if needed. No automatic deletion/expiration is included.
- The MCP endpoint supports simple JSON responses to Streamable HTTP POST. Some MCP clients require additional OAuth/discovery behavior or richer session handling. Add these if the chosen ChatGPT connector requires them.
- The user must leave the embedded Photopea browser tab open. It cannot attach to a different existing Photopea tab.
- Actual PSD quality, script semantics, KDP preflight, and exported file fidelity must be verified in Photopea and Amazon KDP. A completed script job only confirms a `done` message from Photopea, not that every editing intent succeeded.
- Authorize this bridge only for your own private use. It is not affiliated with Photopea.

Official API references: https://www.photopea.com/api/live and https://www.photopea.com/learn/scripts
