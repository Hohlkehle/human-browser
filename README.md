# Browser MCP

Security-first browser control for a visible Chrome instance through CDP. The
project is being built in ten isolated stages; the current repository contains
Stages 1–10 (scaffold, secure CDP configuration, authenticated CDP gateway,
Playwright/CDP adapter, MCP server and tool schemas, human control, secure MCP
tunnel, Windows deployment and hardening, end-to-end Partslink24 scenario,
MVP acceptance).

## Requirements

- Node.js 22 or newer
- A visible Chrome instance with remote debugging enabled on
  `127.0.0.1:9222` for the gateway to proxy to

## Quick start

```text
npm install
npm run build
npm test
set CDP_GATEWAY_TOKEN=<a long random secret>
npm start
```

The enabled gateway requires the bearer token secret, so `npm start` refuses
to start without `CDP_GATEWAY_TOKEN`. Set `GATEWAY_ENABLED=false` to run the
MCP server directly against the local Chrome CDP endpoint without the gateway.
By default `npm start` serves MCP Streamable HTTP on
`http://127.0.0.1:9230/mcp`; set `MCP_TRANSPORT=stdio` to run the MCP server
over STDIO for local MCP clients. Secrets come from environment variables only;
`.env.example` documents supported variables (it never contains secret
values). Inject them through the process environment or a protected OS secret
store.

## Endpoints

- `127.0.0.1:9230` — MCP Streamable HTTP endpoint `POST /mcp`, plus
  `/healthz`/`readyz`. The HTTP MCP transport stays loopback-only forever;
  remote (cloud) access arrives exclusively through the Stage 7 tunnel client.
  In `MCP_TRANSPORT=stdio` mode no HTTP listener is started.
- `127.0.0.1:9229` (or `0.0.0.0:9229` for LAN use) — the CDP gateway:
  - proxies only `/json/version`, `/json/list`, `/json/new`, `/devtools/*`
    to the local Chrome CDP endpoint;
  - requires `Authorization: Bearer <token>` on every HTTP request and
    WebSocket upgrade;
  - enforces a client IP CIDR allowlist, per-IP rate limiting, and header/body
    size limits;
  - answers `/healthz`/`readyz` locally without any Chrome data;
  - rewrites `webSocketDebuggerUrl` in `/json/*` responses so clients
    (e.g. Playwright `connectOverCDP` with an `Authorization` header) connect
    back through the gateway instead of bypassing it.

For a `0.0.0.0` bind, restrict the port to your subnet in Windows Firewall and
never publish it to the internet: see [`docs/windows-firewall.md`](docs/windows-firewall.md).

## Browser adapter (Stage 4)

`src/browser/` contains `BrowserAdapter`, a typed driver over
`playwright-core.connectOverCDP` that operates the user's existing visible
Chrome. It validates and address-pins the CDP endpoint through the Stage 2
resolver, supports extra `Authorization` headers (for the gateway), and exposes
`list/open/navigate/snapshot/screenshot/click/fill/select/press/wait/extract`
with role/label/text/CSS locators, tab and concurrency limits, per-operation
timeouts and `AbortSignal`. `disconnect()` never terminates Chrome, password
fields can never be filled, and sensitive field values are redacted in
snapshots, extraction results, and logs. It is consumed by the Stage 5 MCP server and is started by `npm start`.

## MCP server (Stage 5)

`src/mcp/` exposes the browser adapter as an MCP server named `browser-mcp`
with 15 tools: `browser_connect`, `browser_status`, `page_list`, `page_open`,
`page_navigate`, `page_snapshot`, `page_screenshot`, `page_click`,
`page_fill`, `page_select`, `page_press`, `page_wait`, `page_extract`,
`human_required`, and `human_resume`.

- Transport: `MCP_TRANSPORT=streamable-http` (default) serves
  `http://127.0.0.1:9230/mcp`; `MCP_TRANSPORT=stdio` speaks MCP over
  stdin/stdout and writes logs to stderr.
- Security: server instructions forbid cookies, saved passwords, tokens,
  arbitrary JavaScript, and CAPTCHA solving. Tool errors are structured as
  `{ code, message, retryable, pageId? }`. `page_fill` refuses password
  fields, and `page_open`/`page_navigate` enforce `BROWSER_ALLOWED_DOMAINS`.
