# security-checklist.ps1 -- Stage 8: automated security verification.
#
# Runs every check an operator would do by hand and exits non-zero on any
# FAIL. WARN marks hardening that is recommended but not fatal. Run it after
# install, after rotation, after upgrades, and periodically.
#
# Checks: service state/account, account privileges and deny-logon rights,
# wrapper freshness, service.env secret-freedom and ACLs, loopback-only MCP,
# live gateway bearer auth, firewall scoping (subnet-only, no 9222 rules),
# firewall profiles enabled, per-interface exposure probes incl. a true
# external probe from WSL (9229 unreachable outside the subnet), bounded
# logs, SCM failure recovery, event log source, Node version, and Credential
# Manager secret presence (via the wrapper's startup record).

param(
    [string] $ServiceName = 'BrowserMcp',
    [string] $TunnelServiceName = 'BrowserMcpTunnel',
    [string] $ServiceUser = 'bmcp-svc',
    [string] $StateDir = 'C:\ProgramData\browser-mcp'
)

Import-Module (Join-Path $PSScriptRoot 'BrowserMcp.Windows.psm1') -Force
$ErrorActionPreference = 'Stop'

$installDir = Get-BmcpInstallDir
$script:failCount = 0
$script:warnCount = 0
$script:passCount = 0

function Write-CheckResult {
    param([string] $Status, [string] $Id, [string] $Detail)
    $color = switch ($Status) {
        'PASS' { 'Green' }
        'FAIL' { 'Red' }
        'WARN' { 'Yellow' }
        default { 'Gray' }
    }
    Write-Host ("[{0}] {1,-24} {2}" -f $Status, $Id, $Detail) -ForegroundColor $color
    switch ($Status) {
        'PASS' { $script:passCount++ }
        'FAIL' { $script:failCount++ }
        'WARN' { $script:warnCount++ }
    }
}

function Read-ServiceEnv {
    $result = @{}
    $envFile = Join-Path $StateDir 'service.env'
    if (-not (Test-Path -LiteralPath $envFile)) { return $result }
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $result[$Matches[1]] = $Matches[2].Trim()
        }
    }
    return $result
}

$svcEnv = Read-ServiceEnv

# --- 1. Service state -----------------------------------------------------------
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $svc) {
    Write-CheckResult 'FAIL' 'service-running' "service $ServiceName does not exist"
}
elseif ($svc.Status -ne 'Running') {
    Write-CheckResult 'FAIL' 'service-running' "service exists but status is $($svc.Status)"
}
elseif ($svc.StartType -ne 'Automatic') {
    Write-CheckResult 'FAIL' 'service-running' "running, but StartType is $($svc.StartType) (must be Automatic for reboot recovery)"
}
else {
    Write-CheckResult 'PASS' 'service-running' "$ServiceName is Running with StartType Automatic"
}

# --- 2. Service account -----------------------------------------------------------
$wmiSvc = Get-CimInstance Win32_Service -Filter "Name = '$ServiceName'" -ErrorAction SilentlyContinue
if ($null -ne $wmiSvc) {
    $startName = $wmiSvc.StartName
    $systemAccounts = @('LocalSystem', 'NT AUTHORITY\SYSTEM', 'NT AUTHORITY\LocalService', 'NT AUTHORITY\NetworkService', '.\Administrator', "$env:COMPUTERNAME\Administrator")
    if ($systemAccounts -contains $startName) {
        Write-CheckResult 'FAIL' 'service-account' "runs as $startName (must be the dedicated account)"
    }
    elseif ($startName -notlike "*\$ServiceUser") {
        Write-CheckResult 'WARN' 'service-account' "runs as $startName (expected .\$ServiceUser)"
    }
    else {
        Write-CheckResult 'PASS' 'service-account' "runs as the dedicated account $startName"
    }
}

