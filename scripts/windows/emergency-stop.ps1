# emergency-stop.ps1 -- Stage 8: kill all Browser MCP access NOW.
#
# What "emergency stop" guarantees:
#   1. Both services (gateway+MCP, tunnel) are stopped immediately.
#   2. Autostart is disabled -- a reboot cannot bring them back.
#   3. Windows Firewall BLOCKS inbound 9229/9230 -- even a manual start or a
#      rogue process cannot serve those ports from the network.
#   4. The action is recorded in the Application event log.
#
# Re-enable deliberately with:  .\emergency-stop.ps1 -Revert

param(
    [switch] $Revert,
    [string] $ServiceName = 'BrowserMcp',
    [string] $TunnelServiceName = 'BrowserMcpTunnel',
    [string] $ServiceUser = 'bmcp-svc'
)

Import-Module (Join-Path $PSScriptRoot 'BrowserMcp.Windows.psm1') -Force
$ErrorActionPreference = 'Stop'
Assert-BmcpAdmin -ScriptPath $PSCommandPath -PassthroughArgs (ConvertTo-BmcpArgList -BoundParameters $PSBoundParameters)

$serviceNames = @($ServiceName, $TunnelServiceName)

function Write-BmcpEmergencyEvent {
    param([string] $Message, [string] $EntryType)
    try {
        Write-EventLog -LogName Application -Source 'BrowserMcpService' `
            -EventId 1001 -EntryType $EntryType -Message $Message
    }
    catch {
        Write-Warning "could not write to the Application event log: $($_.Exception.Message)"
    }
}

if ($Revert) {
    Write-Host 'Reverting emergency stop...'
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'Browser MCP EMERGENCY BLOCK*' } |
        Remove-NetFirewallRule
    foreach ($name in $serviceNames) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($null -eq $svc) { continue }
        Set-Service -Name $name -StartupType Automatic
        Start-Service -Name $name
        Write-Host "re-enabled and started: $name"
    }
    if (Wait-BmcpHealth -Url 'http://127.0.0.1:9230/healthz' -TimeoutSeconds 30) {
        Write-Host 'MCP endpoint healthy again.'
        Write-BmcpEmergencyEvent -Message 'Emergency stop REVERTED by operator; services re-enabled.' -EntryType Information
    }
    else {
        Write-Warning 'services re-enabled but the MCP endpoint is not healthy yet; check the logs'
    }
    exit 0
}

Write-Host 'EMERGENCY STOP: halting all Browser MCP access...'

# 1. Stop both services (the wrapper performs the graceful CTRL_C hand-over
#    and falls back to force-kill; Stop-Service -Force covers stuck states).
foreach ($name in $serviceNames) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($null -eq $svc) { continue }
    if ($svc.Status -eq 'Running') {
        Stop-Service -Name $name -Force
        Write-Host "stopped: $name"
    }
    # 2. Disable autostart.
    Set-Service -Name $name -StartupType Disabled
    Write-Host "autostart disabled: $name"
}

# Belt and braces: kill any stray node processes owned by the service account
# (e.g. a child that survived a wrapper crash).
$svcAccount = Get-LocalUser -Name $ServiceUser -ErrorAction SilentlyContinue
if ($svcAccount) {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object {
        $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
        if ($owner -and $owner.User -eq $ServiceUser) {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "killed stray node process $($_.ProcessId) owned by the service account"
        }
    }
}

# 3. Firewall block rules (inbound) for both ports.
foreach ($port in @(9229, 9230)) {
    $existing = Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq "Browser MCP EMERGENCY BLOCK ($port)" }
    if (-not $existing) {
        New-NetFirewallRule -DisplayName "Browser MCP EMERGENCY BLOCK ($port)" `
            -Direction Inbound -Action Block -Protocol TCP -LocalPort $port `
            -Description 'Stage 8 emergency stop: port blocked until -Revert' | Out-Null
    }
    Write-Host "firewall: inbound TCP $port BLOCKED"
}

# 4. Verify actual access stop.
$stillOpen = @()
foreach ($port in @(9229, 9230)) {
    if (Test-BmcpTcp -TargetHost '127.0.0.1' -Port $port -TimeoutMs 1500) {
        $stillOpen += $port
    }
}
if ($stillOpen.Count -gt 0) {
    Write-BmcpEmergencyEvent -Message "EMERGENCY STOP incomplete; ports still open: $($stillOpen -join ', ')" -EntryType Error
    throw "emergency stop incomplete -- ports still accepting connections: $($stillOpen -join ', ')"
}

Write-BmcpEmergencyEvent -Message 'EMERGENCY STOP executed by operator: services stopped+disabled, inbound 9229/9230 blocked.' -EntryType Warning

Write-Host ''
Write-Host 'EMERGENCY STOP COMPLETE: no process is serving 9229/9230 and a reboot cannot change that.'
Write-Host 'Re-enable deliberately with:  .\emergency-stop.ps1 -Revert'
