#!/usr/bin/env python3
"""Preflight or build the reviewed workspace-bound trial; never install or launch it."""
from __future__ import annotations
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True
import prepare as p

CHECKPOINT_BASE = p.ROOT / "checkpoints/shared-app/2026-10-29-b1-trial"
CP = CHECKPOINT_BASE / "build-r1"
MANIFEST = p.OVERLAY / "manifest.json"
NATIVE = p.OVERLAY / "frontend/src-tauri"
TRIAL_SETUP = p.SRC / "target/release/bundle/nsis/Papeer Shared Trial_0.2.0_x64-setup.exe"
NSIS_SOURCE = p.SRC / "target/release/nsis/x64/installer.nsi"


def treehash(files: dict) -> str:
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def meta(path: Path) -> dict:
    if not path.is_file(): return {"path": str(path), "exists": False}
    return {"path": str(path), "exists": True, "sha256": p.sha(path), "bytes": path.stat().st_size, "mtimeNs": path.stat().st_mtime_ns}


def frontend_digest() -> str:
    paths = []
    for rel in ("frontend/src", "frontend/public", "frontend/web", "frontend/src-tauri/src"):
        directory = p.ROOT / rel
        if directory.exists(): paths.extend(x for x in directory.rglob("*") if x.is_file())
    for rel in ("frontend/index.html", "frontend/package.json", "frontend/pnpm-lock.yaml", "frontend/vite.config.ts", "frontend/vite.web.config.ts", "frontend/webPwa.ts", "frontend/buildLicenses.ts", "frontend/src-tauri/Cargo.toml", "frontend/src-tauri/Cargo.lock", "frontend/src-tauri/tauri.conf.json", "sidecar.spec"):
        path = p.ROOT / rel
        if path.is_file(): paths.append(path)
    h = hashlib.sha256()
    for path in sorted(paths, key=lambda x: x.as_posix()):
        h.update((path.relative_to(p.ROOT).as_posix() + "\0" + p.sha(path) + "\0" + str(path.stat().st_size) + "\n").encode())
    return h.hexdigest()