# --- 3. Account privileges ----------------------------------------------------------
$localUser = Get-LocalUser -Name $ServiceUser -ErrorAction SilentlyContinue
if ($null -eq $localUser) {
    Write-CheckResult 'WARN' 'account-not-admin' "local user $ServiceUser not found (custom deployment?)"
}
else {
    $admins = Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue
    if ($admins | Where-Object { $_.Name -like "*\$ServiceUser" }) {
        Write-CheckResult 'FAIL' 'account-not-admin' "$ServiceUser is a member of Administrators"
    }
    else {
        Write-CheckResult 'PASS' 'account-not-admin' "$ServiceUser has no administrator membership"
    }
}

# --- 4. Deny-logon hardening ----------------------------------------------------------
if ($null -ne $localUser) {
    $seceditFile = Join-Path $env:TEMP ("bmcp-secedit-{0}.inf" -f ([guid]::NewGuid().ToString('N')))
    & secedit /export /cfg $seceditFile /areas USER_RIGHTS | Out-Null
    $sid = $localUser.SID.Value
    $inf = @(Get-Content -LiteralPath $seceditFile -ErrorAction SilentlyContinue)
    Remove-Item -LiteralPath $seceditFile -Force -ErrorAction SilentlyContinue
    if ($inf.Count -eq 0) {
        Write-CheckResult 'WARN' 'deny-logon-rights' 'secedit export unavailable (run the checklist elevated to verify)'
    }
    else {
        # Entries appear either as bare names (bmcp-svc) or as *S-1-... SIDs.
        $pattern = '(\*' + [regex]::Escape($sid) + '|(^|=|,)\s*' + [regex]::Escape($ServiceUser) + '\s*(,|$))'
        $denyInteractive = ($inf | Where-Object { $_ -match '^SeDenyInteractiveLogonRight' } | Out-String)
        $denyNetwork = ($inf | Where-Object { $_ -match '^SeDenyNetworkLogonRight' } | Out-String)
        if ($denyInteractive -match $pattern -and $denyNetwork -match $pattern) {
            Write-CheckResult 'PASS' 'deny-logon-rights' "$ServiceUser can only log on as a service"
        }
        else {
            Write-CheckResult 'WARN' 'deny-logon-rights' "interactive/network logon not denied for $ServiceUser (run Add-BmcpDenyLogonRights)"
        }
    }
}

# --- 5. Wrapper binary ------------------------------------------------------------------
$wrapper = Get-BmcpWrapperPath -InstallDir $installDir
if (-not (Test-Path -LiteralPath $wrapper)) {
    Write-CheckResult 'FAIL' 'wrapper-binary' "missing: $wrapper"
}
else {
    $source = Join-Path $PSScriptRoot 'BrowserMcpService.cs'
    if ((Get-Item -LiteralPath $source).LastWriteTime -gt (Get-Item -LiteralPath $wrapper).LastWriteTime) {
        Write-CheckResult 'WARN' 'wrapper-binary' 'source is newer than the exe; recompile (install.ps1 does this)'
    }
    else {
        Write-CheckResult 'PASS' 'wrapper-binary' 'compiled and up to date'
    }
}

# --- 6. service.env contains no secrets ---------------------------------------------------
$envFile = Join-Path $StateDir 'service.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    Write-CheckResult 'FAIL' 'service-env' "missing: $envFile"
}
else {
    $offenders = @()
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if (-not (Test-BmcpEnvLineSecretFree -Line $line)) { $offenders += $line.Split('=')[0] }
    }
    if ($offenders.Count -gt 0) {
        Write-CheckResult 'FAIL' 'service-env-no-secrets' "secret-looking values present: $($offenders -join ', ')"
    }
    else {
        Write-CheckResult 'PASS' 'service-env-no-secrets' 'no secret values in service.env'
    }

    # --- 7. service.env ACL ---------------------------------------------------------------
    # Unprivileged principals by SID (locale-independent):
    # S-1-1-0 Everyone, S-1-5-32-545 Users, S-1-5-11 Authenticated Users.
    $acl = Get-Acl -LiteralPath $envFile
    $bad = $acl.Access | Where-Object {
        $isUnprivileged = $false
        try {
            $aceSid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
            $isUnprivileged = @('S-1-1-0', 'S-1-5-32-545', 'S-1-5-11') -contains $aceSid
        }
        catch {
            $isUnprivileged = $false
        }
        $isUnprivileged -and
        $_.AccessControlType -eq 'Allow' -and
        ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Write) -ne 0
    }
    if ($bad) {
        Write-CheckResult 'FAIL' 'service-env-acl' 'world-writable service.env'
    }
    else {
        Write-CheckResult 'PASS' 'service-env-acl' 'service.env is not writable by unprivileged accounts'
    }
}

