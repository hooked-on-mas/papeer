"""tools/place_sidecar.py: the onedir sidecar is swapped into place whole, or not at all."""
import json

import pytest

from papeer.core.code_version import SIDECAR_DIR, SIDECAR_EXE
from tools import place_sidecar
from tools.place_sidecar import ROOT, place


def _bundle(folder, launcher="papeer-sidecar.exe", marker="new"):
    (folder / "_internal").mkdir(parents=True)
    (folder / launcher).write_text(marker)
    (folder / "_internal" / "code-version.txt").write_text(marker)
    return folder


def test_names_match_the_bundle_and_the_tauri_resource():
    # The same names in sidecar.spec (COLLECT, EXE), tauri.conf.json (bundle.resources) and sidecar.rs.
    spec = (ROOT / "sidecar.spec").read_text("utf-8")
    assert f"name='{SIDECAR_DIR.name}'" in spec and f"name='{SIDECAR_EXE.stem}'" in spec
    assert place_sidecar.SOURCE == ROOT / "dist" / SIDECAR_DIR.name
    config = json.loads((ROOT / "frontend" / "src-tauri" / "tauri.conf.json").read_text("utf-8"))
    assert config["bundle"]["resources"] == {f"{SIDECAR_DIR.name}/": f"{SIDECAR_DIR.name}/"}
    assert SIDECAR_DIR.parent.as_posix() == "frontend/src-tauri"
    # The NSIS installer removes the sidecar of the version it replaces before copying the new one.
    hooks = ROOT / "frontend" / "src-tauri" / config["bundle"]["windows"]["nsis"]["installerHooks"]
    preinstall = hooks.read_text("utf-8").split("!macro NSIS_HOOK_PREINSTALL")[1].split("!macroend")[0]
    assert f'RMDir /r "$INSTDIR\\{SIDECAR_DIR.name}"' in preinstall
    assert 'Delete "$INSTDIR\\sidecar.exe"' in preinstall
    # The hook runs before the template checks that the app is closed: nothing is removed while it runs.
    rmdir = preinstall.index("RMDir")
    assert preinstall.index('"${MAINBINARYNAME}.exe"') < rmdir
    assert preinstall.index(f'"{SIDECAR_EXE.stem}.exe"') < rmdir
    rust = (ROOT / "frontend" / "src-tauri" / "src" / "sidecar.rs").read_text("utf-8")
    assert f'const SIDECAR_DIR: &str = "{SIDECAR_DIR.name}";' in rust
    assert f'const SIDECAR_EXE: &str = "{SIDECAR_EXE.stem}";' in rust


def test_the_mac_and_linux_bundles():
    # tauri.<platform>.conf.json is merged over tauri.conf.json when building on that platform.
    tauri = ROOT / "frontend" / "src-tauri"
    macos = json.loads((tauri / "tauri.macos.conf.json").read_text("utf-8"))["bundle"]
    # No Developer ID: an ad-hoc signature (Apple Silicon runs no unsigned code); macOS 13 and later.
    assert macos["targets"] == ["app", "dmg"]
    assert macos["macOS"] == {"signingIdentity": "-", "minimumSystemVersion": "13.0"}
    linux = json.loads((tauri / "tauri.linux.conf.json").read_text("utf-8"))["bundle"]
    assert linux["targets"] == ["deb"]
    # The tray's library is only recommended: the app runs on without a tray when it is missing (lib.rs).
    assert "libayatana-appindicator3-1" in linux["linux"]["deb"]["recommends"]
    assert "libayatana-appindicator3.so.1" in (tauri / "src" / "lib.rs").read_text("utf-8")


