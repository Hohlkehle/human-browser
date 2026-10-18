# Architecture

## Components

- `cdp-gateway`: authenticated, CIDR-filtered proxy from an explicitly bound
  gateway address to the local Chrome CDP endpoint.
- `browser-mcp`: typed MCP server backed by `playwright-core.connectOverCDP`.
- `human-control`: pauses automation when CAPTCHA, login, or a sensitive
  confirmation needs a person in the visible Chrome window.
- `policy`: domain allowlist, sensitive-field restrictions, and confirmation
  policy. Secrets are never returned to the model.
- `tunnel-client`: outbound HTTPS transport for cloud mode; it never exposes raw
  CDP publicly. Wraps `cloudflared` (named token tunnel or ephemeral quick
  tunnel) with `doctor` and `run` commands; the origin is always the
  loopback-only MCP endpoint, and the tunnel token is an env-only secret.
- `windows-service` (Stage 8): `scripts/windows/` deploys gateway+MCP (and
  optionally the tunnel) as Windows services under a dedicated
  least-privileged account. A compiled C# wrapper supervises the Node child,
  loads secrets from the account's Credential Manager into the process
  environment at start, and handles graceful stop/crash restart. Adds token
  rotation, upgrade/rollback, emergency stop, subnet-scoped firewall rules,
  bounded redacted logs, and an automated security checklist.
- `partslink24-scenario` (Stage 9): `src/scenarios/` — the end-to-end
  reference client. A transport-agnostic engine drives the 15 MCP tools
  through open → login handoff → VIN search → CAPTCHA handoff → extraction of
  part numbers + applicability, with VIN masking (`src/policy/vin.ts`) in all
  logs/reports and no credential or confirm-token handling. Includes the
  manual real-run CLI (`npm run e2e:partslink24`); the CI mock variant lives
  in `tests/integration/partslink24-e2e.test.ts`.

## Data flow

`Chrome -> CDP -> cdp-gateway (optional) -> browser-mcp -> tunnel-client (optional) -> client`

The local MCP server listens on loopback by default. Browser operations are
validated before they reach Playwright. Results are reduced to visible text,
ARIA snapshots, screenshots, and stable internal identifiers.

## Build order

The source of truth for the coding loop is `promts/01` through `promts/09`.
Each stage must pass its own checks before the next stage begins.
