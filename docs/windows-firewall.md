# Windows Firewall hardening for the CDP gateway

The gateway may bind `0.0.0.0:9229` so that trusted LAN machines can drive the
local Chrome session. Binding `0.0.0.0` is only acceptable with **all three**
layers in place:

1. Application layer: bearer token + CIDR allowlist (`GATEWAY_ALLOWED_CIDRS`).
   The gateway refuses to start without both.
2. OS firewall layer: inbound access to TCP 9229 restricted to the same subnet
   (this document).
3. Network layer: the port is never published to the internet — no router port
   forwarding, no NAT exposure, no public reverse proxy/tunnel to 9229.

Keep `GATEWAY_ALLOWED_CIDRS` and the firewall `remoteip` scope in sync: they
must describe the same subnet.

## Rules

Windows Firewall blocks unsolicited inbound traffic by default. Do **not**
create a blanket allow rule for port 9229. Create exactly one scope-limited
rule for your trusted subnet (example: `10.252.150.0/24`):

```powershell
# Allow inbound TCP 9229 only from the trusted subnet.
netsh advfirewall firewall add rule name="Browser MCP CDP gateway (subnet only)" `
  dir=in action=allow protocol=TCP localport=9229 remoteip=10.252.150.0/24
```

Never use `remoteip=any` for this port. If such a rule exists, delete it:

```powershell
netsh advfirewall firewall delete rule name="Browser MCP CDP gateway (any)"
```

The upstream Chrome debugging port (9222) must stay loopback-only: Chrome is
launched with `--remote-debugging-address=127.0.0.1` semantics (Chrome binds
loopback by default) and needs **no** inbound firewall rule at all. If a rule
for 9222 exists, delete it:

```powershell
netsh advfirewall firewall delete rule name=all protocol=TCP localport=9222
```

## Verify

```powershell
# Inspect every rule that touches 9229/9222.
netsh advfirewall firewall show rule name=all verbose | findstr /i "9229 9222"

# From a machine OUTSIDE the allowed subnet the port must be unreachable:
# Test-NetConnection <host> -Port 9229   -> TcpTestSucceeded : False
```

## Internet exposure is forbidden

- Do not port-forward 9222 or 9229 on a router/NAT.
- Do not expose the gateway through a public tunnel or reverse proxy; remote
  access goes through the outbound tunnel client of a later stage, never by
  publishing raw CDP.
- If the machine leaves the trusted network (laptop on public Wi-Fi), disable
  the rule or set `GATEWAY_LISTEN_HOST=127.0.0.1`.