- Human control: `human_required` pauses all `page_*` tools until
  `human_resume` is called; Stage 6 extends this into the full human-control
  state machine (see below).

## Human control (Stage 6)

`src/human/` and `src/policy/` implement the pause-and-hand-over contract for
moments that must never be automated: CAPTCHAs, logins, and sensitive actions.

- CAPTCHA pause: after `page_open`, `page_navigate`, `page_click`, and
  `page_press`, a server-internal challenge scan (URL, iframe URLs, visible
  text) is classified by `src/human/challenge.ts` (reCAPTCHA, hCaptcha,
  Turnstile, GeeTest, Arkose, Yandex, and a generic fallback; EN/RU/DE
  phrases). On a hit the gate pauses, the tab is brought to the front, and the
  tool returns `captcha_detected` with the `pageId`, hostname, and a safe
  explanation. The scan content never leaves the server. A CAPTCHA is never
  solved automatically — the user completes it in the visible tab.
- Visible mode: `connect()` refuses a headless browser
  (`BROWSER_VISIBLE_MODE_REQUIRED`, default on) so the user can always see the
  tab they are taking over.
- State machine: `src/human/gate.ts` tracks `ready`, `running`,
  `human_required`, `waiting_for_user`, `resuming`, and `failed`. If the user
  does not resume within `HUMAN_TIMEOUT_MS` (default 300000) the gate fails and
  tools report `human_timeout`.
- Resume verification: `human_resume` re-scans and returns
  `challenge_still_present` (retryable) if the challenge has not been cleared.
- Sensitive actions: `page_click` classifies the target by its accessible name
  (`purchase`, `message`, `account_change`). A sensitive click requires a
  single-use `confirmToken` from `src/policy/confirm.ts`; without one it returns
  `confirmation_required` (retryable) plus a fresh token.

## Tunnel client (Stage 7)

`src/tunnel/` gives cloud ChatGPT access without publishing the CDP or MCP
ports: `cloudflared` dials **out** to the Cloudflare edge and forwards back to
the loopback-only MCP endpoint. Raw CDP is never tunneled — the config
validator accepts only a loopback `http` origin, and `doctor` fails any target
whose `/healthz` does not answer `{"status":"ok"}`.

```powershell
npm run tunnel:doctor   # verify Chrome -> CDP -> Browser MCP -> tunnel chain
npm run tunnel:run      # start the outbound tunnel (Ctrl+C stops)
```

- Modes: `named` (default; stable hostname, token from the env-only secret
  `CLOUDFLARE_TUNNEL_TOKEN`) and `quick` (`TUNNEL_MODE=quick`; ephemeral
  unauthenticated `*.trycloudflare.com` URL, testing only).
- The token is never stored in config or the repository, never placed on a
  command line (cloudflared receives it via `TUNNEL_TOKEN` env), and every
  cloudflared log line is screened for it.
- `doctor` performs the same MCP exchange clients do (`initialize` +
  `tools/list` + `browser_status`); with `TUNNEL_PUBLIC_URL` it also verifies
  the remote hop through the public URL — the test connection ChatGPT makes.
- Windows setup, ChatGPT connector / developer-mode wiring, and hop-by-hop
  diagnostics: [`docs/tunnel-client.md`](docs/tunnel-client.md). Local clients
  without a tunnel (Codex CLI STDIO, ChatGPT desktop developer mode, MCP
  Inspector): [`docs/local-clients.md`](docs/local-clients.md).

## Windows service deployment (Stage 8)

`scripts/windows/` turns the built server into a permanent, hardened Windows
deployment: a dedicated least-privileged account (`bmcp-svc`, service-logon
only, no admin rights), the gateway+MCP as the `BrowserMcp` service (autostart,
restart-on-failure, supervised by a compiled C# wrapper that performs graceful
CTRL_C stops and crash restarts), secrets in the service account's Credential
Manager (never on disk, never in argv), non-secret config in
`C:\ProgramData\browser-mcp\service.env`, and bounded redacted logs with
size/count/age rotation.

