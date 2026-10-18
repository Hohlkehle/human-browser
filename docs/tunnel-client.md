# Tunnel client (Stage 7) — Windows

The tunnel client gives **cloud ChatGPT** access to the Browser MCP server
**without publishing the CDP port or the MCP port**. Nothing starts listening
on a public address: `cloudflared` dials **out** to the Cloudflare edge and
forwards requests back to the local, loopback-only MCP endpoint.

```text
Chrome -> CDP (127.0.0.1:9222) -> cdp-gateway (127.0.0.1:9229, optional)
      -> Browser MCP (127.0.0.1:9230) -> tunnel-client (outbound) -> Cloudflare edge -> ChatGPT
```

Hard rules:

- The tunnel origin is **only** `http://127.0.0.1:9230` (the Browser MCP
  endpoint). The config validator rejects every non-loopback origin.
- **Never tunnel raw CDP** (9222) or the gateway (9229): raw CDP bypasses the
  domain allowlist, redaction, password refusal, and the human-control gate.
  `doctor` fails a target whose `/healthz` does not answer
  `{"status":"ok"}` for exactly this reason.
- The tunnel token is an **env-only secret** (`CLOUDFLARE_TUNNEL_TOKEN`). It is
  never stored in config files or the repository, never placed on a command
  line (cloudflared receives it via the `TUNNEL_TOKEN` environment variable),
  and every cloudflared log line is screened for it before printing.

## 1. Install cloudflared

```powershell
winget install --id Cloudflare.cloudflared
# or download cloudflared.exe from the GitHub releases page and set:
# $env:TUNNEL_CLOUDFLARED_BIN = "C:\tools\cloudflared.exe"
cloudflared --version
```

A recent cloudflared (2023.8+) is required because the named mode passes the
token through the `TUNNEL_TOKEN` environment variable.

## 2. Choose a mode

| Mode    | Env             | What you get                                             | Use for            |
| ------- | --------------- | -------------------------------------------------------- | ------------------ |
| `named` | default         | Stable hostname on your own domain, token-authenticated  | Production / daily |
| `quick` | `TUNNEL_MODE=quick` | Ephemeral unauthenticated `https://*.trycloudflare.com` | One-off testing    |

### Named tunnel (recommended)

1. In the Cloudflare Zero Trust dashboard: **Networks → Tunnels → Create a
   tunnel** → connector type **Cloudflared** → copy the **tunnel token**.
2. You do **not** need the dashboard's "install connector" command — this
   project runs cloudflared itself (`npm run tunnel:run`).
3. Add a **public hostname** for the tunnel, e.g.
   `browser-mcp.example.com`, with the service `http://127.0.0.1:9230`
   (the loopback MCP origin — cloudflared runs on this machine).

### Quick tunnel (testing only)

No account, no token: `TUNNEL_MODE=quick`. The URL changes on every start and
is unauthenticated — anyone who sees it can drive the MCP server. Never use it
for anything you care about.

## 3. Set the secret (env only)

```powershell
# current PowerShell session only:
$env:CLOUDFLARE_TUNNEL_TOKEN = "<token from the dashboard>"

# or persist for the user (still outside the repository):
[Environment]::SetEnvironmentVariable("CLOUDFLARE_TUNNEL_TOKEN", "<token>", "User")
```

Never write the token into `.env`, config files, or git. `.env` is gitignored
and `.env.example` deliberately contains no secret values. Rotate the token in
the dashboard if it ever leaks.

## 4. Verify, then run

```powershell
npm run build
# start the Browser MCP server first (separate terminal):
npm start

# verify the whole local chain:
npm run tunnel:doctor

# start the tunnel (Ctrl+C stops it cleanly):
npm run tunnel:run
```

`doctor` checks, in order: Node >= 22, tunnel config (loopback origin),
`cloudflared --version`, token presence (named) / testing-only warning (quick),
`GET /healthz`, `GET /readyz`, and a full MCP exchange — `initialize` +
`tools/list` + a `browser_status` call, the same exchange MCP Inspector and
ChatGPT perform. Exit code 0 means the local chain is healthy (warnings are
allowed).

With `TUNNEL_PUBLIC_URL` set, doctor additionally performs the **remote hop**
through the public tunnel URL (healthz + tools/list + browser_status) — this is
the "test connection" ChatGPT would make:

