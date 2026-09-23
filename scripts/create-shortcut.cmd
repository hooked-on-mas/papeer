@echo off
setlocal
set PYTHONUTF8=1
cd /d "%~dp0\.."
if not exist ".venv\Scripts\python.exe" (
    echo Run setup.cmd first.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" -c "from paperdesk.winintegration import install_shortcuts; print('\n'.join(str(p) for p in install_shortcuts()))"
if errorlevel 1 (
    echo.
    echo Could not create the shortcuts. Copy the error above for troubleshooting.
    pause
    exit /b 1
)
echo.
echo スタートメニューとデスクトップにPaperDeskを追加しました。
echo スタートメニューのPaperDeskを右クリックすると、スタート・タスクバーにピン留めできます。
pause

