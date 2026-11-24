@echo off
setlocal
cd /d "%~dp0"
title WorldGen Portable

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" --version >nul 2>nul
if errorlevel 1 (
  echo WorldGen could not find Node.js.
  echo.
  echo This portable package normally includes its own runtime.
  echo If the runtime folder is missing, install Node.js LTS from https://nodejs.org/
  echo then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" (
    copy ".env.example" ".env" >nul
  )
)

set "PORT_TO_OPEN=3002"
if defined PORT (
  set "PORT_TO_OPEN=%PORT%"
) else (
  for /f "tokens=2 delims==" %%A in ('findstr /b "PORT=" ".env" 2^>nul') do set "PORT_TO_OPEN=%%A"
)
set "PORT=%PORT_TO_OPEN%"

rem If something already listens on the port: reuse it when it is WorldGen, otherwise stop
rem (never kill another program).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port = [int]'%PORT_TO_OPEN%'; " ^
  "if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { exit 0 }; " ^
  "try { $h = Invoke-RestMethod -TimeoutSec 3 ('http://127.0.0.1:' + $port + '/health'); if ($h.status -eq 'ok') { exit 2 } } catch {}; " ^
  "exit 1"
if errorlevel 2 (
  echo WorldGen is already running on port %PORT_TO_OPEN%. Opening it in your browser.
  start "" "http://localhost:%PORT_TO_OPEN%/"
  exit /b 0
)
if errorlevel 1 (
  echo Port %PORT_TO_OPEN% is already used by another program, so WorldGen was not started.
  echo Double click "Edit Settings.bat", change the PORT= line to another number such as 3012,
  echo save the file, then run this file again.
  echo.
  pause
  exit /b 1
)

echo Starting WorldGen Portable...
echo.
echo Your browser should open automatically.
echo Leave this window open while using WorldGen.
echo Close this window when you are finished.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:%PORT_TO_OPEN%/'"
"%NODE_EXE%" dist\index.js

echo.
echo WorldGen has stopped.
pause