def preflight() -> dict:
    if sys.platform != "win32": raise ValueError("Windows only")
    m = json.loads(MANIFEST.read_text(encoding="utf8"))
    if m.get("status") != "prepared-not-built" or m.get("installed") is not False: raise ValueError("manifest is not fresh")
    if m.get("identifier") != p.IDENTIFIER or m.get("productName") != p.PRODUCT or m.get("mainBinaryName") != p.BINARY: raise ValueError("trial identity mismatch")
    for path in (p.OVERLAY, p.RUNTIME, p.INSTALL, p.SRC / "target", p.SRC / "target/release/bundle/nsis", CP): p.check_ancestors(path)
    if p.INSTALL.exists(): raise ValueError("trial install destination already exists")
    runtime = m["runtime"]
    if runtime["root"] != str(p.RUNTIME) or Path(runtime["markerPath"]).read_bytes() != p.MARKER: raise ValueError("trial root/marker mismatch")
    if hashlib.sha256(p.MARKER).hexdigest() != runtime["markerSha256"]: raise ValueError("marker hash mismatch")
    expected_dirs = {"library", "localappdata", "localappdata/PapeerSync", "appdata", "temp", "ai", "xdg"}
    actual = set()
    for item in p.RUNTIME.rglob("*"):
        st = item.lstat()
        if item.is_symlink() or getattr(st, "st_file_attributes", 0) & 0x400: raise ValueError("runtime reparse point")
        rel = item.relative_to(p.RUNTIME).as_posix()
        if rel == ".papeer-shared-trial" and item.is_file(): continue
        if not item.is_dir(): raise ValueError("trial runtime is not fresh")
        actual.add(rel)
    if actual != expected_dirs: raise ValueError("trial runtime directories do not match")
    for key in ("webview", "windowState"):
        if Path(runtime[key]).exists(): raise ValueError(f"trial known-folder {key} already exists")
    source = m["sourceInputs"]
    for name, path in (("nativeRust", p.SRC / "src"), ("desktopDist", p.FRONTEND / "dist"), ("webDist", p.FRONTEND / "web-dist"), ("sidecar", p.SRC / "sidecar"), ("trialFiles", p.ROOT / "tools/trial")):
        if p.tree(path) != source[name]: raise ValueError(f"{name} drift")
    if p.tree(p.ROOT / "dist/sidecar") != source["sidecar"]: raise ValueError("smoke-tested sidecar drift")
    for rel, record in source.items():
        if rel.startswith("frontend/") and p.sha(p.ROOT / rel) != record["sha256"]: raise ValueError(f"root source drift: {rel}")
    for rel, record in m["overlayInputs"].items():
        if p.sha(NATIVE / rel) != record["sha256"]: raise ValueError(f"overlay input drift: {rel}")
    for name in ("icons", "capabilities"):
        if p.tree(NATIVE / name) != m["overlayTrees"][name] or p.tree(NATIVE / name) != p.tree(p.SRC / name): raise ValueError(f"overlay {name} drift")
    if p.sha(p.OVERLAY / "frontend/package.json") != m["overlayFrontendPackageSha256"] or p.sha(p.OVERLAY / "frontend/package.json") != p.sha(p.FRONTEND / "package.json"): raise ValueError("overlay package drift")
    sys.path.insert(0, str(p.ROOT))
    from papeer.core.code_version import bundle_version
    if bundle_version(p.ROOT) != m["sourceBundleVersion"]: raise ValueError("backend bundle version drift")
    proof = json.loads((p.ROOT / "checkpoints/shared-app/2026-10-29-p0/p1-b1-nsis-r1.json").read_text(encoding="utf8"))
    if frontend_digest() != proof["frontendSourceAfter"]["sha256"]: raise ValueError("frontend source drift from B1 proof")
    original = p.ROOT / proof["artifact"]["path"]
    normal = meta(original)
    if not normal["exists"] or normal["sha256"] != proof["artifact"]["sha256"]: raise ValueError("normal B1 installer changed or missing")
    expected_args = ["node", str(p.FRONTEND / "node_modules/@tauri-apps/cli/tauri.js"), "build", "--bundles", "nsis", "--ci", "--", "--offline", "--target-dir", str(p.SRC / "target")]
    if m["buildArgv"] != expected_args or m["buildCwd"] != str(p.OVERLAY / "frontend"): raise ValueError("unexpected build command")
    if m["requiredBuildEnvironment"]["PAPEER_SHARED_TRIAL_ROOT"] != str(p.RUNTIME): raise ValueError("unexpected compiled trial root")
    cli = Path(expected_args[1]); node = shutil.which("node")
    if not node or not cli.is_file(): raise ValueError("local Node/Tauri CLI missing")
    return {"manifestSha256": p.sha(MANIFEST), "sourceBundleVersion": m["sourceBundleVersion"], "frontendSourceSha256": proof["frontendSourceAfter"]["sha256"],
        "trialSourceTreeSha256": treehash(source["trialFiles"]), "sidecarTreeSha256": treehash(source["sidecar"]),
        "overlayInputs": m["overlayInputs"], "normalInstallerBefore":normal, "trialInstallerBefore":meta(TRIAL_SETUP), "nsisSourceBefore":meta(NSIS_SOURCE),
        "localTauriCliSha256":p.sha(cli), "node":node, "argv":[node,*expected_args[1:]], "cwd":m["buildCwd"]}