# --- 8. MCP endpoint bind address -----------------------------------------------------------
$mcpHost = $svcEnv['MCP_LISTEN_HOST']
if (-not $mcpHost) { $mcpHost = '127.0.0.1' }
if (@('127.0.0.1', '::1', 'localhost') -contains $mcpHost) {
    Write-CheckResult 'PASS' 'mcp-loopback-only' "MCP_LISTEN_HOST=$mcpHost"
}
elseif (@('0.0.0.0', '::') -contains $mcpHost) {
    $mcpBindPort = if ($svcEnv['MCP_LISTEN_PORT']) { $svcEnv['MCP_LISTEN_PORT'] } else { 9230 }
    Write-CheckResult 'WARN' 'mcp-loopback-only' "MCP_LISTEN_HOST=$mcpHost binds every interface and the MCP endpoint has no authentication; restrict TCP $mcpBindPort with a firewall rule"
}
else {
    Write-CheckResult 'FAIL' 'mcp-loopback-only' "MCP_LISTEN_HOST=$mcpHost (only loopback or the wildcard 0.0.0.0/:: is accepted; the server will refuse to start)"
}

# --- 9./10. Live endpoint checks -------------------------------------------------------------
$gatewayEnabled = ($svcEnv['GATEWAY_ENABLED'] -ne 'false')
$gatewayPort = if ($svcEnv['GATEWAY_LISTEN_PORT']) { [int]$svcEnv['GATEWAY_LISTEN_PORT'] } else { 9229 }
$mcpPort = if ($svcEnv['MCP_LISTEN_PORT']) { [int]$svcEnv['MCP_LISTEN_PORT'] } else { 9230 }

if ($null -ne $svc -and $svc.Status -eq 'Running') {
    $mcpHealth = Get-BmcpHttpStatus -Url "http://127.0.0.1:$mcpPort/healthz"
    $mcpReady = Get-BmcpHttpStatus -Url "http://127.0.0.1:$mcpPort/readyz"
    if ($mcpHealth -eq 200 -and $mcpReady -eq 200) {
        Write-CheckResult 'PASS' 'mcp-health' "healthz/readyz -> 200 on 127.0.0.1:$mcpPort"
    }
    else {
        Write-CheckResult 'FAIL' 'mcp-health' "healthz=$mcpHealth readyz=$mcpReady"
    }

    if ($gatewayEnabled) {
        $gwHealth = Get-BmcpHttpStatus -Url "http://127.0.0.1:$gatewayPort/healthz"
        $unauth = Get-BmcpHttpStatus -Url "http://127.0.0.1:$gatewayPort/json/version"
        if ($gwHealth -eq 200 -and $unauth -eq 401) {
            Write-CheckResult 'PASS' 'gateway-auth' "healthz -> 200, unauthenticated /json/version -> 401 (bearer enforced)"
        }
        else {
            Write-CheckResult 'FAIL' 'gateway-auth' "healthz=$gwHealth (want 200), unauth /json/version=$unauth (want 401)"
        }
    }
}
else {
    Write-CheckResult 'WARN' 'mcp-health' 'service not running; live checks skipped'
}

# --- 11. Firewall scoping for the gateway port -------------------------------------------------
$gatewayHost = $svcEnv['GATEWAY_LISTEN_HOST']
if (-not $gatewayHost) { $gatewayHost = '127.0.0.1' }
$allowedCidrs = @()
if ($svcEnv['GATEWAY_ALLOWED_CIDRS']) { $allowedCidrs = $svcEnv['GATEWAY_ALLOWED_CIDRS'].Split(',') | ForEach-Object { $_.Trim() } }

