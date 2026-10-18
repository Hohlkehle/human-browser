# uninstall.ps1 -- Stage 8: remove the Browser MCP deployment.
#
# Removes (in order): services, event log source, firewall rules created by
# Stage 8, Credential Manager secrets (running the wrapper AS the service
# account), and optionally the local account (-RemoveUser) and the state
# directory with logs (-RemoveState). The repository itself is untouched.

param(
    [string] $ServiceName = 'BrowserMcp',
    [string] $TunnelServiceName = 'BrowserMcpTunnel',
    [string] $ServiceUser = 'bmcp-svc',
    [string] $StateDir = 'C:\ProgramData\browser-mcp',
    [switch] $RemoveUser,
    [switch] $RemoveState
)

Import-Module (Join-Path $PSScriptRoot 'BrowserMcp.Windows.psm1') -Force
$ErrorActionPreference = 'Stop'
Assert-BmcpAdmin -ScriptPath $PSCommandPath -PassthroughArgs (ConvertTo-BmcpArgList -BoundParameters $PSBoundParameters)

$installDir = Get-BmcpInstallDir
$wrapper = Get-BmcpWrapperPath -InstallDir $installDir

# --- 1. Services ---------------------------------------------------------------
foreach ($name in @($ServiceName, $TunnelServiceName)) {
    Remove-BmcpService -ServiceName $name | Out-Null
}

# --- 2. Event log source ---------------------------------------------------------
try {
    Remove-EventLog -Source 'BrowserMcpService' -ErrorAction Stop
    Write-Host 'event log source removed: BrowserMcpService'
}
catch {
    # Not registered -- nothing to do.
}

# --- 3. Firewall rules -------------------------------------------------------------
Remove-BmcpAllFirewallRules

# --- 4. Credential Manager secrets (must run AS the service user) -------------------
$account = Get-LocalUser -Name $ServiceUser -ErrorAction SilentlyContinue
if ($null -ne $account -and (Test-Path -LiteralPath $wrapper)) {
    # The deny-logon rights (set by install) block the helper's interactive
    # logon; lift them, delete the secrets, then restore or drop the account.
    Remove-BmcpDenyLogonRights -Account $ServiceUser
    try {
        $credential = Initialize-BmcpServiceUser -UserName $ServiceUser
        foreach ($secret in @('CDP_GATEWAY_TOKEN', 'CLOUDFLARE_TUNNEL_TOKEN')) {
            Remove-BmcpSecret -WrapperExe $wrapper -Name $secret -Credential $credential | Out-Null
        }
    }
    finally {
        if (-not $RemoveUser) {
            Add-BmcpDenyLogonRights -Account $ServiceUser
        }
    }
}
else {
    Write-Warning "cannot delete Credential Manager secrets (user '$ServiceUser' or wrapper missing); orphaned vault entries of a deleted account are unreadable by anyone else"
}

# --- 5. Optional: account and state ---------------------------------------------------
if ($RemoveUser) {
    if ($null -ne $account) {
        Remove-LocalUser -Name $ServiceUser
        Write-Host "local user removed: $ServiceUser"
    }
}
if ($RemoveState) {
    if (Test-Path -LiteralPath $StateDir) {
        Remove-Item -LiteralPath $StateDir -Recurse -Force
        Write-Host "state directory removed: $StateDir (logs deleted)"
    }
}

Write-Host ''
Write-Host 'Uninstall complete.'
if (-not $RemoveUser) { Write-Host "  kept: local user $ServiceUser (remove later with -RemoveUser)" }
if (-not $RemoveState) { Write-Host "  kept: $StateDir (logs; remove later with -RemoveState)" }