def test_replaces_the_whole_folder(tmp_path):
    source = _bundle(tmp_path / "dist" / "sidecar")
    target = tmp_path / "src-tauri" / "sidecar"
    _bundle(target, marker="old")
    (target / "_internal" / "gone.pyd").write_text("from the previous build")
    place(source, target, "papeer-sidecar.exe")
    assert (target / "papeer-sidecar.exe").read_text() == "new"
    assert (target / "_internal" / "code-version.txt").read_text() == "new"
    assert not (target / "_internal" / "gone.pyd").exists()
    assert sorted(p.name for p in target.parent.iterdir()) == ["sidecar"]


def test_leftovers_of_an_interrupted_run_are_cleared(tmp_path):
    source = _bundle(tmp_path / "dist" / "sidecar")
    target = tmp_path / "src-tauri" / "sidecar"
    _bundle(tmp_path / "src-tauri" / "sidecar.new", marker="half")
    place(source, target, "papeer-sidecar.exe")
    assert (target / "papeer-sidecar.exe").read_text() == "new"
    assert sorted(p.name for p in target.parent.iterdir()) == ["sidecar"]


def test_a_folder_without_the_launcher_is_not_placed(tmp_path):
    source = tmp_path / "dist" / "sidecar"
    source.mkdir(parents=True)
    target = _bundle(tmp_path / "src-tauri" / "sidecar", marker="old")
    with pytest.raises(FileNotFoundError, match="sidecar.spec"):
        place(source, target, "papeer-sidecar.exe")
    assert (target / "papeer-sidecar.exe").read_text() == "old"


def _flaky_replace(monkeypatch, fails):
    """os.replace that fails `fails(source)` times for each source before it works; the calls it saw."""
    real = place_sidecar.os.replace
    calls = []

    def replace(source, target):
        calls.append((source.name, target.name))
        if sum(1 for name, _ in calls if name == source.name) <= fails(source):
            raise PermissionError("in use")
        real(source, target)

    monkeypatch.setattr(place_sidecar.os, "replace", replace)
    monkeypatch.setattr(place_sidecar.time, "sleep", lambda seconds: None)
    return calls


def test_a_rename_is_retried(tmp_path, monkeypatch):
    source = _bundle(tmp_path / "dist" / "sidecar")
    target = _bundle(tmp_path / "src-tauri" / "sidecar", marker="old")
    calls = _flaky_replace(monkeypatch, lambda path: 2)
    place(source, target, "papeer-sidecar.exe")
    assert (target / "papeer-sidecar.exe").read_text() == "new"
    assert calls == [("sidecar", "sidecar.old")] * 3 + [("sidecar.new", "sidecar")] * 3
    assert sorted(p.name for p in target.parent.iterdir()) == ["sidecar"]


def test_the_previous_folder_is_put_back_when_the_new_one_cannot_be_moved_in(tmp_path, monkeypatch):
    source = _bundle(tmp_path / "dist" / "sidecar")
    target = _bundle(tmp_path / "src-tauri" / "sidecar", marker="old")
    calls = _flaky_replace(monkeypatch, lambda path: 99 if path.name == "sidecar.new" else 0)
    with pytest.raises(PermissionError):
        place(source, target, "papeer-sidecar.exe")
    assert calls.count(("sidecar.new", "sidecar")) == place_sidecar.RENAME_ATTEMPTS
    assert calls[-1] == ("sidecar.old", "sidecar")
    assert (target / "papeer-sidecar.exe").read_text() == "old"
    assert not (tmp_path / "src-tauri" / "sidecar.old").exists()


def test_a_failed_copy_leaves_the_previous_folder(tmp_path, monkeypatch):
    source = _bundle(tmp_path / "dist" / "sidecar")
    target = _bundle(tmp_path / "src-tauri" / "sidecar", marker="old")

    def interrupted(src, dst):
        dst.mkdir()
        raise OSError("disk full")

    monkeypatch.setattr(place_sidecar.shutil, "copytree", interrupted)
    with pytest.raises(OSError, match="disk full"):
        place(source, target, "papeer-sidecar.exe")
    assert (target / "papeer-sidecar.exe").read_text() == "old"
