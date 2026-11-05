@echo off
setlocal EnableDelayedExpansion
REM ------------------------------------------------------------------
REM  OnPrem Transformation Planner - start the server (release package)
REM  Usage:  start.bat            (port 8080)
REM          start.bat 9000       (port 9000)
REM  Data is stored in the "data" folder next to this file.
REM ------------------------------------------------------------------
cd /d "%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo         Install Node.js 22 LTS ^(22.13 or newer^) or 24 LTS from https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=1,2 delims=v." %%a in ('node -v') do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
set "NODE_OK=0"
if !NODE_MAJOR! GTR 22 set "NODE_OK=1"
if !NODE_MAJOR! EQU 22 if !NODE_MINOR! GEQ 13 set "NODE_OK=1"
if "!NODE_OK!"=="0" (
  echo [ERROR] Node.js 22.13 or newer is required ^(found:
  node -v
  echo ^). Install the current LTS from https://nodejs.org
  pause
  exit /b 1
)

start "" /b cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%"
node --disable-warning=ExperimentalWarning server.mjs --port %PORT%
if errorlevel 1 pause
endlocal
