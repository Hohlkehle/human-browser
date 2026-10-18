# install.ps1 -- Stage 8: install Browser MCP as a hardened Windows service.
#
# What this does (all steps idempotent, see docs/windows-deployment.md):
#   1.  Compiles the service wrapper (scripts/windows/BrowserMcpService.cs)
#       with the csc.exe that ships with Windows.
#   2.  Creates a dedicated least-privilege local account (default bmcp-svc):
#       no group memberships beyond Users, random password that is never
#       stored anywhere.
#   3.  Stores secrets (CDP_GATEWAY_TOKEN, optional CLOUDFLARE_TUNNEL_TOKEN)
#       in that account's Windows Credential Manager -- never in the registry,
#       a file, or a command line.
#   4.  Writes C:\ProgramData\browser-mcp\service.env (non-secret config only,
#       tight ACL) and creates the logs directory.
#   5.  Creates the BrowserMcp service (gateway + MCP server in one process):
#       autostart, restart-on-failure recovery actions, runs as bmcp-svc.
#       Optional: BrowserMcpTunnel (cloudflared) with -InstallTunnel.
#   6.  With -Subnet: binds the gateway to 0.0.0.0 and creates exactly one
#       firewall allow rule scoped to that subnet (any pre-existing 9229 rules
#       are removed; 9222 rules are forbidden and removed). The OS firewall
#       must be ON for the rule to mean anything: use -EnableFirewall.
#   7.  Starts the service and verifies /healthz plus gateway bearer auth.
#   8.  Denies interactive/network logon for the service account (it can then
#       ONLY log on as a service) and runs the automated security checklist.
#
# Usage (elevates itself if needed):
#   .\install.ps1                                   # loopback gateway (default)
#   .\install.ps1 -Subnet 10.252.150.0/24 -EnableFirewall   # LAN gateway
#   .\install.ps1 -InstallTunnel -TunnelToken <cf>  # plus the tunnel service

param(
    [string] $ServiceName = 'BrowserMcp',
    [string] $TunnelServiceName = 'BrowserMcpTunnel',
    [string] $ServiceUser = 'bmcp-svc',
    [string] $StateDir = 'C:\ProgramData\browser-mcp',
    [string] $GatewayToken,
    [string] $TunnelToken,
    [string] $Subnet,
    [string[]] $Env = @(),
    [switch] $InstallTunnel,
    [switch] $SkipFirewall,
    [switch] $EnableFirewall,
    [switch] $NoDenyLogon
)

Import-Module (Join-Path $PSScriptRoot 'BrowserMcp.Windows.psm1') -Force
$ErrorActionPreference = 'Stop'
Assert-BmcpAdmin -ScriptPath $PSCommandPath -PassthroughArgs (ConvertTo-BmcpArgList -BoundParameters $PSBoundParameters)

$installDir = Get-BmcpInstallDir

# --- 0. Prerequisites -------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) { throw 'node.exe not found in PATH (Node.js >= 22 required)' }
$nodeVersion = (& $node.Source --version) -replace '^v', ''
if ([int]($nodeVersion.Split('.')[0]) -lt 22) { throw "Node.js >= 22 required, found $nodeVersion" }

$mainJs = Join-Path $installDir 'dist\src\main.js'
if (-not (Test-Path -LiteralPath $mainJs)) {
    throw "dist build not found ($mainJs). Run 'npm install' and 'npm run build' first."
}

# --- 1. Wrapper -------------------------------------------------------------
$wrapper = Invoke-BmcpCompileWrapper -InstallDir $installDir

# --- 2. State directories ---------------------------------------------------
foreach ($dir in @($StateDir, (Join-Path $StateDir 'logs'), (Join-Path $StateDir 'tmp'))) {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
}
Set-BmcpAcl -Path $StateDir
Set-BmcpAcl -Path (Join-Path $StateDir 'tmp')

# --- 3. Service account -----------------------------------------------------
$credential = Initialize-BmcpServiceUser -UserName $ServiceUser
$plainPassword = $credential.GetNetworkCredential().Password
Add-BmcpServiceLogonRight -Account $ServiceUser

# --- 4. Secrets -> Credential Manager (as the service user) -----------------
if ([string]::IsNullOrEmpty($GatewayToken)) {
    $GatewayToken = New-BmcpRandomToken
    Write-Host 'generated a new random CDP_GATEWAY_TOKEN'
    Write-Host "  token (shown once, copy it now): $GatewayToken"
}
Set-BmcpSecret -WrapperExe $wrapper -Name 'CDP_GATEWAY_TOKEN' -Value $GatewayToken `
    -Credential $credential -StateDir $StateDir

if ($InstallTunnel) {
    if ([string]::IsNullOrEmpty($TunnelToken)) {
        throw '-InstallTunnel requires -TunnelToken (Cloudflare tunnel run token)'
    }
    Set-BmcpSecret -WrapperExe $wrapper -Name 'CLOUDFLARE_TUNNEL_TOKEN' -Value $TunnelToken `
        -Credential $credential -StateDir $StateDir
}

