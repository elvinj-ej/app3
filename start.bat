@echo off
setlocal
REM ------------------------------------------------------------------
REM  On-Prem Footprint - one-click start
REM  Usage:  start.bat            (uses port 8080)
REM          start.bat 9000       (uses port 9000)
REM ------------------------------------------------------------------
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo         Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies - first run only...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check proxy / internet access.
    pause
    exit /b 1
  )
)

echo Building the app...
call npx vite build --logLevel warn
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo.
echo  On-Prem Footprint is running at  http://localhost:%PORT%
echo  Other machines can use           http://%COMPUTERNAME%:%PORT%
echo  Close this window or press Ctrl+C to stop.
echo.
call npx vite preview --host 0.0.0.0 --port %PORT% --strictPort --open
if errorlevel 1 (
  echo [ERROR] Could not start on port %PORT% - it may already be in use.
  echo         Try another port, e.g.  start.bat 9000
  pause
)
endlocal
