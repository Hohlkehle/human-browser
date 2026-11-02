# Progress

## Stage 1: scaffold

- Status: implemented in this repository.
- Added strict TypeScript configuration, Zod environment configuration, Pino
  redaction, health endpoints, graceful SIGINT/SIGTERM shutdown, tests, and
  project documentation.
- Verification: `npm run build`, `npm run lint`, `npm run typecheck`, and
  `npm test` pass. Vitest reports 3 passing unit tests.
- Re-verification (static): readiness checklist confirmed — Node >= 22,
  strict TypeScript, required packages (`@modelcontextprotocol/sdk`,
  `playwright-core`, `zod`, `pino`), Vitest/ESLint/Prettier, all required
  directories (`src/config`, `src/cdp`, `src/browser`, `src/mcp`,
  `src/policy`, `src/human`, `src/logging`, `tests/unit`,
  `tests/integration`, `docs`), scripts `dev`/`build`/`start`/`lint`/
  `typecheck`/`test`, Zod-validated config, env-only secrets, secret-free
  `.env.example`, architecture and threat-model docs.
- Earlier pass: `src/main.ts` calls `server.closeIdleConnections()` during
  shutdown so idle keep-alive sockets cannot delay termination on SIGINT/SIGTERM.
- Re-verification on Windows (current pass): all four checks re-run green —
  `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` each exit 0
  (Vitest 3/3). No source changes were required; the scaffold already met every
  readiness criterion.
- Graceful SIGINT shutdown re-proved live via
  `scripts/verify-graceful-shutdown-windows.ps1`: the server is spawned with
  `CreateProcess` using `CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP`,
  `/healthz` returns 200, then `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` is
  broadcast after `AttachConsole` + `SetConsoleCtrlHandler(NULL, TRUE)`. The
  process exited with code 0 (not `0xC000013A` / STATUS_CONTROL_C_EXIT),
  proving the SIGINT handler ran and the event loop drained cleanly.
- Windows caveat confirmed: Node's `subprocess.kill('SIGINT')` does NOT invoke
  the child's SIGINT handler on Windows (it terminates the child abruptly, so no
  `shutdown requested`/`server stopped` logs appear). The
  `GenerateConsoleCtrlEvent` path is therefore the only valid Windows
  verification and is now captured as the script above.
- Limitations: this is not yet an MCP server, CDP gateway, Playwright adapter,
  human-control state machine, tunnel client, or Windows service. SIGTERM
  handling is registered but cannot be exercised on Windows (it maps to
  unconditional `TerminateProcess`); it must be re-verified on Linux/WSL.

## Stage 2: secure CDP configuration

- Status: implemented.
- New module `src/cdp/ip.ts`: dependency-free IPv4/IPv6 parsing, security
  classification (loopback, private/RFC1918+ULA, link-local, multicast,
  broadcast, unspecified, public), CIDR parsing/matching, IPv4-mapped and
  IPv4-compatible IPv6 addresses are classified by their embedded IPv4 address.
  CGNAT (100.64.0.0/10), 2001:db8::/32, 6to4, and Teredo are treated as public.
- New module `src/cdp/endpoint.ts`: secure CDP endpoint validation.
  - Only `http/https/ws/wss` schemes; credentials in the URL are rejected.
  - Default allowance is loopback + RFC1918 only; link-local, multicast,
    broadcast, unspecified, and public addresses are rejected unless explicitly
    permitted via an administrator `allowedCidrs` policy.
  - Hostnames are resolved with `all: true` (A + AAAA); if ANY answer is
    forbidden the whole endpoint is rejected (mixed-record attacks).
  - DNS rebinding defense: validated addresses are returned as
    `pinnedAddresses`, and the `/json/version` probe connects to the pinned
    address directly (DNS is never consulted again; TLS SNI/identity stays on
    the original hostname for `https/wss`).
  - `/json/version` probe requires HTTP 200, valid JSON object, and a
    non-empty `Protocol-Version`; response body is capped at 64 KiB.
  - `webSocketDebuggerUrl` is never returned or logged raw; only
    `scheme://host/[REDACTED]` survives (`redactDebuggerUrl`).
  - Timeouts (`AbortSignal.timeout`, default 10 s), caller cancellation
    (`AbortSignal`), and typed `CdpEndpointError` codes
    (`invalid_url`, `unsupported_scheme`, `credentials_forbidden`,
    `dns_resolution_failed`, `address_forbidden`, `probe_failed`,
    `invalid_version_response`, `missing_protocol_version`, `timeout`,
    `aborted`).
- `src/config/schema.ts` hardened: `cdp.endpoint` must be a valid URL with an
  allowed scheme and no credentials; `cdp.allowedCidrs` and
  `gateway.allowedCidrs` entries must parse as valid CIDRs.
- Tests: `tests/unit/ip.test.ts` (15) and `tests/unit/cdp-endpoint.test.ts`
  (26) cover IPv4/IPv6 literals, hostnames, mixed DNS records, DNS failure,
  admin CIDR override, a live local `/json/version` server, missing
  Protocol-Version, non-200, non-JSON bodies, timeout, cancellation, debugger
  URL redaction, and a simulated DNS-rebinding attack (probe succeeds against
  the pinned loopback address while DNS re-resolves to a public address, and
  DNS is consulted exactly once). `tests/unit/config.test.ts` extended to 7
  tests. Accepted endpoints verified: `http://127.0.0.1:9222`,
  `http://10.252.150.2:9229`; arbitrary public URLs are rejected.
- Verification: `npm run typecheck`, `npm run lint`, `npm run build`, and
  `npm test` all exit 0 (Vitest 48/48).
- Limitations: the module is not yet wired into a running component — the
  scaffold's `main.ts` is intentionally untouched; the gateway (Stage 3) and
  the Playwright adapter (Stage 4) must consume `resolveSecureCdpEndpoint` /
  `probeCdpVersion` and keep connections pinned to `pinnedAddresses`. The
  `https/wss` probe path is implemented but not exercised by tests (no local
  TLS fixture). DNS resolution in `resolveSecureCdpEndpoint` itself is not
  abortable mid-flight; cancellation is checked before and after.

## Stage 3: secure CDP gateway

- Status: implemented.
- New module `src/cdp/rate-limit.ts`: dependency-free fixed-window rate
  limiter keyed by client IP; injectable clock, lazy pruning of stale windows,
  no timers (never delays shutdown).
