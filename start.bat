@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Human-Browser MCP

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" %*
set EXITCODE=%ERRORLEVEL%

if %EXITCODE% neq 0 (
    echo.
    echo [ERROR] Startup failed with error code %EXITCODE%.
    echo.
    pause
)
exit /b %EXITCODE%
