# -*- mode: python ; coding: utf-8 -*-
# The sidecar as a PyInstaller onedir bundle (`just build-sidecar`): dist/sidecar/ holds the launcher
# papeer-sidecar(.exe) and _internal/ (Python, the libraries and the datas below; sys._MEIPASS in the app).
# Nothing is unpacked at launch: a onefile exe unpacked ~90 MB into %TEMP%\_MEI* each time (slow, scanned
# by antivirus each time, left behind when killed). Tauri bundles the whole folder as a resource and starts
# the launcher from it (frontend/src-tauri/src/sidecar.rs); the names are also in papeer/core/code_version.py
# (SIDECAR_DIR, SIDECAR_EXE, CLI_EXE) and tools/smoke_sidecar.py.
#
# The command line client papeer-cli(.exe) (papeer/cli, `papeer-cli setup-path`) is a second launcher in the same
# folder and shares _internal with the sidecar. It is standard library only (and a few papeer.core modules): it
# takes the heavy packages below out so that nothing of them is pulled in by a hook, and it carries none of the
# sidecar's data (prompts, fonts). It must never be called papeer.exe, which is Tauri's main binary.

# What the command line must never import: the web stack, PDF and imaging libraries, and the sidecar itself.
# (tests/test_cli.py checks that importing papeer.cli loads none of them.)
CLI_EXCLUDES = [
    'sidecar', 'fastapi', 'starlette', 'uvicorn', 'pydantic', 'pydantic_core', 'anyio', 'httpx', 'h11',
    'websockets', 'fitz', 'pymupdf', 'pypdfium2', 'PIL', 'fontTools', 'numpy', 'winrt',
]

# Developer-owned OAuth configuration stays out of the public source tree. Desktop public clients
# cannot keep this value confidential after distribution; user tokens are never bundled here.
from pathlib import Path
oauth_bundle = Path('build/google-desktop-oauth.json')
oauth_datas = [(str(oauth_bundle), '.')] if oauth_bundle.is_file() else []


a = Analysis(
    ['sidecar/__main__.py'],
    pathex=[],
    binaries=[],
    datas=[('papeer/core/prompts/*', 'papeer/core/prompts'), ('papeer/core/assets/fonts/*', 'papeer/core/assets/fonts'), ('papeer/core/assets/*', 'papeer/core/assets'), ('code-version.txt', '.'), *oauth_datas],
    hiddenimports=['papeer'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

cli = Analysis(
    ['papeer/cli/__main__.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=CLI_EXCLUDES,
    noarchive=False,
    optimize=0,
)
cli_pyz = PYZ(cli.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='papeer-sidecar',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX-packed DLLs are slower to start and trip antivirus heuristics.
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

cli_exe = EXE(
    cli_pyz,
    cli.scripts,
    [],
    exclude_binaries=True,
    name='papeer-cli',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    cli_exe,
    a.binaries,
    a.datas,
    cli.binaries,
    cli.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='sidecar',
)