$portRules = @(Get-BmcpPortRules -Port $gatewayPort | Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -ne 'False' })
if ($gatewayHost -eq '0.0.0.0' -or $gatewayHost -eq '::') {
    $allowRules = @($portRules | Where-Object { $_.Action -eq 'Allow' })
    if ($allowRules.Count -eq 0) {
        Write-CheckResult 'WARN' 'firewall-scoping' "gateway binds 0.0.0.0 but no inbound allow rule exists (LAN clients will be blocked by the default policy)"
    }
    else {
        $unscoped = @($allowRules | Where-Object {
            $ra = $_.RemoteAddress
            (-not $ra) -or ($ra -contains 'Any') -or ($ra -contains '*')
        })
        if ($unscoped.Count -gt 0) {
            Write-CheckResult 'FAIL' 'firewall-scoping' "unscoped allow rule(s) for $gatewayPort : $($unscoped.DisplayName -join '; ')"
        }
        else {
            Write-CheckResult 'PASS' 'firewall-scoping' "$($allowRules.Count) allow rule(s), all remote-address scoped"
        }
    }
}
else {
    $allows = @($portRules | Where-Object { $_.Action -eq 'Allow' })
    if ($allows.Count -gt 0) {
        Write-CheckResult 'WARN' 'firewall-scoping' "gateway binds loopback but inbound allow rules for $gatewayPort exist: $($allows.DisplayName -join '; ')"
    }
    else {
        Write-CheckResult 'PASS' 'firewall-scoping' "gateway binds loopback; no inbound rules needed for $gatewayPort"
    }
}

# --- 12. Chrome debugging port must have no inbound rules ----------------------------------------
$rules9222 = @(Get-BmcpPortRules -Port 9222 | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Enabled -ne 'False' })
if ($rules9222.Count -gt 0) {
    Write-CheckResult 'FAIL' 'no-9222-rule' "inbound allow rule(s) exist for Chrome CDP port 9222: $($rules9222.DisplayName -join '; ')"
}
else {
    Write-CheckResult 'PASS' 'no-9222-rule' 'no inbound allow rules for 9222 (Chrome stays loopback-only)'
}

# --- 13. Firewall profiles enabled -------------------------------------------------------
# The 0.0.0.0 gateway bind depends on the OS firewall layer; with profiles
# disabled the scoped rule is dead letter and the port is open to everyone.
$profiles = @(Get-NetFirewallProfile -ErrorAction SilentlyContinue)
$disabledProfiles = @($profiles | Where-Object { $_.Enabled -eq $false })
if ($profiles.Count -eq 0) {
    Write-CheckResult 'WARN' 'firewall-enabled' 'could not query firewall profiles'
}
elseif ($disabledProfiles.Count -gt 0) {
    $names = ($disabledProfiles | ForEach-Object { $_.Name }) -join ', '
    if ($gatewayHost -eq '0.0.0.0' -or $gatewayHost -eq '::') {
        Write-CheckResult 'FAIL' 'firewall-enabled' "Windows Firewall is DISABLED for: $names -- the subnet rule does not apply (Set-NetFirewallProfile -Enabled True)"
    }
    else {
        Write-CheckResult 'WARN' 'firewall-enabled' "Windows Firewall is disabled for: $names (gateway is loopback-only, but enabling it is recommended)"
    }
}
else {
    Write-CheckResult 'PASS' 'firewall-enabled' 'all firewall profiles are enabled'
}

