# scripts/start-local.ps1 - Запуск Browser MCP и Chrome в режиме отладки
param(
    [switch]$NoChrome,
    [switch]$Background
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'Stop'
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

function Write-Err([string]$msg) {
    Write-Host "[ERR]  $msg" -ForegroundColor Red
}

function Test-PortOpen([string]$hostName, [int]$port, [int]$timeoutMs = 1200) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect($hostName, $port, $null, $null)
        $wait = $iar.AsyncWaitHandle.WaitOne($timeoutMs, $false)
        if (-not $wait) {
            $tcp.Close()
            return $false
        }
        $tcp.EndConnect($iar)
        $tcp.Close()
        return $true
    } catch {
        return $false
    }
}

Write-Host "========================================" -ForegroundColor Blue
Write-Host "     Human-Browser MCP / Запуск        " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Blue

# 1. Проверка Node.js
try {
    $nodeVer = (node -v).Trim()
    Write-Info "Node.js: $nodeVer"
} catch {
    Write-Err "Node.js не найден в PATH! Установите Node.js 22+ (https://nodejs.org)."
    exit 1
}

# 2. Проверка и подготовка .env
$envFile = Join-Path $repoRoot ".env"
$envExample = Join-Path $repoRoot ".env.example"

if (-not (Test-Path $envFile)) {
    Write-Info ".env файл не найден. Создаю из .env.example..."
    if (Test-Path $envExample) {
        $envContent = Get-Content $envExample -Raw
    } else {
        $envContent = ""
    }

    # Генерируем 32-байтный hex токен
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $generatedToken = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""

    if ($envContent -match "(?m)^#?\s*CDP_GATEWAY_TOKEN=.*$") {
        $envContent = $envContent -replace "(?m)^#?\s*CDP_GATEWAY_TOKEN=.*$", "CDP_GATEWAY_TOKEN=$generatedToken"
    } else {
        $envContent += "`r`nCDP_GATEWAY_TOKEN=$generatedToken`r`n"
    }

    if ($envContent -match "(?m)^#\s*BROWSER_ALLOWED_DOMAINS=\*") {
        $envContent = $envContent -replace "(?m)^#\s*BROWSER_ALLOWED_DOMAINS=\*", "BROWSER_ALLOWED_DOMAINS=*"
        $envContent = $envContent -replace "(?m)^BROWSER_ALLOWED_DOMAINS=partslink24.*$", "# BROWSER_ALLOWED_DOMAINS=partslink24.com,www.partslink24.com,partsouq.com,www.partsouq.com"
    }

    Set-Content -Path $envFile -Value $envContent -Encoding utf8
    Write-Success "Создан .env с токеном: $generatedToken"
}

# Загружаем переменные из .env для скрипта
$envMap = @{}
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and ($line -match "^([^=]+)=(.*)$")) {
        $envMap[$matches[1].Trim()] = $matches[2].Trim()
    }
}
$mcpPort = if ($envMap.ContainsKey("MCP_LISTEN_PORT")) { [int]$envMap["MCP_LISTEN_PORT"] } else { 9230 }
$gatewayPort = if ($envMap.ContainsKey("GATEWAY_LISTEN_PORT")) { [int]$envMap["GATEWAY_LISTEN_PORT"] } else { 9229 }
$token = if ($envMap.ContainsKey("CDP_GATEWAY_TOKEN")) { $envMap["CDP_GATEWAY_TOKEN"] } else { "" }

# 3. Проверка зависимостей и сборки
if (-not (Test-Path "$repoRoot\node_modules")) {
    Write-Info "Установка npm зависимостей..."
    npm install --strict-ssl=false
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Не удалось установить зависимости npm"
        exit 1
    }
}

if (-not (Test-Path "$repoRoot\dist\src\main.js")) {
    Write-Info "Сборка проекта (TypeScript)..."
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Ошибка компиляции TypeScript"
        exit 1
    }
}

