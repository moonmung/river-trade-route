@echo off
rem River Trade Route - host server launcher for Windows.
rem Double-click this file on the host PC. It installs packages and builds once, then starts the server.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing packages... ^(first run only^)
  call npm install
  if errorlevel 1 goto failed
)
if not exist dist\server\index.js (
  echo Building the web app... ^(first run only^)
  call npm run build
  if errorlevel 1 goto failed
)
call npm start
pause
exit /b 0

:failed
echo [!] Setup failed. See the messages above.
pause
exit /b 1
