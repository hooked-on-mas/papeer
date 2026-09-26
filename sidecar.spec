# -*- mode: python ; coding: utf-8 -*-


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
    a.binaries,
    a.datas,
    [],
    name='sidecar-x86_64-pc-windows-msvc',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
