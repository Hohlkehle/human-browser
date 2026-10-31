@echo off
setlocal
echo [INFO] Searching for Chrome...
set "CHROME_EXE="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
if "%CHROME_EXE%"=="" if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if "%CHROME_EXE%"=="" if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if "%CHROME_EXE%"=="" (
    echo [ERROR] Google Chrome was not found.
    exit /b 1
)
echo [OK] Launching Chrome on port 9222...
start "" "%CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%TEMP%\chrome-debug-profile" --no-first-run --no-default-browser-check
exit /b 0
