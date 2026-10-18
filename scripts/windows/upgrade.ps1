# upgrade.ps1 -- Stage 8: upgrade Browser MCP in place with a rollback point.
#
# Procedure:
#   1. Stop the services (gateway+MCP and, if present, the tunnel).
#   2. Snapshot dist/, package.json and package-lock.json into
#      <installDir>\backups\<timestamp>\ -- this is the rollback point.
#   3. npm ci + npm run build (update the code with git FIRST, then run this).
#   4. Start the services and verify the health endpoints.
#   On failure: run rollback.ps1 to restore the snapshot.

param(
    [string] $ServiceName = 'BrowserMcp',
    [string] $TunnelServiceName = 'BrowserMcpTunnel'
)

Import-Module (Join-Path $PSScriptRoot 'BrowserMcp.Windows.psm1') -Force
$ErrorActionPreference = 'Stop'
Assert-BmcpAdmin -ScriptPath $PSCommandPath -PassthroughArgs (ConvertTo-BmcpArgList -BoundParameters $PSBoundParameters)

$installDir = Get-BmcpInstallDir
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $installDir "backups\$timestamp"

# --- 1. Stop services ---------------------------------------------------------
foreach ($name in @($ServiceName, $TunnelServiceName)) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($null -ne $svc -and $svc.Status -eq 'Running') {
        Stop-Service -Name $name -Force
        Write-Host "stopped: $name"
    }
}

# --- 2. Snapshot (rollback point) ----------------------------------------------
New-Item -ItemType Directory -Path $backupDir | Out-Null
Copy-Item -Path (Join-Path $installDir 'dist') -Destination (Join-Path $backupDir 'dist') -Recurse
Copy-Item -Path (Join-Path $installDir 'package.json') -Destination $backupDir
Copy-Item -Path (Join-Path $installDir 'package-lock.json') -Destination $backupDir
Write-Host "rollback point created: $backupDir"

# --- 3. Rebuild -----------------------------------------------------------------
Push-Location $installDir
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed -- run rollback.ps1 to restore' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed -- run rollback.ps1 to restore' }
}
finally {
    Pop-Location
}

# Recompile the wrapper too (its source may have changed in this upgrade).
Invoke-BmcpCompileWrapper -InstallDir $installDir | Out-Null

# --- 4. Start and verify ----------------------------------------------------------
Start-Service -Name $ServiceName
$tunnel = Get-Service -Name $TunnelServiceName -ErrorAction SilentlyContinue
if ($null -ne $tunnel) { Start-Service -Name $TunnelServiceName }

if (-not (Wait-BmcpHealth -Url 'http://127.0.0.1:9230/healthz' -TimeoutSeconds 30)) {
    Write-Error "upgrade verification FAILED: /healthz not 200. Roll back with: rollback.ps1 -Timestamp $timestamp"
    exit 1
}
Write-Host "upgrade complete and verified (rollback point: backups\$timestamp)"
