# rollback.ps1 -- Stage 8: restore the previous release from a rollback point.
#
# Rollback points are created by upgrade.ps1 under <installDir>\backups\.
# Without -Timestamp the newest point is used.

param(
    [string] $Timestamp,
    [string] $ServiceName = 'BrowserMcp',
    [string] $TunnelServiceName = 'BrowserMcpTunnel'
)

Import-Module (Join-Path $PSScriptRoot 'BrowserMcp.Windows.psm1') -Force
$ErrorActionPreference = 'Stop'
Assert-BmcpAdmin -ScriptPath $PSCommandPath -PassthroughArgs (ConvertTo-BmcpArgList -BoundParameters $PSBoundParameters)

$installDir = Get-BmcpInstallDir
$backupsRoot = Join-Path $installDir 'backups'

$backupDir = $null
if ($Timestamp) {
    $candidate = Join-Path $backupsRoot $Timestamp
    if (-not (Test-Path -LiteralPath $candidate)) { throw "rollback point not found: $candidate" }
    $backupDir = $candidate
}
else {
    $backupDir = Get-ChildItem -Path $backupsRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
    if (-not $backupDir) { throw "no rollback points found under $backupsRoot" }
}
Write-Host "rolling back to: $backupDir"

# --- 1. Stop services ---------------------------------------------------------
foreach ($name in @($ServiceName, $TunnelServiceName)) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($null -ne $svc -and $svc.Status -eq 'Running') {
        Stop-Service -Name $name -Force
        Write-Host "stopped: $name"
    }
}

# --- 2. Restore the snapshot ----------------------------------------------------
$distDir = Join-Path $installDir 'dist'
if (Test-Path -LiteralPath $distDir) { Remove-Item -LiteralPath $distDir -Recurse -Force }
Copy-Item -Path (Join-Path $backupDir 'dist') -Destination $distDir -Recurse
Copy-Item -Path (Join-Path $backupDir 'package.json') -Destination $installDir -Force
Copy-Item -Path (Join-Path $backupDir 'package-lock.json') -Destination $installDir -Force

# Align node_modules with the restored lock file (needs network; if offline the
# previous node_modules usually still matches -- warn instead of failing).
Push-Location $installDir
try {
    npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'npm ci failed (offline?) -- continuing with the existing node_modules'
    }
}
finally {
    Pop-Location
}

# --- 3. Start and verify ----------------------------------------------------------
Start-Service -Name $ServiceName
$tunnel = Get-Service -Name $TunnelServiceName -ErrorAction SilentlyContinue
if ($null -ne $tunnel) { Start-Service -Name $TunnelServiceName }

if (-not (Wait-BmcpHealth -Url 'http://127.0.0.1:9230/healthz' -TimeoutSeconds 30)) {
    Write-Error 'rollback verification FAILED: /healthz not 200; investigate manually'
    exit 1
}
Write-Host "rollback complete and verified (restored: $backupDir)"
