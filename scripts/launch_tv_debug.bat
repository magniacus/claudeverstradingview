@echo off
REM Launch TradingView in Chrome with Chrome DevTools Protocol enabled
REM Usage: scripts\launch_tv_debug.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM Check if CDP already available
curl -s http://localhost:%PORT%/json/version >nul 2>&1
if %errorlevel% equ 0 (
    echo CDP already running at http://localhost:%PORT%
    curl -s http://localhost:%PORT%/json/version
    goto :eof
)

REM Find Chrome
set "CHROME="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

if "%CHROME%"=="" (
    echo Error: Chrome not found.
    exit /b 1
)

echo Killing Chrome and relaunching with CDP on port %PORT%...
taskkill /F /IM chrome.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul

echo Starting Chrome with --remote-debugging-port=%PORT%...
start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%LOCALAPPDATA%\tv-chrome-cdp" --no-first-run --no-default-browser-check https://www.tradingview.com/chart/

echo Waiting for CDP...
ping -n 5 127.0.0.1 >nul

:check
curl -s http://localhost:%PORT%/json/version >nul 2>&1
if %errorlevel% neq 0 (
    echo Still waiting...
    ping -n 3 127.0.0.1 >nul
    goto check
)

echo.
echo CDP ready at http://localhost:%PORT%
curl -s http://localhost:%PORT%/json/version
echo.