# 4. Проверка и запуск Chrome (порт 9222)
if (-not $NoChrome) {
    if (Test-PortOpen "127.0.0.1" 9222) {
        Write-Success "Chrome с поддержкой CDP уже запущен (порт 9222 доступен)."
    } else {
        Write-Info "Проверяем наличие Google Chrome..."
        $chromeCandidates = @(
            "C:\Program Files\Google\Chrome\Application\chrome.exe",
            "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
            "C:\helium\chrome.exe"
        )
        $chromeExe = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

        if ($chromeExe) {
            Write-Info "Запускаем Chrome с портом отладки 9222..."
            $userDataDir = "$env:TEMP\chrome-debug-profile"
            $chromeProc = Start-Process -FilePath $chromeExe `
                -ArgumentList @("--remote-debugging-port=9222", "--user-data-dir=$userDataDir", "--no-first-run", "--no-default-browser-check") `
                -PassThru

            Set-Content -Path "$repoRoot\.chrome.pid" -Value $chromeProc.Id -Encoding ascii

            # Ожидание открытия порта 9222
            $ready = $false
            for ($i = 0; $i -lt 15; $i++) {
                Start-Sleep -Milliseconds 500
                if (Test-PortOpen "127.0.0.1" 9222) {
                    $ready = $true
                    break
                }
            }
            if ($ready) {
                Write-Success "Chrome запущен (PID: $($chromeProc.Id), порт: 9222)"
            } else {
                Write-Warn "Chrome запущен, но порт 9222 ещё не отвечает. Продолжаем запуск..."
            }
        } else {
            Write-Warn "Google Chrome не найден по стандартным путям."
            Write-Warn "Пожалуйста, запустите Chrome вручную с ключом: --remote-debugging-port=9222"
        }
    }
}

# 5. Проверка работы сервера
if (Test-PortOpen "127.0.0.1" $mcpPort) {
    Write-Warn "Сервер Human-Browser MCP уже слушает порт $mcpPort!"
    Write-Info "Для остановки выполните: stop.bat"
    exit 0
}

# 6. Запуск сервера MCP
$serverArgs = @("--env-file-if-exists=.env", "dist/src/main.js")

if ($Background) {
    Write-Info "Запуск сервера в фоновом окне..."
    $serverProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/k title Human-Browser MCP Server && cd /d `"$repoRoot`" && node --env-file-if-exists=.env dist/src/main.js" `
        -WorkingDirectory $repoRoot `
        -PassThru

    Set-Content -Path "$repoRoot\.server.pid" -Value $serverProc.Id -Encoding ascii

    # Ожидание готовности healthcheck
    Write-Info "Ожидание готовности сервера..."
    $healthUrl = "http://127.0.0.1:$mcpPort/healthz"
    $healthy = $false

    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $res = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 -ErrorAction SilentlyContinue
            if ($res -and $res.status -eq "ok") {
                $healthy = $true
                break
            }
        } catch {}
    }

    # Сохраняем реальный PID слушающего процесса node
    $listeningConn = Get-NetTCPConnection -LocalPort $mcpPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listeningConn -and $listeningConn.OwningProcess) {
        Set-Content -Path "$repoRoot\.server.pid" -Value $listeningConn.OwningProcess -Encoding ascii
    }

    Write-Host ""
    if ($healthy) {
        Write-Host "==========================================================" -ForegroundColor Green
        Write-Host "   Сервер Human-Browser MCP успешно запущен в фоне!        " -ForegroundColor Green
        Write-Host "==========================================================" -ForegroundColor Green
        Write-Host "  MCP Endpoint:       http://127.0.0.1:$mcpPort/mcp" -ForegroundColor Cyan
        Write-Host "  Healthcheck:        http://127.0.0.1:$mcpPort/healthz" -ForegroundColor Cyan
        Write-Host "  CDP Gateway:        http://127.0.0.1:$gatewayPort" -ForegroundColor Cyan
        Write-Host "  Chrome Remote CDP:  http://127.0.0.1:9222" -ForegroundColor Cyan
        if ($token) {
            Write-Host "  Bearer Token:       $token" -ForegroundColor Yellow
        }
        Write-Host "==========================================================" -ForegroundColor Green
        Write-Host "Для остановки запустите: stop.bat" -ForegroundColor White
    } else {
        Write-Err "Сервер запущен (PID: $($serverProc.Id)), но healthcheck не вернул 'ok'."
        Write-Warn "Проверьте окно консоли 'Human-Browser MCP Server' для просмотра логов."
        exit 1
    }
    Write-Host ""
    exit 0
}

# Режим переднего плана (Foreground по умолчанию для start.bat):
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "   Сервер Human-Browser MCP запускается...                " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  MCP Endpoint:       http://127.0.0.1:$mcpPort/mcp" -ForegroundColor Cyan
Write-Host "  Healthcheck:        http://127.0.0.1:$mcpPort/healthz" -ForegroundColor Cyan
Write-Host "  CDP Gateway:        http://127.0.0.1:$gatewayPort" -ForegroundColor Cyan
Write-Host "  Chrome Remote CDP:  http://127.0.0.1:9222" -ForegroundColor Cyan
if ($token) {
    Write-Host "  Bearer Token:       $token" -ForegroundColor Yellow
}
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Для остановки нажмите Ctrl+C или запустите stop.bat       " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Info "Логи сервера:"

Set-Content -Path "$repoRoot\.server.pid" -Value $PID -Encoding ascii

try {
    & node $serverArgs
} finally {
    Remove-Item "$repoRoot\.server.pid" -Force -ErrorAction SilentlyContinue
}
exit $LASTEXITCODE