# --- 5. service.env (non-secret only) ---------------------------------------
$envOverrides = @($Env)
if (-not [string]::IsNullOrEmpty($Subnet)) {
    # Loopback stays allowed at the app layer (health checks, local clients);
    # it is never network-reachable, so this does not widen exposure.
    $envOverrides += @("GATEWAY_LISTEN_HOST=0.0.0.0", "GATEWAY_ALLOWED_CIDRS=127.0.0.1/32,$Subnet")
}
$envFile = Write-BmcpServiceEnv -StateDir $StateDir -InstallDir $installDir `
    -NodeExe $node.Source -Overrides $envOverrides
Set-BmcpAcl -Path $envFile -ReadAccounts @("$env:COMPUTERNAME\$ServiceUser")
# Logs: the service account must be able to write; tmp: used during rotations.
Set-BmcpAcl -Path (Join-Path $StateDir 'logs') -ModifyAccounts @("$env:COMPUTERNAME\$ServiceUser")
Set-BmcpAcl -Path (Join-Path $StateDir 'tmp') -ModifyAccounts @("$env:COMPUTERNAME\$ServiceUser")

# --- 6. Services -------------------------------------------------------------
New-BmcpService -ServiceName $ServiceName `
    -DisplayName 'Browser MCP (CDP gateway + MCP server)' `
    -Description 'Security-first browser control: authenticated CDP gateway and MCP server (Stage 8).' `
    -BinPath "`"$wrapper`"" `
    -UserName $ServiceUser -Password $plainPassword

if ($InstallTunnel) {
    $cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($null -eq $cloudflared) {
        Write-Warning 'cloudflared not found in PATH; the tunnel service will fail to start until it is installed (winget install Cloudflare.cloudflared)'
    }
    New-BmcpService -ServiceName $TunnelServiceName `
        -DisplayName 'Browser MCP tunnel client (cloudflared)' `
        -Description 'Outbound Cloudflare tunnel to the loopback MCP endpoint; never exposes raw CDP (Stage 8).' `
        -BinPath "`"$wrapper`" -- node dist\src\tunnel-cli.js run" `
        -UserName $ServiceUser -Password $plainPassword
}

Initialize-BmcpEventLogSource

# --- 7. Firewall -------------------------------------------------------------
if ($EnableFirewall) {
    Set-NetFirewallProfile -All -Enabled True
    Write-Host 'firewall: all profiles ENABLED (required for the subnet-scoped rule to mean anything)'
}
if (-not [string]::IsNullOrEmpty($Subnet) -and -not $SkipFirewall) {
    $off = @(Get-NetFirewallProfile | Where-Object { $_.Enabled -eq $false })
    if ($off.Count -gt 0) {
        Write-Warning ("Windows Firewall is DISABLED for: {0}. The scoped allow rule below is useless until the firewall is on -- re-run with -EnableFirewall or enable it manually." -f (($off | ForEach-Object { $_.Name }) -join ', '))
    }
    Set-BmcpGatewayFirewallRule -Subnet $Subnet -Port 9229
}
# The upstream Chrome debugging port must never have an inbound rule.
Remove-BmcpPortRules -Port 9222
if ([string]::IsNullOrEmpty($Subnet)) {
    $stray = Get-BmcpPortRules -Port 9229 | Where-Object { $_.Action -eq 'Allow' -and $_.Enabled -ne 'False' }
    if ($stray) {
        Write-Warning 'Gateway binds loopback, but inbound allow rules for 9229 exist. Remove them unless you deployed with -Subnet.'
    }
}

# --- 8. Start and verify ------------------------------------------------------
Start-Service -Name $ServiceName
if (-not (Wait-BmcpHealth -Url 'http://127.0.0.1:9230/healthz' -TimeoutSeconds 30)) {
    throw "service started but http://127.0.0.1:9230/healthz did not answer 200 within 30s; check $StateDir\logs\stderr.log and the Application event log"
}
Write-Host 'MCP endpoint healthy: http://127.0.0.1:9230/healthz -> 200'

$gatewayEnabled = $true
$envContent = Get-Content -LiteralPath $envFile
foreach ($line in $envContent) {
    if ($line -match '^GATEWAY_ENABLED=(.*)$') { $gatewayEnabled = ($Matches[1] -ne 'false') }
}
if ($gatewayEnabled) {
    if (-not (Wait-BmcpHealth -Url 'http://127.0.0.1:9229/healthz' -TimeoutSeconds 15)) {
        throw 'gateway health endpoint did not answer 200 within 15s'
    }
    $unauth = Get-BmcpHttpStatus -Url 'http://127.0.0.1:9229/json/version'
    if ($unauth -ne 401) {
        throw "gateway accepted an unauthenticated request (expected 401, got $unauth)"
    }
    Write-Host 'gateway healthy: /healthz -> 200, unauthenticated /json/version -> 401'
}

if ($InstallTunnel) {
    Start-Service -Name $TunnelServiceName
    Write-Host "tunnel service started: $TunnelServiceName (verify with 'npm run tunnel:doctor' semantics / Cloudflare dashboard)"
}

# --- 9. Lock down the account -------------------------------------------------
if (-not $NoDenyLogon) {
    Add-BmcpDenyLogonRights -Account $ServiceUser
    Write-Host "logon hardening: $ServiceUser may now ONLY log on as a service"
}

# --- 10. Automated security checklist ------------------------------------------
Write-Host ''
& (Join-Path $PSScriptRoot 'security-checklist.ps1') -ServiceName $ServiceName `
    -TunnelServiceName $TunnelServiceName -ServiceUser $ServiceUser -StateDir $StateDir
$checklistExit = $LASTEXITCODE

Write-Host ''
Write-Host 'Install complete.'
Write-Host "  service:      $ServiceName (autostart; restarts on failure)"
Write-Host "  config:       $envFile"
Write-Host "  logs:         $StateDir\logs\browser-mcp.log (+ stderr.log)"
Write-Host "  secrets:      Credential Manager of $ServiceUser (browser-mcp/<NAME>)"
Write-Host "  rotate token: scripts\windows\rotate-token.ps1"
Write-Host "  emergency:    scripts\windows\emergency-stop.ps1"
exit $checklistExit
