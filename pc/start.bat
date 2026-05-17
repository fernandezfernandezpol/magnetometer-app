@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)
if not exist node_modules (
    echo Installing dependencies...
    npm install
)
echo.
node server.js
pause
