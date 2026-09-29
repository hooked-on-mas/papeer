# -*- mode: python ; coding: utf-8 -*-
# The sidecar as a PyInstaller onedir bundle (`just build-sidecar`): dist/sidecar/ holds the launcher
# papeer-sidecar(.exe) and _internal/ (Python, the libraries and the datas below; sys._MEIPASS in the app).
# Nothing is unpacked at launch: a onefile exe unpacked ~90 MB into %TEMP%\_MEI* each time (slow, scanned
# by antivirus each time, left behind when killed). Tauri bundles the whole folder as a resource and starts
# the launcher from it (frontend/src-tauri/src/sidecar.rs); the names are also in papeer/core/code_version.py
# (SIDECAR_DIR, SIDECAR_EXE) and tools/smoke_sidecar.py.


a = Analysis(
    ['sidecar/__main__.py'],
    pathex=[],
    binaries=[],
    datas=[('papeer/core/prompts/*', 'papeer/core/prompts'), ('papeer/core/assets/fonts/*', 'papeer/core/assets/fonts'), ('papeer/core/assets/*', 'papeer/core/assets'), ('code-version.txt', '.')],
    hiddenimports=['papeer'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

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

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='sidecar',
)
