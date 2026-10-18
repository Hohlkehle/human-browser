@echo off
setlocal
set LOG=C:\nginx\browser-mcp-restart.log
echo [%date% %time%] restart begin > "%LOG%"

sc stop BrowserMcp >> "%LOG%" 2>&1
if errorlevel 1 echo [stop] sc exit %errorlevel% >> "%LOG%"

REM wait up to 30s for STOPPED
set /a tries=0
:waitstop
sc query BrowserMcp | find "STOPPED" >nul 2>&1
if %errorlevel%==0 goto stopped
set /a tries+=1
if %tries% geq 30 goto stopped
timeout /t 1 /nobreak >nul 2>&1
goto waitstop

:stopped
echo [%time%] service stopped >> "%LOG%"
sc start BrowserMcp >> "%LOG%" 2>&1
if errorlevel 1 echo [start] sc exit %errorlevel% >> "%LOG%"

REM wait up to 30s for RUNNING
set /a tries=0
:waitrun
sc query BrowserMcp | find "RUNNING" >nul 2>&1
if %errorlevel%==0 goto running
set /a tries+=1
if %tries% geq 30 goto running
timeout /t 1 /nobreak >nul 2>&1
goto waitrun

:running
echo [%time%] service running >> "%LOG%"
netstat -ano | find ":9230" >> "%LOG%" 2>&1
netstat -ano | find ":9229" >> "%LOG%" 2>&1
echo [%date% %time%] restart done >> "%LOG%"
endlocal
