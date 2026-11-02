# Local MCP clients without a tunnel (STDIO / loopback)

Cloud ChatGPT needs the tunnel ([`tunnel-client.md`](tunnel-client.md)), but
local clients can talk to the Browser MCP server directly — no tunnel, no
public surface at all. Two supported scenarios:

## 1. Codex CLI (and any STDIO MCP client)

`MCP_TRANSPORT=stdio` runs the server as a child process: stdout belongs to
the MCP JSON-RPC protocol, logs go to stderr, and there is no HTTP listener.
The client owns the process lifecycle — when the client disconnects, the
server shuts down.

Codex CLI (`~/.codex/config.toml`; adjust the path to this repository):

```toml
[mcp_servers.browser]
command = "node"
args = ["E:/souce/human-browser/dist/src/main.js"]

[mcp_servers.browser.env]
MCP_TRANSPORT = "stdio"
# Simplest local chain: adapter -> Chrome CDP directly (loopback is allowed
# by the default CDP_ALLOWED_CIDRS). The gateway is optional for STDIO use.
GATEWAY_ENABLED = "false"
CDP_ENDPOINT = "http://127.0.0.1:9222"
BROWSER_ALLOWED_DOMAINS = "partslink24.com,www.partslink24.com,partsouq.com,www.partsouq.com"
# Keep the gateway enabled instead? Then also point CDP_ENDPOINT at the
# gateway (http://127.0.0.1:9229) and provide the secret in this env table
# or the inherited process environment — never in committed files:
# GATEWAY_ENABLED = "true"
# CDP_ENDPOINT = "http://127.0.0.1:9229"
# CDP_GATEWAY_TOKEN = "<long random secret>"
```

Then `codex` and ask it to call `browser_status`. Build first (`npm run build`)
or use `tsx` for development (`command = "npx"`, `args = ["tsx", "src/main.ts"]`).

Any other STDIO-capable client (Claude Desktop, generic MCP hosts) uses the
same recipe: spawn `node dist/src/main.js` with `MCP_TRANSPORT=stdio`.

## 2. ChatGPT desktop app in developer mode (loopback HTTP)

The desktop app connects to local **HTTP** MCP servers, so run the default
Streamable HTTP transport — it listens on `127.0.0.1` only:

```powershell
npm run build
npm start          # serves http://127.0.0.1:9230/mcp
```

Then in the ChatGPT desktop app: **Settings → Developer → Developer mode**
(on) → in a chat use **+ → Connect to a local/developer MCP server** and enter
`http://127.0.0.1:9230/mcp`. The app lists the 16 tools; call `browser_status`
first.

## 3. Manual smoke test: MCP Inspector

The same loopback endpoint can be exercised without any AI client — this is
the Stage 7 acceptance check "Inspector calls browser_status":

```powershell
npx @modelcontextprotocol/inspector
```

Open the Inspector UI, set the transport to Streamable HTTP with URL
`http://127.0.0.1:9230/mcp`, connect, switch to **Tools**, and run
`browser_status`. Expected: `connected` (false until `browser_connect`),
`humanControl.state = "ready"`, and the full list of 16 tools.

## Notes

- STDIO mode and loopback HTTP are equally local: neither binds a public
  address, so no tunnel, token, or firewall work is needed.
- Secrets stay env-only in both scenarios (`CDP_GATEWAY_TOKEN` when the
  gateway is enabled). `.env.example` documents the non-secret variables and
  never contains values.
- All policy layers apply unchanged: domain allowlist, password-field refusal,
  redaction, CAPTCHA pause and hand-over, sensitive-action confirmation.
