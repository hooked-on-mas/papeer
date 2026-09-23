@echo off
setlocal
set PYTHONUTF8=1
cd /d "%~dp0\.."
if not exist ".venv\Scripts\python.exe" (
    echo Run setup.cmd first.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" main.py
if errorlevel 1 (
    echo.
    echo PaperDesk could not start. Copy the error above for troubleshooting.
    pause
    exit /b 1
)

