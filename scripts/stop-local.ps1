# scripts/stop-local.ps1 - Остановка Browser MCP и отладочного Chrome
param(
    [switch]$KeepChrome
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'Continue'
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $repoRoot

function Write-Info([string]$msg) {
    Write-Host "[INFO] $msg" -ForegroundColor Cyan
}

function Write-Success([string]$msg) {
    Write-Host "[OK]   $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
    Write-Host "[WARN] $msg" -ForegroundColor Yellow
}

Write-Host "========================================" -ForegroundColor Blue
Write-Host "     Human-Browser MCP / Остановка      " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Blue

$stoppedAny = $false
$currentPid = $PID

# 1. Остановка по сохранённому .server.pid
$serverPidFile = Join-Path $repoRoot ".server.pid"
if (Test-Path $serverPidFile) {
    $savedPid = (Get-Content $serverPidFile -ErrorAction SilentlyContinue).Trim()
    if ($savedPid -match '^\d+$') {
        $targetPid = [int]$savedPid
        if ($targetPid -ne $currentPid) {
            try {
                $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
                if ($proc) {
                    Write-Info "Завершаем процесс сервера (PID: $targetPid, $($proc.Name))..."
                    taskkill /F /PID $targetPid /T 2>$null | Out-Null
                    $stoppedAny = $true
                }
            } catch {}
        }
    }
    Remove-Item $serverPidFile -Force -ErrorAction SilentlyContinue
}

# 2. Остановка процессов, слушающих порты 9230 (MCP) и 9229 (Gateway)
$ports = @(9230, 9229)
try {
    $conns = Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue
    $killedPids = @{}

    foreach ($conn in $conns) {
        $targetPid = $conn.OwningProcess
        if ($targetPid -and $targetPid -ne 0 -and $targetPid -ne $currentPid -and -not $killedPids.ContainsKey($targetPid)) {
            $killedPids[$targetPid] = $true
            try {
                $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
                if ($proc) {
                    Write-Info "Завершаем слушающий процесс $($proc.Name) (PID: $targetPid, порт: $($conn.LocalPort))..."
                    taskkill /F /PID $targetPid /T 2>$null | Out-Null
                    $stoppedAny = $true
                }
            } catch {}
        }
    }
} catch {}

# 3. Закрытие консольных окон с заголовком Human-Browser MCP Server (если остались)
try {
    Get-Process cmd -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowTitle -like "*Human-Browser MCP Server*" -and $_.Id -ne $currentPid
    } | ForEach-Object {
        taskkill /F /PID $_.Id /T 2>$null | Out-Null
        $stoppedAny = $true
    }
} catch {}

# 4. Остановка отладочного экземпляра Chrome (порт 9222)
if (-not $KeepChrome) {
    $chromePidFile = Join-Path $repoRoot ".chrome.pid"
    if (Test-Path $chromePidFile) {
        $savedChromePid = (Get-Content $chromePidFile -ErrorAction SilentlyContinue).Trim()
        if ($savedChromePid -match '^\d+$') {
            $cPid = [int]$savedChromePid
            if ($cPid -ne $currentPid) {
                try {
                    $cProc = Get-Process -Id $cPid -ErrorAction SilentlyContinue
                    if ($cProc) {
                        Write-Info "Останавливаем отладочный Chrome (PID: $cPid)..."
                        taskkill /F /PID $cPid /T 2>$null | Out-Null
                        $stoppedAny = $true
                    }
                } catch {}
            }
        }
        Remove-Item $chromePidFile -Force -ErrorAction SilentlyContinue
    }

    # Ищем Chrome, запущенный именно с ключом --remote-debugging-port=9222
    try {
        $debugChromes = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*--remote-debugging-port=9222*" }

        foreach ($dc in $debugChromes) {
            Write-Info "Останавливаем отладочный Chrome (PID: $($dc.ProcessId))..."
            taskkill /F /PID $dc.ProcessId /T 2>$null | Out-Null
            $stoppedAny = $true
        }
    } catch {}
}

Write-Host ""
if ($stoppedAny) {
    Write-Success "Human-Browser MCP и отладочные процессы успешно остановлены."
} else {
    Write-Info "Работающих процессов Human-Browser MCP не обнаружено."
}
Write-Host ""