- New module `src/cdp/gateway.ts`: authenticated CDP proxy built on
  `http-proxy`, wired into `src/main.ts` behind `GATEWAY_ENABLED`.
  - Listens on the configured host/port (`0.0.0.0:9229` for LAN deployments,
    loopback default) and proxies HTTP + WebSocket to the Chrome CDP endpoint.
  - Consumes the Stage 2 resolver: the upstream target is validated with
    `resolveSecureCdpEndpoint` (scheme/credentials/address policy) and the
    proxy connects to the **pinned** address; DNS is never consulted again.
  - Path allowlist: only `/json/version`, `/json/list`, `/json/new` over HTTP
    and `/devtools/*` for WebSocket upgrades; trailing slashes accepted
    (Playwright requests `/json/version/`); dot segments normalized so
    traversal cannot bypass the allowlist. Everything else is 404.
  - Bearer authentication (constant-time, SHA-256 normalized
    `timingSafeEqual`) on both HTTP requests and WS upgrades; the client token
    is stripped before forwarding upstream.
  - CIDR allowlist on the remote IP for every request incl. health and
    upgrades; IPv4-mapped IPv6 addresses are folded back to IPv4 so they
    cannot bypass IPv4 CIDRs; IPv6 zone ids stripped.
  - Per-IP rate limiting (default 120 req/60 s, configurable via
    `GATEWAY_RATE_LIMIT_WINDOW_MS` / `GATEWAY_RATE_LIMIT_MAX`) with
    `Retry-After`; limits apply before authentication to throttle brute force.
  - Size limits: request headers 8 KiB (431), request body 64 KiB (413,
    response flushed before teardown), buffered upstream responses 1 MiB
    (502); upstream down yields 502.
  - Refuses to be constructed without a bearer token or with an empty/invalid
    CIDR allowlist; `validateStartupSecurity` now requires the token for ANY
    enabled gateway bind (strengthened from the previous 0.0.0.0-only check).
  - `/healthz` and `/readyz` are answered locally, without auth, without any
    Chrome data, and are never proxied.
  - `webSocketDebuggerUrl` values in `/json/*` responses are rewritten to the
    client-facing gateway host so Playwright `connectOverCDP` connects back
    through the gateway instead of straight to the upstream Chrome port.
  - Logging: only reason + pathname (query strings stripped via `URL`
    parsing), never headers/tokens; no CDP frame content is ever touched or
    logged. Pino redaction from Stage 1 retained.
  - Graceful shutdown: upgraded sockets are tracked and destroyed explicitly
    (`server.close()` alone neither waits for nor drops them), idle keep-alive
    sockets dropped via `closeIdleConnections()`, dedicated no-keep-alive
    upstream agent destroyed; new requests during shutdown get 503.
    http-proxy@1.18 quirk handled: `proxy.close(cb)` never invokes `cb` when
    the proxy owns no server, so it must not be awaited.
- New docs: `docs/windows-firewall.md` — subnet-scoped `netsh` rule for
  9229, deletion of any `remoteip=any`/9222 rules, verification commands, and
  an explicit ban on internet publication (port forwarding/tunnels).
- Tests (46 new, 94 total):
  - `tests/unit/rate-limit.test.ts` (5): budget, per-key isolation, window
    reset, lazy pruning, option validation.
  - `tests/unit/cdp-gateway.test.ts` (19): pathname/query/traversal handling,
    path allowlists incl. trailing slash, bearer verification, remote-address
    normalization (incl. `::ffff:` mapping), CIDR matching, debugger-URL
    rewriting, startup refusal (no token / no CIDRs / bad CIDR / forbidden
    target).
  - `tests/integration/cdp-gateway.test.ts` (18) against a dependency-free
    fake CDP upstream (`tests/helpers/fake-cdp-upstream.ts`, minimal RFC 6455
    server in `tests/helpers/ws.ts`): 401 for HTTP without/with wrong token,
    401 for unauthorized WS upgrade, 403 for an IP outside the allowlist
    (HTTP + WS), 404 outside the path allowlist, 429 rate limiting with
    `Retry-After`, 431 headers / 413 body / 502 upstream-down, health
    endpoints without Chrome data and not proxied, debugger-URL rewriting,
    end-to-end authenticated WS CDP session, **Playwright
    `chromium.connectOverCDP` through the gateway with an Authorization
    header** (version handshake verified against the fake upstream), and
    graceful shutdown terminating an open WS and stopping the listener.
  - `tests/unit/config.test.ts` extended (11): token required for any enabled
    gateway incl. loopback, disabled gateway skips checks, rate-limit env
    parsing.
- Live smoke check on Windows: `node dist/src/main.js` without the token logs
  `fatal: Gateway refuses to start without secret CDP_GATEWAY_TOKEN` and exits
  1; with the token both health endpoints answer 200, unauthenticated
  `/json/version` answers 401, authenticated request proxies to Chrome
  (502 while Chrome is not running).
- Verification: `npm run typecheck`, `npm run lint`, `npm test` (94/94), and
  `npm run build` all exit 0.
- Limitations: rate limiting is per-process in-memory (fine for a single
  gateway instance); WS frame size is not limited after the upgrade (the
  proxied stream is opaque by design — frames are never inspected or logged);
  `devtoolsFrontendUrl` in `/json/*` responses is not rewritten; the
  loopback-bound gateway still requires a token but the CIDR/firewall layers
  only become meaningful on non-loopback binds.

## Stage 4: Playwright/CDP adapter

