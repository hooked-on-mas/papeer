"""tools/sign_sidecar.py: which files of the onedir sidecar are signed ad hoc on macOS, and how."""
from __future__ import annotations

from pathlib import Path
import sys

import pytest

from tools import sign_sidecar

MACHO_64 = bytes.fromhex("cffaedfe") + b"\0" * 28
FAT = bytes.fromhex("cafebabe") + b"\0" * 28
FAT_64 = bytes.fromhex("cafebabf") + b"\0" * 28


def _sidecar(folder):
    (folder / "_internal" / "PIL" / ".dylibs").mkdir(parents=True)
    (folder / "papeer-cli").write_bytes(MACHO_64)
    (folder / "papeer-sidecar").write_bytes(MACHO_64)
    (folder / "_internal" / "libpython3.12.dylib").write_bytes(FAT)
    (folder / "_internal" / "PIL" / ".dylibs" / "libjpeg.62.dylib").write_bytes(MACHO_64)
    (folder / "_internal" / "fitz.cpython-312-darwin.so").write_bytes(MACHO_64)
    (folder / "_internal" / "libbig.dylib").write_bytes(FAT_64)  # A universal binary with 64-bit offsets.
    (folder / "_internal" / "code-version.txt").write_text("code-sha256-0\n")
    (folder / "_internal" / "base_library.zip").write_bytes(b"PK\3\4" + b"\0" * 28)
    (folder / "_internal" / "empty").write_bytes(b"")
    return folder


def test_every_mach_o_file_is_found_and_the_launcher_comes_last(tmp_path):
    folder = _sidecar(tmp_path / "sidecar")
    names = [path.relative_to(folder).as_posix() for path in sign_sidecar.macho_files(folder)]
    assert sorted(names[:-2]) == ["_internal/PIL/.dylibs/libjpeg.62.dylib", "_internal/fitz.cpython-312-darwin.so",
                                  "_internal/libbig.dylib", "_internal/libpython3.12.dylib"]
    # The programs come after the libraries they load, the sidecar before the command line client.
    assert names[-2:] == ["papeer-sidecar", "papeer-cli"]
    assert "papeer-cli" not in names[:-2] and "papeer-sidecar" not in names[:-2]


def test_the_launchers_are_the_ones_the_build_places():
    from papeer.core.code_version import LAUNCHERS

    assert sign_sidecar.LAUNCHERS == tuple(path.name.removesuffix(".exe") for path in LAUNCHERS)


def test_macos_signs_ad_hoc_then_verifies(tmp_path, monkeypatch):
    folder = _sidecar(tmp_path / "sidecar")
    monkeypatch.setattr(sys, "platform", "darwin")
    calls = []
    monkeypatch.setattr(sign_sidecar.subprocess, "run", lambda command, check: calls.append(command))
    assert sign_sidecar.main([str(folder)]) == 0
    assert len(calls) == 2
    assert calls[0][:5] == ["codesign", "--force", "--sign", "-", "--timestamp=none"]
    assert calls[1][:3] == ["codesign", "--verify", "--strict"]
    # The same six files each time, the launchers last.
    assert calls[0][5:] == calls[1][3:] and len(calls[1][3:]) == 6
    assert [Path(path).name for path in calls[1][-2:]] == ["papeer-sidecar", "papeer-cli"]
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


def test_a_folder_without_the_command_line_client_fails_the_build(tmp_path, monkeypatch, capsys):
    folder = _sidecar(tmp_path / "sidecar")
    (folder / "papeer-cli").unlink()
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(sign_sidecar.subprocess, "run", lambda *args, **kwargs: pytest.fail("codesign"))
    assert sign_sidecar.main([str(folder)]) == 1
    assert "papeer-cli がありません" in capsys.readouterr().err


@pytest.mark.parametrize("platform", ["win32", "linux"])
def test_other_platforms_sign_nothing(tmp_path, monkeypatch, platform):
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(sign_sidecar.subprocess, "run", lambda *args, **kwargs: pytest.fail("codesign"))
    assert sign_sidecar.main([str(tmp_path / "missing")]) == 0
