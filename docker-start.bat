@echo off
setlocal
cd /d "%~dp0"
echo [INFO] Checking .env...
if not exist ".env" (
    powershell -NoProfile -Command "$b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $t = ($b | ForEach-Object { $_.ToString('x2') }) -join ''; (Get-Content .env.example -Raw) -replace '(?m)^#?\s*CDP_GATEWAY_TOKEN=.*$', ('CDP_GATEWAY_TOKEN=' + $t) | Set-Content .env -Encoding utf8"
)
docker compose up -d --build
exit /b %ERRORLEVEL%