```powershell
# elevated PowerShell
.\scripts\windows\install.ps1 -Subnet 192.168.88.0/24 -GatewayToken '<secret>'
.\scripts\windows\security-checklist.ps1     # 19 automated checks
.\scripts\windows\rotate-token.ps1           # bearer token rotation
.\scripts\windows\emergency-stop.ps1         # kill all access NOW (-Revert to undo)
.\scripts\windows\upgrade.ps1                # snapshot -> rebuild -> verify
.\scripts\windows\rollback.ps1               # restore the previous release
.\scripts\windows\uninstall.ps1              # remove services/rules/secrets
```

The installer scopes Windows Firewall inbound TCP 9229 to your subnet only
(9222/Chrome stays loopback-only with no rule) and finishes with an embedded
checklist run that also probes the ports from the WSL2 VM to prove the
firewall for real. Full runbook: [`docs/windows-deployment.md`](docs/windows-deployment.md);
firewall background: [`docs/windows-firewall.md`](docs/windows-firewall.md).

## Partslink24 end-to-end scenario (Stage 9)

`src/scenarios/` proves the reference flow on `www.partslink24.com` without
the AI ever seeing a password: open the site → login wall? `human_required`,
the user signs in manually in Chrome → `human_resume` → VIN search → CAPTCHA?
`human_required` again, the user solves it → resume continues the SAME
tab/session → extract ONLY the requested part numbers and applicability.

- `runPartslink24Scenario` is a transport-agnostic engine that calls the 15
  MCP tools like any AI client and invokes a `waitForUser` callback at every
  handoff; it never fills/reads credentials, never consumes a confirm token
  (purchases/orders are never confirmed), and aborts on sensitive actions.
- VIN privacy (`src/policy/vin.ts`): the VIN reaches only `page_fill` (never
  echoed or logged); logs, reports and console output carry only the masked
  form (`WVWZZZ1KZAW123456` → `WVW********123456`).
- CI mock scenario: `tests/integration/partslink24-e2e.test.ts` runs the FULL
  flow against a local cookie-based Partslink24-like fixture (real Chrome +
  real MCP server + SDK client) — no contact with the real site; the simulated
  human acts by hand, automation never POSTs the login form.
- Real run: `npm run e2e:partslink24` (console prompts at every handoff).
  Runbook, locator tuning and recorded real results:
  [`docs/partslink24-e2e.md`](docs/partslink24-e2e.md).

## MVP (Stage 10)

The MVP release criteria (`promts/10-mvp.md`) are all verified:

- the server connects to the configured private CDP endpoint;
- ChatGPT sees the MCP tools (15 tools via `tools/list`);
- a site can be opened, clicked, and its text extracted;
- CAPTCHA and login are always handed to the user (never automated);
- an existing authenticated session is preserved across server restarts;
- raw cookies and passwords are never accessible to the model;
- CDP is never published to the internet;
- there is a working Partslink24/Partsouq test.

Re-verify at any time:

```powershell
npm test                          # 395 tests incl. mvp-acceptance + e2e mock
node scripts/verify-mvp-smoke.mjs # live smoke against the built server
```

The smoke script boots a disposable Chrome + local fixture, starts the built
server on the private CDP endpoint, and performs the same MCP exchange
ChatGPT does (`initialize` + `tools/list` + open/click/extract), also proving
the MCP listener is bound to loopback only.

## Prompts

The implementation prompts are in [`promts/`](promts/). Run only one stage at a
time and keep `docs/progress.md` current.

## Security boundary

The first version must not expose cookies, Local Storage, saved passwords,
tokens, arbitrary JavaScript evaluation, arbitrary CDP commands, or automatic
CAPTCHA solving. An enabled gateway must have both a bearer token and an IP
CIDR allowlist or it refuses to start; query strings, Authorization headers,
and CDP frames are never logged. The Streamable HTTP MCP endpoint listens only
on loopback — remote access exists solely through the outbound Stage 7 tunnel,
which forwards to the MCP endpoint only and never to raw CDP. STDIO mode keeps
stdout reserved for MCP JSON-RPC. Tunnel secrets (`CLOUDFLARE_TUNNEL_TOKEN`,
`CDP_GATEWAY_TOKEN`) live in the process environment only; under the Stage 8
Windows service deployment they are injected at start from the service
account's Credential Manager and never persisted to disk or command lines.
