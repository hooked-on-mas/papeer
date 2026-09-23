@echo off
setlocal
set PYTHONUTF8=1
cd /d "%~dp0\.."
echo PaperDesk - first-time setup
where py >nul 2>nul
if not errorlevel 1 (
    py -3.12 -c "import sys; assert sys.version_info >= (3, 11)" >nul 2>nul
    if not errorlevel 1 (
        py -3.12 -m venv .venv
        goto install
    )
    py -3 -c "import sys; assert sys.version_info >= (3, 11)" >nul 2>nul
    if not errorlevel 1 (
        py -3 -m venv .venv
        goto install
    )
)
python -c "import sys; assert sys.version_info >= (3, 11)" >nul 2>nul
if errorlevel 1 goto missing_python
python -m venv .venv

:install
if not exist ".venv\Scripts\python.exe" goto failed
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r requirements-windows-lock.txt
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -c "from PySide6.QtWidgets import QApplication; import pymupdf; print('Dependencies OK')"
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -c "from paperdesk.winintegration import install_shortcuts; install_shortcuts()"
if errorlevel 1 echo Note: could not create the Start menu shortcut. Run create-shortcut.cmd later.
echo.
echo Setup complete. Double-click start.cmd to launch PaperDesk.
echo PaperDesk is also in the Start menu; right-click it to pin it to Start or the taskbar.
echo For ChatGPT: install Codex CLI, then use the login button in the app.
pause
exit /b 0

:missing_python
echo.
echo Install Python 3.12 64-bit from https://www.python.org/downloads/windows/
echo Enable the Python launcher or Add python.exe to PATH during installation.
echo Then run setup.cmd again.
pause
exit /b 1

:failed
echo.
echo Setup failed. Copy the error above for troubleshooting.
pause
exit /b 1

