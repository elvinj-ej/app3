@echo off
setlocal
REM ------------------------------------------------------------------
REM  On-Prem Footprint - run from a source checkout (needs internet once
REM  for npm install). For servers without internet, use the release
REM  package instead: "npm run package" -> release\OnPremFootprint-x.y.z.zip
REM  Usage:  start.bat [port]      (default 8080)
REM ------------------------------------------------------------------
cd /d "%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22.13+ is not installed or not on PATH - https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\" (
  echo Installing dependencies - first run only...
  call npm install
  if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
)
echo Building...
call npx vite build --logLevel warn
if errorlevel 1 ( echo [ERROR] Build failed. & pause & exit /b 1 )
call npx vite build -c vite.server.config.ts --logLevel warn
if errorlevel 1 ( echo [ERROR] Server build failed. & pause & exit /b 1 )

start "" /b cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%"
node --disable-warning=ExperimentalWarning build\server\server.mjs --port %PORT%
if errorlevel 1 pause
endlocal