# --- 14. Per-interface exposure probes ----------------------------------------------------
# Two probe classes:
#  - LOCAL self-probes: prove LISTENER BINDING only. Traffic from a machine
#    to its own addresses bypasses inbound firewall rules, so a local OPEN on
#    the gateway port says nothing about firewall scoping.
#  - EXTERNAL probes from the WSL2 VM (when available): genuine remote traffic
#    that the firewall filters. WinNAT hairpin rewrites the source of
#    WSL->host-physical-IP traffic to the host's own address, so a destination
#    INSIDE the allowed subnet appears to arrive from an in-subnet source (the
#    rule allows it -- consistent with real LAN clients). Destinations OUTSIDE
#    the subnet arrive with the WSL source intact and MUST be blocked.
if ($null -ne $svc -and $svc.Status -eq 'Running') {
    $exposureFail = $false
    $details = @()
    $localAddresses = @(Get-BmcpLocalIPv4)

    foreach ($addr in $localAddresses) {
        $ip = $addr.IPAddress
        # MCP must never listen beyond loopback (binding proof).
        if (Test-BmcpTcp -TargetHost $ip -Port $mcpPort -TimeoutMs 1500) {
            $exposureFail = $true
            $details += "$ip`:$mcpPort OPEN (MCP must be loopback-only)"
        }
        else {
            $details += "$ip`:$mcpPort unreachable (correct)"
        }
        # Gateway on non-loopback IPs: local probes bypass the firewall, so
        # only a loopback BINDING can be proven locally.
        if ($gatewayEnabled -and @('127.0.0.1', '::1') -notcontains $gatewayHost) {
            if (-not (Test-BmcpTcp -TargetHost $ip -Port $gatewayPort -TimeoutMs 1500)) {
                $details += "$ip`:$gatewayPort closed (gateway not listening here)"
            }
        }
    }

    # External (WSL) probes: the real firewall-scoping proof for 9229.
    $wslAvailable = $false
    if ($gatewayEnabled -and ($gatewayHost -eq '0.0.0.0' -or $gatewayHost -eq '::')) {
        foreach ($addr in $localAddresses) {
            $ip = $addr.IPAddress
            $open = Test-BmcpExternalTcp -TargetHost $ip -Port $gatewayPort
            if ($null -eq $open) { continue }
            $wslAvailable = $true
            $inAllowed = $false
            foreach ($cidr in $allowedCidrs) {
                if (Test-BmcpIpInCidr -Ip $ip -Cidr $cidr) { $inAllowed = $true; break }
            }
            if ($inAllowed) {
                if ($open) {
                    $details += "WSL->$ip`:$gatewayPort reachable (in-subnet, allowed)"
                }
                else {
                    $details += "WSL->$ip`:$gatewayPort closed (in-subnet; rule may be missing)"
                }
            }
            elseif ($open) {
                $exposureFail = $true
                $details += "WSL->$ip`:$gatewayPort OPEN (must be blocked: source outside the subnet)"
            }
            else {
                $details += "WSL->$ip`:$gatewayPort blocked (correct)"
            }
        }
        if (-not $wslAvailable) {
            Write-CheckResult 'WARN' 'external-probe' 'WSL unavailable; verify from a machine OUTSIDE the subnet: Test-NetConnection <host> -Port 9229 -> TcpTestSucceeded: False'
        }
    }

    if ($localAddresses.Count -eq 0) {
        Write-CheckResult 'WARN' 'interface-exposure' 'no non-loopback IPv4 addresses to probe'
    }
    elseif ($exposureFail) {
        Write-CheckResult 'FAIL' 'interface-exposure' ($details -join '; ')
    }
    else {
        Write-CheckResult 'PASS' 'interface-exposure' ($details -join '; ')
    }
}

# --- 15. Bounded logs --------------------------------------------------------------------------------
$logFile = $svcEnv['LOG_FILE']
if (-not $logFile) {
    Write-CheckResult 'WARN' 'logs-bounded' 'LOG_FILE not set; structured logs are not persisted'
}
elseif (-not (Test-Path -LiteralPath $logFile)) {
    Write-CheckResult 'WARN' 'logs-bounded' "LOG_FILE configured but missing: $logFile (service not started yet?)"
}
else {
    $maxBytes = if ($svcEnv['LOG_FILE_MAX_BYTES']) { [long]$svcEnv['LOG_FILE_MAX_BYTES'] } else { 10485760 }
    $maxFiles = if ($svcEnv['LOG_FILE_MAX_FILES']) { [int]$svcEnv['LOG_FILE_MAX_FILES'] } else { 5 }
    $dir = Split-Path -Parent $logFile
    $base = Split-Path -Leaf $logFile
    $siblings = @(Get-ChildItem -Path $dir -Filter "$base.*" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '\.\d+$' })
    $oversized = @($siblings | Where-Object { $_.Length -gt $maxBytes })
    if ($siblings.Count -gt $maxFiles) {
        Write-CheckResult 'FAIL' 'logs-bounded' "$($siblings.Count) rotated files (limit $maxFiles)"
    }
    elseif ($oversized.Count -gt 0) {
        Write-CheckResult 'FAIL' 'logs-bounded' "rotated file exceeds $maxBytes bytes: $($oversized[0].Name)"
    }
    else {
        $total = (Get-ChildItem -Path $dir -Filter "$base*" -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        Write-CheckResult 'PASS' 'logs-bounded' ("rotation within limits ({0} siblings, {1:N1} MiB total)" -f $siblings.Count, ($total / 1MB))
    }
}