```powershell
$env:TUNNEL_PUBLIC_URL = "https://browser-mcp.example.com"
npm run tunnel:doctor
```

In quick mode, `tunnel:run` prints the ephemeral URL
(`https://….trycloudflare.com`) as soon as cloudflared reports it; in named
mode watch for `Registered tunnel connection` in the log.

## 5. Connect ChatGPT

### Cloud ChatGPT via the tunnel (custom connector)

1. Open chatgpt.com → **Settings → Apps & Connectors** (or **Connectors**) →
   **Advanced settings → Create custom connector**.
2. URL: `https://browser-mcp.example.com/mcp` (your public hostname + `/mcp`).
3. Save, then in a chat open **+ → Connectors** and enable your connector.
   ChatGPT performs `initialize` + `tools/list` and should show the 15
   `browser_*`/`page_*`/`human_*` tools.
4. Ask it to call `browser_status` as the first smoke test.

Menu names shift between ChatGPT versions; the essential input is always the
Streamable HTTP URL `https://<public-hostname>/mcp`.

### ChatGPT desktop app, developer mode (local — no tunnel)

For a purely local setup the desktop app can talk to the loopback endpoint
directly, no tunnel required:

1. ChatGPT desktop → **Settings → Developer → Developer mode** (toggle on).
2. In a chat: **+ → Connect to a local MCP server / developer server** and
   enter `http://127.0.0.1:9230/mcp` while `npm start` is running.

See [`local-clients.md`](local-clients.md) for the STDIO scenario with
Codex CLI and other local MCP clients.

## 6. Diagnostics: `Chrome -> CDP -> Browser MCP -> tunnel-client -> ChatGPT`

Work hop by hop; each command must succeed before moving to the next.

| # | Hop | Check (PowerShell) | Expected |
| - | --- | ------------------ | -------- |
| 1 | Chrome + CDP | `curl.exe http://127.0.0.1:9222/json/version` | JSON with `Protocol-Version`. If dead: Chrome is not running with `--remote-debugging-port=9222`. |
| 2 | CDP gateway | `curl.exe http://127.0.0.1:9229/healthz` | `{"status":"ok"}`. `curl.exe http://127.0.0.1:9229/json/version` without the bearer token must answer **401**. (Skip when `GATEWAY_ENABLED=false`.) |
| 3 | Browser MCP | `curl.exe http://127.0.0.1:9230/healthz` and `/readyz` | `{"status":"ok"}` from both. |
| 3b | Browser MCP (protocol) | MCP Inspector: `npx @modelcontextprotocol/inspector`, connect to `http://127.0.0.1:9230/mcp`, list tools, call `browser_status` | 15 tools; `browser_status` returns `connected` + `humanControl` state. |
| 4 | tunnel-client | `npm run tunnel:doctor` | All checks `[ ok ]` (quick mode: one `[warn]`). In the `tunnel:run` log: `Registered tunnel connection` (named) or the trycloudflare URL (quick). |
| 5 | Public hop | `$env:TUNNEL_PUBLIC_URL="https://<host>"; npm run tunnel:doctor` | `public-hop [ ok ]` — healthz + tools/list + browser_status through the tunnel. |
| 6 | ChatGPT | Re-test the connector (Settings → Apps & Connectors) or ask ChatGPT to call `browser_status` | Tools visible; `browser_status` answers. |

Common failures:

- **502 from the tunnel** — the tunnel is up but hop 3 is down: start
  `npm start` (doctor's pre-flight warning says exactly this).
- **`cloudflared` not found** — install it or set `TUNNEL_CLOUDFLARED_BIN`.
- **named tunnel refuses to start** — `CLOUDFLARE_TUNNEL_TOKEN` missing in the
  environment of the terminal that runs `tunnel:run`.
- **ChatGPT lists no tools** — verify hop 5 first; if the public hop passes,
  re-check the connector URL ends with `/mcp`.

## 7. Security notes

- The MCP endpoint itself has no bearer auth in this version: the public
  hostname is effectively its credential. Keep it on your own domain, do not
  share it, and stop the tunnel (`Ctrl+C`) when you are done.
- Only the MCP surface is ever published — with all its policy layers (domain
  allowlist, password refusal, redaction, CAPTCHA pause, sensitive-action
  confirmation). Raw CDP must never reach the internet.
- CAPTCHA and login are never automated through the tunnel either: the server
  pauses and hands the visible tab back to you (Stage 6 contract).