- Status: implemented.
- New module `src/browser/adapter.ts`: `BrowserAdapter` built on
  `playwright-core.connectOverCDP`, driving the user's existing visible Chrome
  without ever extracting secrets.
  - Connection: consumes the Stage 2 resolver end to end. The endpoint is
    validated with `resolveSecureCdpEndpoint` (scheme/credentials/address
    policy + DNS pinning), probed with `probeCdpVersion`, and the CDP
    WebSocket hop connects to the **pinned** address: for `http(s)` endpoints
    the adapter fetches `webSocketDebuggerUrl` itself (pinned, authenticated)
    and rebuilds it on the validated address, so DNS is never consulted twice
    even for hostname endpoints. Extra headers (e.g. the gateway
    `Authorization` bearer) are sent on every probe and connect request; a
    caller-supplied `host` header is always ignored.
  - `disconnect()` never terminates the user's Chrome: on a CDP-attached
    browser `browser.close()` only detaches. Proven live: after disconnect the
    CDP endpoint still answers `/json/version` and the tabs are still listed
    in `/json/list` (integration test).
  - Stable internal identifiers: monotonically increasing `page-N` / `ctx-N`
    ids in a registry; ids are never reused, tabs opened outside Playwright
    are picked up on the next `listPages`, closed tabs are pruned. After a
    reconnect ids are re-issued (old ones become `unknown_page`) because the
    underlying Playwright `Page` objects are new.
  - Operations: `listPages`, `openPage`, `navigate`, `snapshot`, `screenshot`,
    `click`, `fill`, `selectOption`, `press`, `wait`, `extract`. No API
    evaluates caller-provided JavaScript; extraction uses fixed Playwright
    accessors only (`innerText`/`textContent`/`getAttribute`).
  - Locators: `role` (with optional accessible name/exact), `label`, `text`,
    and CSS only — `xpath=`, `text=`, `id=`, `internal:*` and other engine
    prefixes are rejected; strict mode is kept, `nth` disambiguates.
  - Limits: `maxTabs` (default 8, counts ALL open tabs incl. the user's),
    `maxConcurrentOperations` (default 4) with a bounded FIFO queue
    (`maxQueuedOperations`, default 16) that rejects with
    `too_many_operations` instead of piling up; extraction and snapshot output
    are capped (`maxExtractItems`, `maxExtractCharsPerItem`, `maxExtractChars`,
    `maxSnapshotChars`, `maxScreenshotBytes`).
  - Every operation has a timeout (default 30 s) and honours an
    `AbortSignal`; typed error codes (`timeout`, `aborted`, `page_closed`,
    `browser_disconnected`, `not_connected`, `unknown_page`,
    `tab_limit_exceeded`, `too_many_operations`, `locator_invalid`,
    `sensitive_field_forbidden`, `endpoint_forbidden`, `connect_failed`, ...).
  - Tab closure and Chrome restart: closed tabs surface as `page_closed` /
    `unknown_page`; an unexpected disconnect clears the registry and further
    operations fail with `not_connected`; calling `connect()` again re-attaches
    to the restarted Chrome (integration-tested with a real kill + restart on
    the same port).
  - Secret hygiene: `fill` refuses `input[type=password]` and
    `autocomplete=current-password|new-password` fields; ARIA snapshots are
    redacted before they leave the adapter (values of sensitive-named fields
    and of ALL unnamed value-bearing fields become `[REDACTED]`); `extract`
    returns `[REDACTED]` for password fields; connect errors strip URL paths
    so the secret `webSocketDebuggerUrl` id can never leak; logs carry only
    endpoint origins, op names, and error codes — never values, URLs, or
    tokens. `connectOverCDP` runs with `noDefaults: true` so Playwright does
    not override the user's default-context settings.
- New module `src/browser/redact.ts`: line-based ARIA-snapshot redaction
  (preserves YAML structure) + `isPasswordField` helper; sensitive-name
  patterns cover password/пароль, card number, CVV, OTP, PIN, tokens, keys,
  recovery phrases, etc., with guards against over-matching (`author`,
  `spinning`).
- New module `src/browser/semaphore.ts`: dependency-free FIFO concurrency gate
  with a bounded queue and abortable waiting; no timers, never delays shutdown.
- New module `src/browser/locator.ts`: validated `LocatorSpec` model
  (role/label/text/css) and strict-mode resolution to Playwright locators.
- Stage 2 module extended (additive, backward-compatible): `probeCdpVersion`
  accepts extra `headers` (needed to probe the authenticated gateway; a
  caller `host` header is ignored), and new `fetchCdpWebSocketDebuggerUrl`
  returns the raw debugger URL for in-process pinning only (documented as a
  connection credential that must never be logged).
- Stage 3 gateway hardened: log-safe `redactPathnameForLog` — `/devtools/*`
  paths carry the secret target id, so all gateway log lines now record
  `/devtools/[REDACTED]` instead of the full path.
- Tests (61 new, 155 total):
  - `tests/unit/browser-redact.test.ts` (9): snapshot redaction incl. Russian
    field names, unnamed fields, attribute preservation, over-match guards.
  - `tests/unit/browser-semaphore.test.ts` (9): concurrency cap, FIFO order,
    queue-full rejection, abortable waiters, idempotent release.
  - `tests/unit/browser-adapter.test.ts` (16): config validation,
    `not_connected`/`closed` states, endpoint policy (public/credentials/dead
    port), no secret-path leakage in errors, connect abort, locator spec
    validation incl. engine-prefix rejection.
  - `tests/unit/cdp-endpoint.test.ts` (+4): probe headers, host-header
    pinning, raw debugger-URL fetch.
  - `tests/unit/cdp-gateway.test.ts` (+2): pathname redaction for logs.
  - `tests/integration/browser-adapter.test.ts` (21) against a real disposable
    Chrome (`tests/helpers/test-chrome.ts`: temp profile, loopback CDP port,
    headless by default, process-tree kill, auto-skip when no Chrome is
    installed): connect/status, stable ids + externally opened tabs,
    navigate + snapshot redaction, scheme/credential navigation rejection,
    PNG screenshot, click (role/CSS), fill + password refusal (type and
    autocomplete), select by label, press, wait (visible/loadState/timeout),
    AbortSignal, extract (limits + password redaction + page mode), tab limit,
    concurrency queue rejection, unknown page, tab closed via `/json/close`,
    **disconnect leaves Chrome and tabs running then reconnects**, Chrome
    restart + reconnect, connect through the Stage 3 gateway with an
    `Authorization` header (and 401 with a wrong token), direct `ws://`
    endpoint connect.
- Verification: `npm run typecheck`, `npm run lint`, `npm test` (155/155), and
  `npm run build` all exit 0. New Stage 4 files are prettier-formatted
  (earlier-stage files predate prettier enforcement and were left untouched).
- Limitations: the adapter is not yet wired into `src/main.ts` — the MCP
  server (Stage 5) is its consumer and will map config → adapter options,
  add the domain allowlist for `navigate`, and expose the operations as MCP
  tools. `pageId`s are re-issued after a reconnect (Playwright page objects
  are new; matching old ids would require CDP target ids). Redaction of
  snapshot values is name-based: a sensitive field with a non-sensitive
  accessible name and no `type=password` is not masked (unnamed fields ARE
  masked). `https/wss` hostname endpoints are validated and probed, but the
  pinned TLS connection presents the pinned IP as SNI — use IP literals or
  the gateway for TLS deployments. Screenshot size is checked after capture.

## Stage 5: MCP server and tool schemas

- Status: implemented.
- New module `src/policy/domains.ts`: `createDomainPolicy()` for the browser
  domain allowlist. Exact host match, explicit `*.example.com` wildcards,
  `http/https` only, `about:blank` allowed, credentials in URLs rejected,
  IPv6 brackets stripped; typed errors `invalid_policy`, `invalid_argument`,
  `domain_forbidden`.
- New module `src/human/gate.ts`: minimal Stage 5 human-control gate with
  `ready` / `waiting_for_user`, `pause()`, `resume()`, `snapshot()`, and a
  500-character pause reason limit. CAPTCHA detection, visible-mode
  enforcement, and the full state machine are Stage 6.
- New module `src/mcp/schemas.ts`: Zod input/output schemas for all tools,
  compile-time-checked ARIA role list, discriminated locator schema
  (`role`/`label`/`text`/`css`), structured tool error schema
  `{ code, message, retryable, pageId? }`, and `toolOutputSchema()` which
  merges optional success fields with an optional `error` branch so SDK
  output-schema validation works for both success and `isError` results.
- New module `src/mcp/tools.ts`: registers the 15 tools
  (`browser_connect`, `browser_status`, `page_list`, `page_open`,
  `page_navigate`, `page_snapshot`, `page_screenshot`, `page_click`,
  `page_fill`, `page_select`, `page_press`, `page_wait`, `page_extract`,
  `human_required`, `human_resume`) with side-effect annotations, structured
  error mapping, retryable-code classification, URL redaction in error
  messages, password-fill refusal, domain allowlist checks before adapter
  calls, and human-gate blocking of all `page_*` tools while paused.
- New module `src/mcp/server.ts`: `createBrowserMcpServer()` with
  `SERVER_NAME = 'browser-mcp'`, security `SERVER_INSTRUCTIONS`, and a
  `build()` factory that creates a fresh `McpServer` per transport.
- New module `src/mcp/http.ts`: loopback-only Streamable HTTP MCP endpoint.
  `POST /mcp` creates a stateless per-request transport/server pair because
  the SDK refuses to reuse stateless transports; `GET/DELETE /mcp` answer
  JSON-RPC method-not-allowed; `/healthz` and `/readyz` return
  `{ status: 'ok' }`; request bodies are capped at 2 MiB; invalid JSON is 400
  and oversized bodies are 413. Non-loopback `MCP_LISTEN_HOST` is rejected
  until the Stage 7 tunnel.
- `src/main.ts` rewired: loads config, validates startup security, starts the
  Stage 3 gateway when enabled, creates the Stage 4 adapter with derived
  gateway bearer headers, and serves MCP over STDIO or Streamable HTTP.
  STDIO mode keeps stdout protocol-clean and has no HTTP listener; shutdown
  order is MCP transport/server, adapter dispose, gateway close.
- `src/logging/logger.ts` now writes Pino logs to stderr so STDIO stdout is
  reserved for MCP JSON-RPC.
- `src/config/schema.ts` adds `deriveAdapterHeaders()`: the adapter receives
  `Authorization: Bearer <token>` only when the configured CDP endpoint points
  at the enabled gateway by matching host/wildcard and port.
- Tests (59 new, 214 total):
  - `tests/unit/domain-policy.test.ts` (13)
  - `tests/unit/human-gate.test.ts` (5)
  - `tests/unit/mcp-tools.test.ts` (16) using an SDK client and fake adapter
  - `tests/unit/mcp-http.test.ts` (5) transport-level HTTP behavior
  - `tests/integration/mcp-http.test.ts` (11) real Chrome + SDK client over
    Streamable HTTP
  - `tests/integration/mcp-stdio.test.ts` (3) real spawned process over STDIO
  - `tests/unit/config.test.ts` extended (+6) for `deriveAdapterHeaders()`.
- Verification: `npm run typecheck`, `npm run lint`, `npm run build`, and
  `npm test` all exit 0 (Vitest 214/214). Live built-server smoke: HTTP
  `/healthz` 200, MCP `initialize` 200, and a live SDK Streamable HTTP client
  listed exactly the 15 tools. MCP Inspector CLI was also used against
  `http://127.0.0.1:9230/mcp` for `tools/list`.
- Limitations: human control is only the minimal pause/resume gate required
  by Stage 5; CAPTCHA detection, visible-mode enforcement, and timeout/state
  machine arrive in Stage 6. Streamable HTTP is loopback-only and stateless;
  no tunnel/auth for remote MCP yet (Stage 7). Domain policy is enforced for
  `page_open`/`page_navigate`, not for links clicked inside an already
  allowed page.

## Stage 6: human control (CAPTCHA pause + sensitive-action confirmation)

- Status: implemented.
- New module `src/human/challenge.ts`: pure, server-internal probable-CAPTCHA
  detection. `detectChallenge()` classifies gathered signals (`ChallengeSignals`)
  into a provider + confidence; `describeChallenge()` renders a safe,
  content-free explanation; `challengeProviderLabel()` maps provider ids to
  display names. Providers: recaptcha, hcaptcha, turnstile, geetest, arkose,
  yandex, and a generic fallback. Detection matches provider iframe URLs, the
  main-frame URL, and challenge phrases in EN/RU/DE. The gathered
  `visibleText`/`frameUrls` are classifier inputs only and never leave the
  server (never returned to the model, never logged).
- `src/human/gate.ts` rewritten from the Stage 5 two-state pause/resume gate
  into the full human-control state machine: `ready`, `running`,
  `human_required`, `waiting_for_user`, `resuming`, `failed`.
  `createHumanGate(options)` (options-object API) exposes `state()`,
  `snapshot()`, `isPaused()`, `operationStarted()`, `operationFinished()`,
  `challengeDetected()`, `pause()`, `beginResume()`, `completeResume()`,
  `abortResume()`, and `dispose()`. The wait-for-user timer defaults to
  `DEFAULT_HUMAN_TIMEOUT_MS = 300_000` and is `unref()`ed so it never delays
  shutdown; expiry moves the gate to `failed` (surfaced as `human_timeout`).
  Pause reasons are capped at `MAX_PAUSE_REASON_CHARS = 500`.
- New module `src/policy/confirm.ts`: sensitive-action confirmation.
  `classifySensitiveAction()` maps an element's accessible name to a category
  (`purchase`, `message`, `account_change`); `createConfirmationGate()` issues
  single-use `confirmToken`s with a 300000 ms TTL and a
  `MAX_PENDING_CONFIRMATIONS = 100` bound; `sensitiveActionLabel()` renders a
  human label for the category.
- `src/cdp/endpoint.ts` (additive): `CdpVersionInfo.userAgent` is captured from
  `/json/version` so the adapter can detect headless browsers. Only the presence
  of the headless marker is ever surfaced — never the UA string itself.
- `src/browser/adapter.ts` extended for human control:
  - `visibleModeRequired` (default `true`): `connect()` refuses a headless
    browser (`HeadlessChrome` in the `/json/version` User-Agent) with
    `endpoint_forbidden` BEFORE any Playwright attach — the user must be able to
    SEE the tab to take over. Disabled only for automated tests.
  - `challengeScan()`: gathers server-internal challenge signals (url, title,
    frame URLs, capped visible text; `maxChallengeTextChars` default 8000). Uses
    fixed Playwright accessors only; no JavaScript is evaluated.
  - `bringToFront()`: activates the challenged tab so the user can see it.
  - `describeLocator()`: returns an element's accessible name / visible text
    (capped at `MAX_ELEMENT_DESCRIPTION_CHARS = 200`) for the sensitive-action
    check; input VALUES are never read.
- `src/mcp/schemas.ts` extended: the six human-control states;
  `humanControlStatusSchema` carries `kind`/`hostname`/`provider`/`pausedAt`/
  `timeoutAt`; `pageClickInputSchema` accepts an optional `confirmToken`;
  `pageClickOutputShape` adds `confirmToken`/`sensitiveAction`/`description`;
  `humanRequiredOutputShape` uses the paused-state enum; new error codes are
  documented in `toolErrorDetailSchema`.
- `src/mcp/tools.ts` rewired for human control:
  - All `page_*` tools are blocked while the gate is paused/human-required and
    return `human_required` (or `human_timeout` once the gate has failed).
  - A `challengeGuard` runs after `page_open`, `page_navigate`, `page_click`,
    and `page_press`: on a detected challenge it pauses the gate, calls
    `bringToFront`, and returns `captcha_detected` with the `pageId`, hostname,
    and a safe explanation (scan content is never returned).
  - `human_resume` verifies the challenge is gone when the pause was
    `kind: 'challenge'` and returns `challenge_still_present` (retryable) if it
    is still present.
  - `page_click` runs the sensitive-action check via `describeLocator` +
    `classifySensitiveAction`; a sensitive click without a valid `confirmToken`
    returns `confirmation_required` (retryable) plus a fresh token.
  - `RETRYABLE_CODES` now includes `challenge_still_present` and
    `confirmation_required`; the challenge scan and element describe use 5000 ms
    budgets so they cannot stall a tool call.
- `src/mcp/server.ts`: updated `SERVER_INSTRUCTIONS` for the human-control
  contract; a single `confirmationGate` is created once and shared across server
  instances (exposed on the server handle).
- `src/main.ts`: passes `config.browser.visibleModeRequired` to the adapter,
  creates the `humanGate` with `config.humanTimeoutMs` (env `HUMAN_TIMEOUT_MS`,
  default 300000) plus an `onTimeout` log hook, and disposes the gate during
  shutdown.
- Tests (109 new/changed, 323 total):
  - `tests/unit/challenge-detection.test.ts` (28, new): provider URL/iframe/text
    detection across EN/RU/DE, generic fallback, safe description rendering.
  - `tests/unit/sensitive-actions.test.ts` (47, new): sensitive-action
    classification and the confirmation gate (single-use tokens, TTL, bound).
  - `tests/unit/human-gate.test.ts` (18, rewritten): full state-machine
    transitions incl. challenge pause, resume verification, and timeout→failed.
  - `tests/unit/mcp-tools.test.ts` (31): challenge pause flow, `human_timeout`,
    and the confirmation-required/confirm flow.
  - `tests/unit/browser-adapter.test.ts` (16): the new methods return
    `not_connected` before connect.
  - `tests/unit/cdp-endpoint.test.ts` (31): `userAgent` capture.
  - `tests/integration/browser-adapter.test.ts` (25): headless refusal,
    `challengeScan`, `describeLocator`, `bringToFront` against a real Chrome
    with `/challenge` + local `/recaptcha-frame` fixtures.
  - `tests/integration/mcp-http.test.ts` (12): end-to-end challenge pause +
    resume over Streamable HTTP.
- Integration-test reliability fix: the long-lived shared Chrome degraded after
  ~22 `connectOverCDP` cycles, stalling the late Stage 6 cases until they hit
  the 30 s test timeout. Adapters are now disposed and leftover tabs closed
  after each case, and the three Stage 6 adapter operations run against their
  own fresh Chrome; the file went from ~100 s (3 timeouts) to ~10 s, all green.
- Verification: `npm run typecheck`, `npm run lint`, `npm run build`, and
  `npm test` all exit 0 (Vitest 323/323 across 18 files). New Stage 6 files are
  prettier-formatted.
- Limitations: CAPTCHA is only ever paused and handed to the user — it is never
  solved automatically, and no cookies/passwords/tokens or arbitrary JavaScript
  are used. Challenge detection is heuristic (URL/iframe/phrase signals) and can
  miss novel providers; the generic fallback covers common "verify you are
  human" phrasing. Sensitive-action classification is name-based, so a purchase
  button with an unusual label may not be gated. `visibleModeRequired` must be
  disabled for headless CI, which is why the disposable test Chrome opts out.

## Stage 7: secure MCP tunnel

- Status: implemented.
- Goal: give cloud ChatGPT access WITHOUT publishing the CDP or MCP ports. The
  MCP Streamable HTTP endpoint stays loopback-only (the refusal in
  `src/mcp/http.ts` is now documented as permanent, not a placeholder); remote
  reachability exists only through an OUTBOUND tunnel. `/healthz` and
  `/readyz` (Stage 5) are the health contract the tunnel client verifies.
- New module `src/tunnel/config.ts`: Zod-validated tunnel config from env —
  `TUNNEL_TARGET` (default `http://127.0.0.1:9230`; http only, loopback only
  incl. `[::1]`, no credentials, no path — the tunnel can never be pointed at
  raw CDP or a remote host), `TUNNEL_MODE` (`named` default | `quick`),
  `TUNNEL_CLOUDFLARED_BIN`, optional `TUNNEL_PUBLIC_URL` for the remote-hop
  check. The API key is env-only: `tunnelToken()` reads
  `CLOUDFLARE_TUNNEL_TOKEN` (name constant `TUNNEL_TOKEN_ENV`); the value is
  never part of the parsed config (unit-tested), never stored in config files
  or the repository, and `.env.example` documents the variable without a value.
- New module `src/tunnel/client.ts`: `runTunnel()` wraps `cloudflared`.
  - Named mode: `cloudflared --no-autoupdate tunnel run` with the token passed
    via the `TUNNEL_TOKEN` environment variable — NEVER in argv (argv is
    visible to other local processes); refuses to start without the secret.
  - Quick mode: `cloudflared --no-autoupdate tunnel --url <loopback origin>`;
    the ephemeral `https://*.trycloudflare.com` URL is parsed from the output
    (`parseQuickTunnelUrl`), logged once, and surfaced via `onPublicUrl` /
    the result.
  - Every cloudflared output line is screened for the token before logging
    (`redactSecret`); non-blocking `/healthz` pre-flight warns when the MCP
    server is down (the tunnel would 502); graceful stop via `AbortSignal`
    (SIGTERM, 5 s unref'd SIGKILL fallback; on Windows `kill()` is
    TerminateProcess); exit code propagated to the CLI.
- New module `src/tunnel/doctor.ts`: `runDoctor()` verifies the chain
  `Chrome -> CDP -> Browser MCP -> tunnel-client -> ChatGPT` hop by hop:
  Node >= 22, config parse, `cloudflared --version` (injectable spawner,
  10 s budget, ENOENT-safe), token presence without ever printing it (quick
  mode warns "testing only"), `GET /healthz` and `GET /readyz` with a strict
  `{"status":"ok"}` content guard (a 200-answering foreign service — e.g. raw
  CDP tooling — fails the check with "Never point the tunnel at raw CDP"),
  and a full MCP exchange over Streamable HTTP: `initialize` + `tools/list`
  (15 tools) + a real `browser_status` call — the same exchange MCP Inspector
  and ChatGPT perform. With `TUNNEL_PUBLIC_URL` set, the same exchange runs
  through the public URL (`public-hop`, plus a `public-hop-scheme` warning
  for non-HTTPS) — the "test connection" ChatGPT would make. `formatDoctorReport`
  renders `[ ok ]/[warn]/[FAIL]/[skip]` lines; exit 0 iff no check failed.
- New CLI `src/tunnel-cli.ts` + npm scripts `tunnel:doctor` / `tunnel:run`
  (`node dist/src/tunnel-cli.js doctor|run`, `help`/usage, exit codes:
  doctor 0/1, run = cloudflared's exit code; SIGINT/SIGTERM stop cleanly).
- Docs:
  - `docs/tunnel-client.md` (Windows): cloudflared install (winget), named vs
    quick mode, Zero Trust dashboard setup (token + public hostname ->
    `http://127.0.0.1:9230`), env-only secret handling (session + persisted,
    rotation), doctor/run usage, connecting ChatGPT — cloud custom connector
    (`https://<host>/mcp`) and desktop-app developer mode
    (`http://127.0.0.1:9230/mcp`, no tunnel) — the hop-by-hop diagnostics
    table for the full chain with expected results and common failures, and
    security notes (public URL as credential, never tunnel 9222/9229).
  - `docs/local-clients.md`: local scenarios WITHOUT a tunnel — Codex CLI
    STDIO (`~/.codex/config.toml` with `MCP_TRANSPORT=stdio`), ChatGPT desktop
    developer mode against the loopback HTTP endpoint, and the MCP Inspector
    smoke test (`browser_status`).
  - README: Stage 7 section, endpoints/security-boundary text updated
    (loopback-only is permanent; tunnel forwards to MCP only, never raw CDP);
    `docs/architecture.md` tunnel-client entry expanded; `.env.example`
    documents the non-secret tunnel variables and the commented-out secret.
- Tests (25 new, 348 total):
  - `tests/unit/tunnel-config.test.ts` (8): secure defaults, overrides incl.
    `[::1]`, non-loopback/non-http/credentials/path rejection, mode and public
    URL validation, token never in parsed config, error rendering.
  - `tests/unit/tunnel-client.test.ts` (6): quick-URL parsing, secret
    redaction, argv builder (token never in argv).
  - `tests/unit/tunnel-doctor.test.ts` (7) against a real loopback MCP server
    (new shared helper `tests/helpers/mcp-test-server.ts`, fake adapter) and a
    fake cloudflared binary: full local chain pass (15 tools +
    `browser_status`), named-mode token pass/fail with no secret leakage into
    the report, MCP-down failure + protocol skip, missing cloudflared, the
    raw-CDP-style foreign `/healthz` guard, remote-hop test connection via
    `TUNNEL_PUBLIC_URL` (+ HTTPS warning), invalid-config skips.
  - `tests/integration/tunnel-run.test.ts` (4) with a fake cloudflared child
    process: named mode proves the token arrives via `TUNNEL_TOKEN` env and is
    absent from argv, and a deliberately echoed token never reaches the logs
    (`[REDACTED]` instead); quick mode surfaces the ephemeral URL and stops on
    abort; missing-token refusal; missing-binary install guidance.
- Live verification on Windows (this machine has no cloudflared and no
  Cloudflare account, so the edge hop is covered by docs + the remote-hop
  check, not a live tunnel):
  - `node dist/src/tunnel-cli.js doctor` without prerequisites fails exactly
    the right checks (cloudflared ENOENT, token missing, MCP down) and exits 1.
  - Against the real built server (`GATEWAY_ENABLED=false`): doctor reports
    healthz/readyz `200 {"status":"ok"}` and `mcp-protocol ok — tools/list
    returned 15 tools; browser_status answered (connected=false,
    humanControl=ready)`; only `cloudflared` fails (not installed).
  - Acceptance criterion "Inspector вызывает browser_status" proved with the
    official MCP Inspector CLI: `npx @modelcontextprotocol/inspector --cli
    http://127.0.0.1:9230/mcp --method tools/call --tool-name browser_status`
    returned the structured status (exit 0).
- Verification: `npm run typecheck`, `npm run lint`, `npm run build`, and
  `npm test` all exit 0 (Vitest 348/348 across 22 files). New Stage 7 files
  are prettier-formatted.
- Limitations: the tunnel itself needs a Cloudflare account/token (or quick
  mode) to be exercised end-to-end — not available in the build environment,
  so `tunnel:run` is proven against a fake cloudflared and the ChatGPT
  connector step is documented, not automated. The MCP endpoint has no bearer
  auth of its own: the public hostname is effectively its credential (named
  tunnel on a private domain recommended; stop the tunnel when idle); MCP-side
  auth could be a later hardening stage. `cloudflared` must be recent enough
  to accept `TUNNEL_TOKEN` (2023.8+). Quick-tunnel URLs are ephemeral and
  unauthenticated — testing only.

## Stage 8: Windows deployment and hardening

- Status: implemented in this repository.
- Bounded redacted logs:
  - `src/logging/rotate.ts`: `RotatingFileDestination` with size/count/age
    rotation (`LOG_FILE_MAX_BYTES` default 10 MiB, `LOG_FILE_MAX_FILES` 5,
    `LOG_FILE_MAX_AGE_DAYS` 14) plus `loadLoggingOptions()`; the pino logger
    (`src/logging/logger.ts`) writes to `LOG_FILE`
    (default `C:\ProgramData\browser-mcp\logs\browser-mcp.log` when running as
    the service) with extended redaction paths. `.env.example` documents the
    new non-secret variables.
- Windows service wrapper (`scripts/windows/BrowserMcpService.cs`, compiled to
  `service\BrowserMcp.Service.exe` with the in-box .NET Framework `csc.exe`):
  SCM host that supervises the Node child (`node dist\src\main.js`, or
  `-- node dist\src\tunnel-cli.js run` for the tunnel service), restarts it on
  crash, performs a graceful CTRL_C hand-over on stop via a separate
  `ctrl <pid>` helper mode (in-process `GenerateConsoleCtrlEvent` deadlocks
  with a `Console.CancelKeyPress` subscription), loads secrets from the
  service account's Credential Manager into the child environment at start
  (never disk, never argv), captures bounded child stderr, and writes to the
  Application event log (source `BrowserMcpService`). Helper modes:
  `secret set NAME FILE` / `secret check NAME` / `secret delete NAME`.
- Deployment scripts (`scripts/windows/`, all self-elevating, idempotent,
  pure-ASCII because PS 5.1 on non-English locales mis-parses UTF-8):
  - `BrowserMcp.Windows.psm1`: shared helpers (account init, logon rights,
    ACLs, Credential Manager via the wrapper running AS the service user,
    firewall rules, health waits, WSL-based external TCP probe).
  - `install.ps1`: creates local user `bmcp-svc` (no admin rights, service
    logon only after install), stores `CDP_GATEWAY_TOKEN` (and optional
    `CLOUDFLARE_TUNNEL_TOKEN` with `-InstallTunnel`) in its Credential Manager
    as `browser-mcp/<NAME>`, writes ACL'd non-secret
    `C:\ProgramData\browser-mcp\service.env` (refuses secret-looking values),
    registers the `BrowserMcp` service (Automatic, restart-on-failure),
    scopes inbound TCP 9229 to `-Subnet` in Windows Firewall, deletes any
    9222 rules, verifies health + 401-on-unauthenticated, then runs the
    embedded security checklist.
  - `rotate-token.ps1`: stop service -> lift deny rights -> reset account
    password -> store new token -> re-deny -> start -> prove new token
    accepted and old token 401.
  - `emergency-stop.ps1` / `-Revert`: stops both services, disables autostart
    (reboot-proof), adds inbound BLOCK rules for 9229/9230, kills stray
    service-account node processes, logs to the event log; revert removes the
    blocks and re-enables.
  - `upgrade.ps1` / `rollback.ps1`: stop -> snapshot `dist/` + lockfiles into
    `backups\<timestamp>\` -> `npm ci` + build (+ wrapper recompile) -> start
    -> verify; rollback restores a snapshot (newest or `-Timestamp`).
  - `uninstall.ps1`: removes services, event source, firewall rules, secrets
    (as the service user), optionally the account (`-RemoveUser`) and state
    dir (`-RemoveState`).
  - `security-checklist.ps1`: 19 automated checks (service state, account
    hardening, wrapper freshness, secret-free + ACL'd service.env, MCP
    loopback-only, gateway bearer auth, firewall scoping + no 9222 rule +
    profiles enabled, TRUE external probes from the WSL2 VM, bounded logs,
    SCM failure actions, event source, node version, secrets loaded at last
    start). Exit 0 only with zero FAILs.
- Runbook: `docs/windows-deployment.md` (install, verify, rotate, upgrade,
  rollback, emergency stop, uninstall, troubleshooting); README gained a
  Stage 8 section; `docs/architecture.md` lists the windows-service component.
- Tests (13 new, 361 total across 23 files): `tests/unit/log-rotation.test.ts`
  covers size rotation, count and age retention, redaction into the rotating
  destination, and option loading defaults/overrides.
- Live verification on this Windows machine (elevated, UAC silent):
  - Install with `-Subnet 192.168.88.0/24`: service Running/Automatic,
    healthz 200, unauthenticated `/json/version` 401, embedded checklist
    19 passed / 0 failed / 0 warnings.
  - Token rotation: new token accepted (`/json/version` -> 502 = auth OK,
    Chrome not running), old token -> 401.
  - Emergency stop: service Stopped + Disabled, block rules enabled, both
    ports closed; `-Revert` restored Running/Automatic with healthy endpoints
    and the rotated token still working.
  - Reboot recovery (stop/start simulation; no real reboot performed):
    service came back healthy and the wrapper re-loaded the rotated secret
    from Credential Manager.
  - Uninstall `-RemoveUser -RemoveState` removed everything; a clean
    reinstall passed the checklist 19/0/0 again.
  - Firewall proof: local self-probes bypass inbound rules by design, so the
    checklist probes from the WSL2 VM: off-subnet host IPs blocked on 9229,
    in-subnet IP reachable (allowed), MCP 9230 unreachable everywhere. A
    manual control test (rule removed -> CLOSED from WSL, restored -> OPEN)
    confirmed the rule is what grants access.
  - Machine state change: Windows Firewall was fully DISABLED on this box;
    install ran with the profiles enabled (all profiles now on).
- Notes:
  - Resetting the service account's password (rotation and uninstall both do)
    invalidates the DPAPI keys protecting previously stored vault entries:
    they become permanently undecryptable and `CredDelete` may report
    "not found". Harmless — old tokens are unrecoverable and the entries
    disappear with the account.
  - WSL distro enumeration must strip UTF-16 NULs and skip container distros
    without bash (docker-desktop); the probe iterates distros until one works.
- Verification: `npm run typecheck`, `npm run lint`, `npm run build`, and
  `npm test` all exit 0 (Vitest 361/361). One Stage 7 integration test
  (`tunnel-run` named mode) flaked once under full-suite parallel load and
  passes consistently in isolation and on re-run.
- Limitations: real reboot not performed (recovery proven via Automatic start
  type + stop/start cycle); the tunnel service path (`-InstallTunnel`) is
  implemented but not live-installed here (no cloudflared token on this
  machine); Chrome was not running during live tests, so authenticated
  `/json/version` returns 502 (auth layer proven, proxy target absent).

## Stage 9: end-to-end Partslink24

- Status: implemented (mock CI scenario green; real-site run documented,
  completion requires the user's Partslink24 account).
- Goal: prove the real scenario without handing the password to the AI —
  open → login wall → manual sign-in → resume → VIN search → CAPTCHA → manual
  solve → resume on the SAME session → extract only part numbers +
  applicability.
- New module `src/policy/vin.ts`: VIN privacy. `isVin` (ISO 3779 form: 17
  chars, no I/O/Q), `maskVin` (keeps WMI + serial tail, masks the middle:
  `WVWZZZ1KZAW123456` → `WVW********123456`; defensive masking for non-VIN
  input), and `redactVinsInText` (masks every VIN-shaped token in arbitrary
  text) — applied to every message the scenario logs or returns, so a full
  VIN can never reach logs, tool output, or the report.
- New module `src/scenarios/partslink24.ts`: transport-agnostic scenario
  engine `runPartslink24Scenario(options)` — it plays the MCP client:
  - Flow: `browser_connect` → `page_open` → login-wall loop (`page_snapshot`
    + `detectLoginWall` heuristic: password-named field or EN/RU/DE login
    wording; a false pause is safe, a missed wall is not) → `human_required`
    + `waitForUser` + `human_resume`, re-checked until the wall is gone →
    `page_fill` VIN (the only place the VIN exists; never echoed/logged) →
    `page_click` search → result-wait poll loop → `page_extract` part
    numbers and applicability only.
  - Handoffs: `captcha_detected` from the Stage 6 guard (on open/click), a
    paused gate seen via `browser_status`, or a late wall/challenge found by
    the on-demand probe (`page_list` + `page_snapshot` + `detectLoginWall` +
    the Stage 6 `detectChallenge` classifier) all route into
    `resolveHandoff`: wait for the user, `human_resume`, retry while
    `challenge_still_present` (verified resume), bounded rounds.
  - Deep login walls (the live site shows one AFTER brand selection, not on
    the homepage): a failed VIN fill probes the page and hands over once
    before retrying.
  - Safety: `confirmation_required` aborts the scenario
    (`sensitive_action_forbidden`) — purchases/orders are never confirmed and
    no confirm token is ever consumed; invalid VIN fails before any tool
    call; every failure (incl. transport errors) is captured in the returned
    `ScenarioReport` (never throws); report + `formatScenarioReport` carry
    only the masked VIN.
  - `PARTSLINK24_SCRIPT` holds the best-effort real-site locators; the flow
    itself is site-independent (tests inject a mock script).
- New CLI `src/scenarios/partslink24-cli.ts` + npm script `e2e:partslink24`:
  the manual real-site run. Connects as an SDK Streamable HTTP client to
  `http://127.0.0.1:9230/mcp` (`MCP_ENDPOINT`/`--endpoint` override), takes
  the VIN from `--vin`/`PL24_VIN`/interactive prompt (argv visibility
  documented), prints a `--- HANDOFF ---` console prompt at every login /
  CAPTCHA pause (Enter resumes), and prints the VIN-masked markdown report.
  Exit 0/1. Smoke-tested: `--help` exit 0; MCP-down prints guidance with the
  masked VIN only, exit 1.
- Docs: `docs/partslink24-e2e.md` — flow table, enforced security rules, CI
  mock vs real run, locator tuning, and the "Real results" ledger (template +
  recorded runs). README Stage 9 section; `docs/architecture.md` gained the
  `partslink24-scenario` component.
- Tests (29 new, 390 total across 26 files):
  - `tests/unit/vin.test.ts` (9): VIN validation, masking shape/case/length,
    defensive short-input masking, in-text redaction incl. word-boundary and
    longer-run guards.
  - `tests/unit/partslink24-scenario.test.ts` (15) against a scripted fake
    MCP server (no Chrome): happy path (exact tool sequence; the VIN reaches
    ONLY `page_fill`), login-wall handoff with safe reason (no page content)
    and single-tab continuation, challenge on open, challenge on click,
    `challenge_still_present` retry (rounds=2), login wall surviving all
    rounds → `login_not_completed`, sensitive-action refusal without ever
    sending a confirmToken, invalid VIN → zero tool calls, deep login wall
    behind a failed fill → probe + handoff + retry, late challenge via the
    probe, VIN masking across report/rendering, transport-error capture;
    plus `detectLoginWall` EN/RU positives and signed-in negatives
    ("Sign out"/"Выйти" do not fire).
  - `tests/integration/partslink24-e2e.test.ts` (5): the FULL scenario on the
    real stack (disposable Chrome → adapter → human gate → MCP over
    Streamable HTTP → SDK client → engine) against a local cookie-based
    Partslink24-like fixture — NO contact with the real site. The simulated
    human signs in / solves the CAPTCHA via direct tab navigation; the
    automation never POSTs the login form (asserted), never fills before the
    first resume (asserted), extracts exactly the fixture's part numbers +
    applicability, uses exactly two handoffs (login then challenge, one
    verified round each) on ONE tab opened once (cookie-enforced session
    continuity = "no re-login"), and the full VIN appears in neither the
    report nor a raw (unredacted) pino capture while the masked form does.
- Real-site verification (bounded, this machine): the live homepage was
  probed three times total via the real adapter (open + challengeScan +
  snapshot; no login, no fills, no search): it loads without CAPTCHA and
  without a login wall — it is a brand-selection grid (`/ru/index.html`),
  with login/registration (`*.action` URLs) and the VIN search deeper in the
  brand catalogs. Recorded in `docs/partslink24-e2e.md` "Real results". The
  full real flow (manual sign-in → search → CAPTCHA → extraction) requires a
  Partslink24 account and is run by the user via `npm run e2e:partslink24`.
- Verification: `npm run typecheck`, `npm run lint`, `npm run build`, and
  `npm test` all exit 0 (Vitest 390/390 across 26 files). New Stage 9 files
  are prettier-formatted.
- Limitations: real-site locators are best-effort (markup can change; the
  runbook explains re-derivation via `page_snapshot`), and the live flow
  beyond the homepage needs the user's account — the readiness criteria
  (full scenario without re-login, CAPTCHA handed to the human, continuation
  on the same page after the manual action) are proven end-to-end by the mock
  CI scenario. Login-wall and challenge detection remain heuristic. The
  engine's initial login check runs after `page_open`; walls appearing after
  user-driven navigation are caught by the fill/wait probes, not earlier.

## Stage 10: MVP acceptance

- Status: implemented — every release criterion from `promts/10-mvp.md` is
  verified by tests and/or a live check on this machine.
- New test `tests/integration/mvp-acceptance.test.ts` (3, real Chrome + real
  MCP over Streamable HTTP + SDK client, cookie-based fixture):
  - the MCP surface is EXACTLY the closed 15-tool set and no tool name grants
    cookie/storage/token/eval capability;
  - an EXISTING authenticated session survives a full server restart: the user
    signs in manually before the automation server exists, the server is then
    entirely rebuilt (adapter disposed → fresh adapter/gate/MCP/client), Chrome
    keeps running (`/json/version` still alive) and the site still recognizes
    the session — exactly one manual sign-in ever, zero re-logins;
  - raw cookie value and a password field value appear in NO tool output
    (`page_snapshot`, `page_extract` body + targeted, `browser_status`); the
    password field surfaces only as `[REDACTED]`.
- New unit coverage:
  - `tests/unit/partslink24-scenario.test.ts` (+1): the site-independent
    scenario engine drives a Partsouq script (`https://www.partsouq.com/`)
    through the full flow — the "Partslink24/Partsouq" criterion is explicit
    for both sites (fake-server options gained a `startUrl` override).
  - `tests/unit/config.test.ts` (+1): the default `BROWSER_ALLOWED_DOMAINS`
    contains partslink24.com AND partsouq.com (bare + www).
- New acceptance script `scripts/verify-mvp-smoke.mjs` — live proof against
  the BUILT server (`dist/src/main.js`): starts a disposable Chrome + a local
  one-page fixture, boots the built server with `CDP_ENDPOINT` pointed at the
  private CDP port, then performs the same MCP exchange ChatGPT does
  (`initialize` + `tools/list` + tool calls). Run on this machine, all 7
  checks PASS:
  - `/healthz` ok on loopback;
  - `netstat` proof: the MCP listener is bound to `127.0.0.1` only (not
    published);
  - `tools/list` returns the 15 ChatGPT-visible tools;
  - `browser_connect` attaches to the configured private CDP endpoint;
  - `page_open` → `page_click` → `page_extract` open the site, click the
    button and extract the revealed text.
- `eslint.config.js`: Node globals for plain `.js`/`.mjs` files (the new
  smoke script is not TypeScript; no new dependencies).
- Criterion-by-criterion evidence:
  1. Connects to the configured private CDP endpoint — `CDP_ENDPOINT` →
     Stage 2 resolver (loopback/RFC1918 default allowance, DNS pinning,
     public addresses rejected) → Stage 4 adapter; live smoke check above.
  2. ChatGPT sees the MCP tools — `tools/list` = 15 tools over Streamable
     HTTP and STDIO (tests `mcp-http`, `mcp-stdio`, `tunnel-doctor`); live
     smoke + Stage 7 MCP Inspector runs; ChatGPT wiring documented in
     `docs/tunnel-client.md` / `docs/local-clients.md`.
  3. Open site, click, extract text — `page_open`/`page_click`/
     `page_extract` (Stage 4/5 integration tests + live smoke).
  4. CAPTCHA and login are manual — Stage 6 state machine + challenge
     classifier; Stage 9 e2e asserts automation never POSTs the login form,
     every CAPTCHA/login pauses with `human_required`, resume is verified,
     and a CAPTCHA is never solved automatically.
  5. Existing authenticated session preserved — new `mvp-acceptance`
     restart test + Stage 4 "disconnect leaves Chrome running" + Stage 9
     cookie continuity; the adapter only ATTACHES (never creates a profile,
     never touches cookies).
  6. Raw cookies/passwords unavailable to the model — new `mvp-acceptance`
     leakage test + closed 15-tool surface; no API evaluates JavaScript,
     `page_fill` refuses password fields, snapshots/extracts are redacted,
     server instructions forbid cookies/tokens/CAPTCHA solving.
  7. CDP not published to the internet — MCP endpoint loopback-only
    (permanent); the tunnel is outbound-only and its config validator accepts
     ONLY a loopback http MCP target (never raw CDP, never remote hosts);
     gateway requires bearer + CIDR allowlist and firewall rules scope 9229
     to the subnet (`docs/windows-firewall.md`, Stage 8 checklist incl. WSL
     external probes); the Stage 2 resolver rejects public CDP addresses;
     live `netstat` check in the smoke script.
  8. Working Partslink24/Partsouq test — full mock-CI Partslink24 e2e on the
     real stack (no contact with the real site), 16 unit scenario tests, the
     new Partsouq scenario test, and both domains in the default allowlist;
     real-site probes recorded in `docs/partslink24-e2e.md`.
- Verification: `npm run typecheck`, `npm run lint`, `npm run build`, and
  `npm test` all exit 0 (Vitest 395/395 across 27 files);
  `node scripts/verify-mvp-smoke.mjs` exits 0 with 7/7 checks passing.
- Limitations: the full REAL-site flow beyond the homepage still needs the
  user's Partslink24 account (`npm run e2e:partslink24`); no fixed Partsouq
  locator script ships (the engine is site-independent; locators are
  re-derived via `page_snapshot` like Partslink24's). The ChatGPT cloud
  connector itself needs a Cloudflare tunnel token — documented, verified up
  to the public hop by `tunnel:doctor`. The netstat bind check is
  Windows-only (skipped elsewhere). Session persistence is proven against a
  cookie-based fixture; real-site session mechanics remain the site's own.

## Later stages

No later stage is specified in `promts/` — Stage 10 (MVP) is the final
stage currently defined, and it is complete.

## Post-MVP: closing tabs (`page_close`) — 2026-11-03

The MVP tool set could open tabs but never close them: after a scrape the
automation's own tabs stayed in the user's Chrome window, and the model had no
cleanup primitive at all. Added as the 16th tool.

- `BrowserAdapter.closePage({ pageId })` closes one tab and reports
  `remainingTabs` + the closed tab's URL (never its content). The registry now
  tracks which tabs THIS adapter opened (`adapterOpened`), exposed per tab as
  `PageInfo.openedByAdapter` in `page_list`/`page_open`/`page_navigate`.
- Safety: the last open tab is never closed — Chrome exits with its last tab
  and the user's session (logins, open work) would be gone; the adapter throws
  `last_tab_forbidden`. `page.close({ runBeforeUnload: false })` is deliberate:
  a beforeunload dialog could block the call forever (no dialog handler is
  exposed), which is exactly why a tab the user opened is gated instead.
- Policy: closing a tab the automation did NOT open is a sensitive action
  (`sensitiveAction: 'tab_close'`). The first call returns
  `confirmation_required` with a single-use `confirmToken` bound to that
  `pageId`; the identical call with the token closes it, and a replayed token
  asks again. Automation-opened tabs close without any confirmation.
- Wiring: `pageCloseInputSchema`/`pageCloseOutputShape` (+ `openedByAdapter` in
  `pageInfoSchema`/`pageOpenOutputShape`), tool registered with
  `readOnlyHint: false, destructiveHint: true`, and server instruction rule 8
  documents the three-way contract (own tab / user tab / last tab).
- Verification: `tests/unit/mcp-tools.test.ts` covers own-tab close, the
  confirmation round trip with token replay and cross-tab token rejection,
  `unknown_page`, `last_tab_forbidden`, the `human_required` block and the
  argument/annotation contract; `tests/integration/browser-adapter.test.ts`
  drives real Chrome (close, `remainingTabs`, last-tab refusal leaves the tab
  alive, unknown id); `tests/integration/mcp-http.test.ts` runs the whole
  exchange over Streamable HTTP with a real Chrome.
