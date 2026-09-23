@echo off
setlocal
set PYTHONUTF8=1
cd /d "%~dp0\.."
if not exist ".venv\Scripts\python.exe" (
    echo Run setup.cmd first.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" -m pip install -r requirements-build.txt
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m unittest discover -s tests -v
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m paperdesk.code_version build\code-version.txt
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean --windowed --onedir --name PaperDesk ^
    --icon "paperdesk\assets\paperdesk.ico" ^
    --version-file "packaging\version-info.txt" ^
    --add-data "paperdesk\assets;paperdesk\assets" ^
    --add-data "build\code-version.txt;." ^
    --collect-all pymupdf --collect-all fontTools --collect-all pypdfium2 --collect-all pypdfium2_raw --copy-metadata pypdfium2 main.py
if errorlevel 1 goto failed
echo.
echo Build complete: dist\PaperDesk\PaperDesk.exe
echo Run PaperDesk.exe once, then use the sidebar button to add it to the Start menu for pinning.
echo Keep the entire dist\PaperDesk folder together. Codex CLI remains a separate dependency.
pause
exit /b 0
:failed
echo Build failed. Copy the error above for troubleshooting.
pause
exit /b 1

