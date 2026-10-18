# Windows deployment runbook (Stage 8)

Deploys Browser MCP as a permanent, hardened Windows service: dedicated
least-privileged account, autostart, secrets in Credential Manager, bounded
redacted logs, subnet-only firewall access, token rotation, emergency stop,
and an automated security checklist.

All scripts live in `scripts/windows/` and require an **elevated**
PowerShell (they re-elevate themselves if needed). They are idempotent —
re-running install is safe.

## What gets installed

| Piece | Location / name |
| --- | --- |
| Service (gateway + MCP) | `BrowserMcp` (Automatic, restart-on-failure) |
| Optional tunnel service | `BrowserMcpTunnel` (only with `-InstallTunnel`) |
| Service wrapper | `service\BrowserMcp.Service.exe` (compiled from `scripts/windows/BrowserMcpService.cs` via the .NET Framework `csc.exe`) |
| Service account | local user `bmcp-svc` — not an admin, may **only** log on as a service |
| Secrets | Credential Manager of `bmcp-svc`, targets `browser-mcp/CDP_GATEWAY_TOKEN` (and `browser-mcp/CLOUDFLARE_TUNNEL_TOKEN` with a tunnel) |
| Non-secret config | `C:\ProgramData\browser-mcp\service.env` (ACL'd; the scripts refuse to write secret-looking values into it) |
| Logs | `C:\ProgramData\browser-mcp\logs\browser-mcp.log` (structured, redacted) + `stderr.log` (wrapper/child stderr) |
| Firewall | one inbound allow rule for TCP 9229 scoped to your subnet; 9222 (Chrome) stays loopback-only with no rule |

The wrapper supervises the Node child (`node dist\src\main.js`), loads the
secrets from Credential Manager into the child's environment at start (they
never touch disk or argv), restarts the child on crash, performs a graceful
CTRL_C hand-over on service stop, and writes to the Application event log
(source `BrowserMcpService`).

## Prerequisites

- Windows 10/11 or Server with the .NET Framework C# compiler (ships with
  Windows: `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`).
- Node.js 22+ on `PATH` (or pass its location through `service.env`).
- The repository built once: `npm install; npm run build`.
- A visible Chrome with remote debugging on `127.0.0.1:9222` for the gateway
  to proxy to.
- Your trusted LAN subnet in CIDR form (e.g. `192.168.88.0/24`).

## Install

```powershell
# elevated PowerShell
.\scripts\windows\install.ps1 -Subnet 192.168.88.0/24 -GatewayToken '<a long random secret>'
```

Omit `-GatewayToken` to have a strong random token generated — it is printed
once in the console; copy it immediately. Useful flags:

- `-InstallTunnel -TunnelToken <token>` — also install `BrowserMcpTunnel`
  (Stage 7 outbound tunnel) as a service.
- `-Env KEY=VALUE` (repeatable) — extra non-secret settings for `service.env`
  (e.g. `-Env BROWSER_ALLOWED_DOMAINS=example.com,example.org`).
- `-SkipFirewall` — do not create the firewall rule (create it yourself).
- `-EnableFirewall` — also turn the Windows Firewall profiles on if they are
  disabled (install warns but does not flip them by default).

Install finishes with an embedded security checklist run.

## Verify

```powershell
.\scripts\windows\security-checklist.ps1
```

19 automated checks: service state and account hardening (no admin rights,
service-only logon), wrapper freshness, `service.env` free of secrets and
ACL'd, MCP loopback-only and healthy, gateway bearer auth enforced, firewall
rule scoped (and no 9222 rule), firewall profiles enabled, **true external
probes from the WSL2 VM** (off-subnet IPs must be blocked on 9229, MCP port
unreachable everywhere), bounded logs, SCM failure actions, event source,
Node version, and secret loading at last start. Exit code 0 only with zero
FAILs; WARNs (e.g. WSL unavailable for the external probe) do not fail the
run but should be covered manually:

```powershell
# from a machine OUTSIDE the subnet:
Test-NetConnection <host> -Port 9229   # -> TcpTestSucceeded : False
```

## Day-to-day

```powershell
Get-Service BrowserMcp
Restart-Service BrowserMcp
Get-Content C:\ProgramData\browser-mcp\logs\browser-mcp.log -Wait
```

Logs rotate automatically (`LOG_FILE_MAX_BYTES` / `LOG_FILE_MAX_FILES` /
`LOG_FILE_MAX_AGE_DAYS` in `service.env`); redaction covers Authorization
headers, query strings, and CDP frames.

### Rotate the bearer token

```powershell
.\scripts\windows\rotate-token.ps1 -NewToken '<new secret>' -OldToken '<current secret>'
```

Stops the service, stores the new token in Credential Manager (via an ACL'd
temp file the wrapper deletes immediately), restarts, then proves the new
token is accepted and the old one gets 401. Omit `-NewToken` to generate one.
Clients see a ~2 s outage and must switch to the new token.

## Upgrade and rollback

```powershell
git pull                       # update the code first
.\scripts\windows\upgrade.ps1  # stop -> snapshot dist/+lockfiles -> npm ci -> build -> start -> verify
```

Every upgrade creates `backups\<timestamp>\` next to the install dir. If the
post-upgrade health check fails:

```powershell
.\scripts\windows\rollback.ps1                    # newest rollback point
.\scripts\windows\rollback.ps1 -Timestamp 20260827-141500
```

Rollback restores `dist/`, `package.json`, `package-lock.json`, re-syncs
`node_modules` (tolerates being offline), restarts, and verifies health.

## Emergency stop

```powershell
.\scripts\windows\emergency-stop.ps1          # kill all access NOW
.\scripts\windows\emergency-stop.ps1 -Revert  # deliberate re-enable
```

Emergency stop guarantees: both services stopped, autostart **disabled** (a
reboot cannot bring them back), inbound TCP 9229/9230 **blocked** by firewall
rules (even a rogue process cannot serve the ports from the network), stray
`node.exe` processes of the service account killed, and the action recorded in
the Application event log. `-Revert` removes the block rules, re-enables
autostart, starts the services, and logs the revert.

## Uninstall

```powershell
.\scripts\windows\uninstall.ps1                          # services, rules, event source, secrets
.\scripts\windows\uninstall.ps1 -RemoveUser -RemoveState # ...plus account and logs/config
```

Secrets are deleted by running the wrapper **as** the service account. Note:
if the account password was reset since the secret was stored (rotation and
uninstall both reset it), Windows can no longer decrypt the old vault entry —
the delete then reports "may not exist". This is harmless: the entry is
unreadable by everyone and disappears with the account. The repository itself
is never touched.

## Troubleshooting

- Service won't start: `Get-EventLog -LogName Application -Source BrowserMcpService -Newest 20`
  and `C:\ProgramData\browser-mcp\logs\stderr.log`.
- Gateway 401 with the right token: the token was rotated. The checklist's
  `secrets-loaded` check (reads the wrapper's startup record in `stderr.log`)
  confirms what the service actually loaded; when in doubt, rotate again to a
  known token.
- Gateway 502: auth is fine but Chrome is not running / not on 9222.
- Wrapper recompiled itself? `security-checklist.ps1` fails
  `wrapper-binary` when the exe is older than its source — run install or
  upgrade again.
- Firewall behavior: see [`windows-firewall.md`](windows-firewall.md). Local
  self-probes to your own IP bypass inbound rules by design; only probes from
  another machine (or WSL) prove the firewall.