def build(info: dict) -> int:
    if CP.exists(): raise ValueError("checkpoint already exists; refusing overwrite")
    CP.mkdir(parents=True)
    temp = CP / "build-temp"
    temp.mkdir()
    env = os.environ.copy()
    for name in ("TAURI_CONFIG", "PAPEER_GOOGLE_OAUTH_CONFIG_FILE", "PAPEER_GOOGLE_DESKTOP_CLIENT_ID", "PAPEER_GOOGLE_DESKTOP_CLIENT_SECRET"):
        env.pop(name, None)
    env.update({"PAPEER_SHARED_TRIAL_ROOT":str(p.RUNTIME), "CARGO_TARGET_DIR":str(p.SRC / "target"), "CARGO_NET_OFFLINE":"true", "PIP_NO_INDEX":"1", "npm_config_offline":"true", "CI":"true", "TEMP":str(temp), "TMP":str(temp), "TMPDIR":str(temp)})
    log = CP / "build.log"; result_path = CP / "result.json"
    record = {"status":"running", "preflight":info, "startedUtc":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "environment":{"PAPEER_SHARED_TRIAL_ROOT":str(p.RUNTIME),"CARGO_TARGET_DIR":str(p.SRC / "target"),"CARGO_NET_OFFLINE":"true","PIP_NO_INDEX":"1","npm_config_offline":"true","CI":"true","TEMP/TMP/TMPDIR":str(temp),"TAURI_CONFIG":"removed","three private OAuth overrides":"removed"},
        "timeoutSeconds":900, "installed":False, "guiLaunched":False, "log":"build.log"}
    result_path.write_text(json.dumps(record,indent=2,ensure_ascii=False)+"\n",encoding="utf8")
    start = time.monotonic()
    with log.open("xb") as output:
        try: proc = subprocess.Popen(info["argv"], cwd=info["cwd"], env=env, stdout=output, stderr=subprocess.STDOUT)
        except OSError as error:
            record.update(status="launch-failed", launchError=str(error))
            result_path.write_text(json.dumps(record,indent=2,ensure_ascii=False)+"\n",encoding="utf8")
            raise
        record["ownedPid"] = proc.pid
        result_path.write_text(json.dumps(record,indent=2,ensure_ascii=False)+"\n",encoding="utf8")
        try: code=proc.wait(timeout=900); timeout=False
        except subprocess.TimeoutExpired:
            timeout=True
            subprocess.run(["taskkill","/PID",str(proc.pid),"/T","/F"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20,check=False)
            try: proc.wait(timeout=20)
            except subprocess.TimeoutExpired: proc.kill();proc.wait()
            code=124
    record.update(exitCode=code, timedOut=timeout, elapsedSeconds=round(time.monotonic()-start,3),
        finishedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(), logSha256=p.sha(log),
        trialInstallerAfter=meta(TRIAL_SETUP), normalInstallerAfter=meta(Path(info["normalInstallerBefore"]["path"])))
    # Save generated source even on failure, but never claim it or an old artifact as successful output.
    if NSIS_SOURCE.is_file():
        shutil.copy2(NSIS_SOURCE, CP / "installer.nsi")
        record["generatedNsis"] = meta(CP / "installer.nsi")
        record["nsisSourceAfter"] = meta(NSIS_SOURCE)
    shutil.copy2(NATIVE / "windows/hooks.nsh", CP / "trial-hooks.nsh")
    record["hookSha256"] = p.sha(CP / "trial-hooks.nsh")
    after_ok = False
    try:
        after = preflight()
        after_ok = all(after[k] == info[k] for k in ("manifestSha256","sourceBundleVersion","frontendSourceSha256","trialSourceTreeSha256","sidecarTreeSha256","overlayInputs","normalInstallerBefore"))
        record["postBuildInputsMatch"] = after_ok
    except (OSError, ValueError, KeyError) as error:
        record["postBuildInputsMatch"] = False; record["postBuildCheckError"] = str(error)
    artifact = record["trialInstallerAfter"]
    fresh = artifact["exists"] and artifact["mtimeNs"] != info["trialInstallerBefore"].get("mtimeNs")
    record["status"] = "passed-pending-independent-nsis-review" if code == 0 and fresh and after_ok and NSIS_SOURCE.is_file() and record["nsisSourceAfter"]["mtimeNs"] != info["nsisSourceBefore"].get("mtimeNs") else "failed-or-unverified"
    result_path.write_text(json.dumps(record,indent=2,ensure_ascii=False)+"\n",encoding="utf8")
    print(json.dumps({"status":record["status"],"exitCode":code,"artifact":artifact,"checkpoint":str(CP)},ensure_ascii=False))
    return 0 if record["status"] == "passed-pending-independent-nsis-review" else 1


def next_stage(base: Path) -> str:
    for number in range(1, 10000):
        name = f"build-r{number}"
        if not (base / name).exists():
            return name
    raise ValueError("no available write-once build checkpoint")


def main() -> int:
    global CP
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("check", "build"))
    parser.add_argument("--stage", help="new checkpoint name, for example build-r3")
    args = parser.parse_args()
    stage = args.stage or next_stage(CHECKPOINT_BASE)
    if not re.fullmatch(r"build-r[1-9][0-9]*", stage):
        raise ValueError("invalid build checkpoint name")
    CP = CHECKPOINT_BASE / stage
    if CP.exists():
        raise ValueError("checkpoint already exists; refusing overwrite")
    info = preflight()
    if args.mode == "check": print(json.dumps({"status":"preflight-passed","checkpoint":str(CP),"preflight":info},indent=2,ensure_ascii=False)); return 0
    return build(info)

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError) as error:
        print(f"trial build refused: {error}", file=sys.stderr)
        raise SystemExit(1) from None