# --- 16. SCM failure recovery ---------------------------------------------------------------------------
# Parse the FailureActions registry blob (locale-independent; sc.exe qfailure
# output is localized). Layout: resetPeriod(4) rebootMsgLen(4) commandLen(4)
# then SC_ACTION entries { type(4), delay(4) }; type 1 = restart.
$hasRestartAction = $false
try {
    $svcReg = Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" -Name FailureActions -ErrorAction Stop
    $blob = [byte[]]$svcReg.FailureActions
    for ($i = 12; ($i + 7) -lt $blob.Length; $i += 8) {
        if ([BitConverter]::ToInt32($blob, $i) -eq 1) { $hasRestartAction = $true; break }
    }
}
catch {
    $hasRestartAction = $false
}
if ($hasRestartAction) {
    Write-CheckResult 'PASS' 'failure-actions' 'SCM restarts the service on failure'
}
else {
    Write-CheckResult 'FAIL' 'failure-actions' 'no restart recovery action configured'
}

# --- 17. Event log source ----------------------------------------------------------------------------------
if ([System.Diagnostics.EventLog]::SourceExists('BrowserMcpService')) {
    Write-CheckResult 'PASS' 'event-source' 'Application event log source BrowserMcpService registered'
}
else {
    Write-CheckResult 'WARN' 'event-source' 'event source not registered (wrapper falls back to file logs)'
}

# --- 18. Node version ----------------------------------------------------------------------------------------
$nodeExe = $svcEnv['NODE_EXE']
if (-not $nodeExe) { $nodeExe = 'node' }
try {
    $nodeVer = (& $nodeExe --version 2>$null) -replace '^v', ''
    if ([int]($nodeVer.Split('.')[0]) -ge 22) {
        Write-CheckResult 'PASS' 'node-version' "NODE_EXE reports v$nodeVer"
    }
    else {
        Write-CheckResult 'FAIL' 'node-version' "Node >= 22 required, found v$nodeVer"
    }
}
catch {
    Write-CheckResult 'FAIL' 'node-version' "cannot execute NODE_EXE ($nodeExe)"
}

# --- 19. Credential Manager secrets (via the wrapper's startup record) ----------------------------------------
$stderrLog = Join-Path $StateDir 'logs\stderr.log'
if (Test-Path -LiteralPath $stderrLog) {
    $secretLine = Get-Content -LiteralPath $stderrLog |
        Where-Object { $_ -match 'credential manager secrets:' } |
        Select-Object -Last 1
    if (-not $secretLine) {
        Write-CheckResult 'WARN' 'secrets-loaded' 'no wrapper startup record found in stderr.log'
    }
    elseif ($gatewayEnabled -and $secretLine -notmatch 'CDP_GATEWAY_TOKEN=present') {
        Write-CheckResult 'FAIL' 'secrets-loaded' 'CDP_GATEWAY_TOKEN was NOT loaded from Credential Manager at last start'
    }
    else {
        Write-CheckResult 'PASS' 'secrets-loaded' 'wrapper loaded the expected secrets from Credential Manager at last start'
    }
}
else {
    Write-CheckResult 'WARN' 'secrets-loaded' "no stderr.log at $stderrLog"
}

# --- Summary -----------------------------------------------------------------------------------------------------
Write-Host ''
Write-Host ("Security checklist: {0} passed, {1} failed, {2} warnings" -f $script:passCount, $script:failCount, $script:warnCount)
if ($script:failCount -gt 0) {
    Write-Host 'RESULT: FAIL' -ForegroundColor Red
    exit 1
}
Write-Host 'RESULT: PASS' -ForegroundColor Green
exit 0
