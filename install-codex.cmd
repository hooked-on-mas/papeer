@echo off
setlocal
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
    echo Install Node.js LTS from https://nodejs.org/ then run this file again.
    echo Alternatively install Codex CLI using the official instructions in README.md.
    pause
    exit /b 1
)
call npm install -g @openai/codex
if errorlevel 1 (
    echo Codex installation failed. Copy the error above for troubleshooting.
    pause
    exit /b 1
)
echo.
echo Codex CLI is installed. Restart PaperDesk and use the ChatGPT login button.
pause
