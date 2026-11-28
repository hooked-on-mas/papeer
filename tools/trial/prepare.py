#!/usr/bin/env python3
"""Prepare, but do not build or install, a workspace-bound Windows trial overlay."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"
SRC = FRONTEND / "src-tauri"
OUT = ROOT / "output"
OVERLAY = OUT / "shared-trial-overlay"
RUNTIME = OUT / "shared-trial-runtime"
INSTALL = OUT / "shared-trial-install"
IDENTIFIER = "local.paperdesk.shared-trial"
PRODUCT = "Papeer Shared Trial"
BINARY = "papeer-shared-trial"
MARKER = b"papeer-shared-trial-v1\n"


def known_folder(identifier: str) -> Path:
    import ctypes
    import uuid
    guid = (ctypes.c_ubyte * 16).from_buffer_copy(uuid.UUID(identifier).bytes_le)
    value = ctypes.c_void_p()
    shell = ctypes.windll.shell32
    result = shell.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(value))
    if result != 0: raise OSError(f"SHGetKnownFolderPath failed: {result}")
    try: return Path(ctypes.wstring_at(value.value))
    finally: ctypes.windll.ole32.CoTaskMemFree(value)


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""): h.update(block)
    return h.hexdigest()


def tree(path: Path) -> dict:
    files = {}
    for item in sorted(path.rglob("*")):
        info = item.lstat()
        if item.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"source contains reparse point: {item}")
        if item.is_file():
            files[item.relative_to(path).as_posix()] = {"sha256": sha(item), "bytes": info.st_size}
    return files


def check_ancestors(path: Path) -> None:
    if not path.resolve().is_relative_to(ROOT.resolve()): raise ValueError(f"outside workspace: {path}")
    for p in (path, *path.parents):
        if p.exists():
            st = p.lstat()
            if p.is_symlink() or getattr(st, "st_file_attributes", 0) & 0x400:
                raise ValueError(f"reparse ancestor: {p}")
        if p == ROOT: break


def render_hook(install: Path) -> str:
    """Render the reviewed fresh-install-only NSIS hook for this workspace."""
    inst = str(install)
    if any(c in inst for c in '$"\r\n'):
        raise ValueError("unsupported install path")
    return f'''!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  Push $R2
  StrCmp $INSTDIR "{inst}" trial_path_ok
  MessageBox MB_OK|MB_ICONSTOP "Trial install destination mismatch." /SD IDOK
  Abort
trial_path_ok:
  nsis_tauri_utils::FindProcessCurrentUser "${{MAINBINARYNAME}}.exe"
  Pop $R0
  ${{If}} $R0 == 0
    MessageBox MB_OK|MB_ICONSTOP "Trial is running. Close it and retry." /SD IDOK
    Abort
  ${{EndIf}}
  ClearErrors
  FindFirst $R1 $R2 "$INSTDIR\\*"
  IfErrors trial_scan_error
trial_check_entry:
  StrCmp $R2 "." trial_next_entry
  StrCmp $R2 ".." trial_next_entry
  FindClose $R1
  MessageBox MB_OK|MB_ICONSTOP "Trial install destination must be empty." /SD IDOK
  Abort
trial_next_entry:
  ClearErrors
  FindNext $R1 $R2
  IfErrors trial_scan_done
  Goto trial_check_entry
trial_scan_done:
  FindClose $R1
  Pop $R2
  Pop $R1
  Pop $R0
  Goto trial_hook_done
trial_scan_error:
  MessageBox MB_OK|MB_ICONSTOP "Cannot inspect trial install destination." /SD IDOK
  Abort
trial_hook_done:
!macroend
'''


def main() -> int:
    if sys.platform != "win32": raise ValueError("trial overlay is Windows-only")
    for p in (OUT, OVERLAY, RUNTIME, INSTALL, SRC / "target", SRC / "sidecar", FRONTEND / "dist"):
        check_ancestors(p)
    if any(p.exists() for p in (OVERLAY, RUNTIME, INSTALL)):
        raise ValueError("trial overlay, runtime, or install destination already exists; refusing reuse")
    # The previous proof records the frozen root build and the smoke-tested sidecar placement.
    cp = ROOT / "checkpoints/shared-app/2026-10-29-p0"
    proof = json.loads((cp / "p1-b1-nsis-r1.json").read_text(encoding="utf8"))
    if proof.get("status") != "passed": raise ValueError("root build proof not passed")
    version = (ROOT / "sidecar-sources.txt").read_text(encoding="utf8").strip()
    if version != proof["sourceBundleVersion"]: raise ValueError("sidecar source version drift")
    sys.path.insert(0, str(ROOT))
    from papeer.core.code_version import bundle_version
    if bundle_version(ROOT) != version: raise ValueError("current backend source bundle drift")
    frontend_files = []
    for rel in ("frontend/src", "frontend/public", "frontend/web", "frontend/src-tauri/src"):
        p = ROOT / rel
        if p.exists(): frontend_files.extend(x for x in p.rglob("*") if x.is_file())
    for rel in ("frontend/index.html", "frontend/package.json", "frontend/pnpm-lock.yaml", "frontend/vite.config.ts", "frontend/vite.web.config.ts", "frontend/webPwa.ts", "frontend/buildLicenses.ts", "frontend/src-tauri/Cargo.toml", "frontend/src-tauri/Cargo.lock", "frontend/src-tauri/tauri.conf.json", "sidecar.spec"):
        p = ROOT / rel
        if p.is_file(): frontend_files.append(p)
    digest = hashlib.sha256()
    for p in sorted(frontend_files, key=lambda x: x.as_posix()):
        digest.update((p.relative_to(ROOT).as_posix() + "\0" + sha(p) + "\0" + str(p.stat().st_size) + "\n").encode())
    if digest.hexdigest() != proof["frontendSourceAfter"]["sha256"]: raise ValueError("frontend source drift")
    placed = tree(SRC / "sidecar")
    if placed != tree(ROOT / "dist/sidecar"): raise ValueError("sidecar differs from smoke-tested dist")
    sidehash = hashlib.sha256(json.dumps(placed, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if sidehash != proof["sidecar"]["treeSha256"]: raise ValueError("sidecar differs from prior proof")
    source_inputs = {"nativeRust": tree(SRC / "src"), "desktopDist": tree(FRONTEND / "dist"),
                     "sidecar": placed, "webDist": tree(FRONTEND / "web-dist"),
                     "trialFiles": tree(ROOT / "tools/trial")}
    for path in (SRC / "Cargo.toml", SRC / "Cargo.lock", SRC / "build.rs", SRC / "tauri.conf.json"):
        source_inputs[path.relative_to(ROOT).as_posix()] = {"sha256": sha(path), "bytes": path.stat().st_size}
    local_known = known_folder("f1b32785-6fba-4fcf-9d55-7b8e7f157091")
    roaming_known = known_folder("3eb685db-65f9-4cf6-a03a-e3ef65729f3d")
    if (local_known / IDENTIFIER).exists() or (roaming_known / IDENTIFIER).exists(): raise ValueError("trial known-folder profile already exists; refuse reuse")
    OUT.mkdir(exist_ok=True)
    OVERLAY.mkdir(); RUNTIME.mkdir()
    for rel in ("library", "localappdata/PapeerSync", "appdata", "temp", "ai", "xdg"):
        (RUNTIME / rel).mkdir(parents=True)
    (RUNTIME / ".papeer-shared-trial").write_bytes(MARKER)
    front = OVERLAY / "frontend"; native = front / "src-tauri"; native.mkdir(parents=True)
    for name in ("Cargo.lock", "build.rs"):
        shutil.copy2(SRC / name, native / name)
    for name in ("icons", "capabilities"):
        shutil.copytree(SRC / name, native / name)
    shutil.copy2(FRONTEND / "package.json", front / "package.json")
    cargo = (SRC / "Cargo.toml").read_text(encoding="utf8")
    cargo = cargo.replace('license-file = "../../LICENSE"', 'license-file = ' + json.dumps(str(ROOT / "LICENSE")))
    cargo = cargo.replace('[lib]\n', '[lib]\npath = ' + json.dumps(str(SRC / "src/lib.rs")) + '\n', 1)
    cargo += '\n[[bin]]\nname = "papeer"\npath = ' + json.dumps(str(ROOT / "tools/trial/trial-main.rs")) + '\n'
    (native / "Cargo.toml").write_text(cargo, encoding="utf8", newline="\n")
    config = json.loads((SRC / "tauri.conf.json").read_text(encoding="utf8"))
    config.update(identifier=IDENTIFIER, productName=PRODUCT, mainBinaryName=BINARY)
    for window in config["app"]["windows"]: window["title"] = PRODUCT
    config["build"]["frontendDist"] = os.path.relpath(FRONTEND / "dist", native).replace("\\", "/")
    config["build"]["beforeBuildCommand"] = ""
    config["bundle"]["resources"] = {SRC.joinpath("sidecar").as_posix() + "/": "sidecar/"}
    config["bundle"]["windows"]["nsis"]["installerHooks"] = "windows/hooks.nsh"
    (native / "tauri.conf.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    (native / "windows").mkdir()
    (native / "windows/hooks.nsh").write_text(render_hook(INSTALL), encoding="utf8")
    manifest = {"version":1, "kind":"papeer-shared-trial-installed", "status":"prepared-not-built", "scope":"local workspace-bound trial only; not distributable",
      "identifier":IDENTIFIER, "productName":PRODUCT, "mainBinaryName":BINARY,
      "root":str(ROOT), "overlay":str(OVERLAY), "runtimeRoot":str(RUNTIME), "library":str(RUNTIME / "library"),
      "device":str(RUNTIME / "localappdata/PapeerSync"), "appdataEnvironment":str(RUNTIME / "appdata"),
      "installRoot":str(INSTALL), "appExe":str(INSTALL / (BINARY + ".exe")),
      "packagedSidecar":str(INSTALL / "sidecar/papeer-sidecar.exe"),
      "webviewProfileExpectation":str(local_known / IDENTIFIER),
      "windowStateExpectation":str(roaming_known / IDENTIFIER),
      "sourceBundleVersion":version, "sidecarTreeSha256":sidehash, "sidecarLauncherSha256":placed["papeer-sidecar.exe"]["sha256"],
      "prerequisiteProof":str(cp / "p1-b1-nsis-r1.json"), "sourceInputs":source_inputs,
      "cargoTargetDir":str(SRC / "target"), "buildCwd":str(front), "buildArgv":["node", str(FRONTEND / "node_modules/@tauri-apps/cli/tauri.js"), "build", "--bundles", "nsis", "--ci", "--", "--offline", "--target-dir", str(SRC / "target")], "cargoCheckArgv":["cargo", "check", "--release", "--locked", "--offline", "--manifest-path", str(native / "Cargo.toml"), "--target-dir", str(SRC / "target"), "--bin", "papeer"],
      "requiredBuildEnvironment":{"PAPEER_SHARED_TRIAL_ROOT":str(RUNTIME), "CARGO_NET_OFFLINE":"true", "CARGO_TARGET_DIR":str(SRC / "target"), "TAURI_CONFIG":"unset"},
      "installConditions":"Fresh install only, explicit exact workspace install path, independent registry/process/destination review before running installer.",
      "sharedTargetNote":"Trial build may overwrite generated release executables in the shared root target; existing normal installer must be preserved separately. Debug binary is not the build target.", "runtime":{"root":str(RUNTIME), "markerPath":str(RUNTIME / ".papeer-shared-trial"), "markerSha256":hashlib.sha256(MARKER).hexdigest(), "library":str(RUNTIME / "library"), "device":str(RUNTIME / "localappdata/PapeerSync"), "webview":str(local_known / IDENTIFIER), "windowState":str(roaming_known / IDENTIFIER)}, "executable":{"path":str(INSTALL / (BINARY + ".exe")), "sha256":None}, "sidecar":{"path":str(INSTALL / "sidecar/papeer-sidecar.exe"), "sha256":placed["papeer-sidecar.exe"]["sha256"]}, "installed":False,"guiLaunched":False}
    manifest["overlayInputs"] = {rel: {"sha256": sha(native / rel), "bytes": (native / rel).stat().st_size}
                                 for rel in ("Cargo.toml", "Cargo.lock", "build.rs", "tauri.conf.json", "windows/hooks.nsh")}
    manifest["overlayTrees"] = {name: tree(native / name) for name in ("icons", "capabilities")}
    manifest["overlayFrontendPackageSha256"] = sha(front / "package.json")
    (OVERLAY / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"status":manifest["status"], "manifest":str(OVERLAY / "manifest.json"), "cargoCheckArgv":manifest["cargoCheckArgv"]}, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError) as error:
        print(f"trial preparation refused: {error}", file=sys.stderr)
        raise SystemExit(1) from None







