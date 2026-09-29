"""tools/sign_sidecar.py: which files of the onedir sidecar are signed ad hoc on macOS, and how."""
from __future__ import annotations

import sys

import pytest

from tools import sign_sidecar

MACHO_64 = bytes.fromhex("cffaedfe") + b"\0" * 28
FAT = bytes.fromhex("cafebabe") + b"\0" * 28


def _sidecar(folder):
    (folder / "_internal" / "PIL" / ".dylibs").mkdir(parents=True)
    (folder / "papeer-sidecar").write_bytes(MACHO_64)
    (folder / "_internal" / "libpython3.12.dylib").write_bytes(FAT)
    (folder / "_internal" / "PIL" / ".dylibs" / "libjpeg.62.dylib").write_bytes(MACHO_64)
    (folder / "_internal" / "fitz.cpython-312-darwin.so").write_bytes(MACHO_64)
    (folder / "_internal" / "code-version.txt").write_text("code-sha256-0\n")
    (folder / "_internal" / "base_library.zip").write_bytes(b"PK\3\4" + b"\0" * 28)
    (folder / "_internal" / "empty").write_bytes(b"")
    return folder


def test_every_mach_o_file_is_found_and_the_launcher_comes_last(tmp_path):
    folder = _sidecar(tmp_path / "sidecar")
    names = [path.relative_to(folder).as_posix() for path in sign_sidecar.macho_files(folder)]
    assert sorted(names[:-1]) == ["_internal/PIL/.dylibs/libjpeg.62.dylib", "_internal/fitz.cpython-312-darwin.so",
                                  "_internal/libpython3.12.dylib"]
    assert names[-1] == "papeer-sidecar"


def test_macos_signs_ad_hoc_then_verifies(tmp_path, monkeypatch):
    folder = _sidecar(tmp_path / "sidecar")
    monkeypatch.setattr(sys, "platform", "darwin")
    calls = []
    monkeypatch.setattr(sign_sidecar.subprocess, "run", lambda command, check: calls.append(command))
    assert sign_sidecar.main([str(folder)]) == 0
    assert len(calls) == 2
    assert calls[0][:5] == ["codesign", "--force", "--sign", "-", "--timestamp=none"]
    assert calls[1][:3] == ["codesign", "--verify", "--strict"]
    # The same four files each time, the launcher last.
    assert calls[0][5:] == calls[1][3:] and len(calls[1][3:]) == 4 and calls[1][-1].endswith("papeer-sidecar")
    calls.clear()
    assert sign_sidecar.main(["--verify", str(folder)]) == 0
    assert [command[:3] for command in calls] == [["codesign", "--verify", "--strict"]]


def test_a_failed_signature_fails_the_build(tmp_path, monkeypatch):
    folder = _sidecar(tmp_path / "sidecar")
    monkeypatch.setattr(sys, "platform", "darwin")

    def run(command, check):
        raise sign_sidecar.subprocess.CalledProcessError(1, command)

    monkeypatch.setattr(sign_sidecar.subprocess, "run", run)
    assert sign_sidecar.main([str(folder)]) == 1
    assert sign_sidecar.main([str(tmp_path / "missing")]) == 1


@pytest.mark.parametrize("platform", ["win32", "linux"])
def test_other_platforms_sign_nothing(tmp_path, monkeypatch, platform):
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(sign_sidecar.subprocess, "run", lambda *args, **kwargs: pytest.fail("codesign"))
    assert sign_sidecar.main([str(tmp_path / "missing")]) == 0
