"""papeer-cli setup-path: the user's PATH is edited through a store the tests replace (never the registry)."""
from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from papeer.cli import setup_path
from papeer.cli.client import CliError
from papeer.cli.main import main
from papeer.cli.output import Output
from papeer.cli.setup_path import REG_EXPAND_SZ, REG_SZ, PathValue

FOLDER = r"C:\Users\me\AppData\Local\Papeer\sidecar"
EXE = Path(FOLDER) / "papeer-cli.exe"
ENVIRON = {"USERPROFILE": r"C:\Users\me", "LOCALAPPDATA": r"C:\Users\me\AppData\Local"}


class FakeStore:
    def __init__(self, value: PathValue | None, notified: bool = True) -> None:
        self.value = value
        self.notified = notified
        self.writes: list[PathValue] = []
        self.broadcasts = 0

    def read(self) -> PathValue | None:
        return self.value

    def write(self, value: PathValue) -> None:
        self.writes.append(value)
        self.value = value

    def notify(self) -> bool:
        self.broadcasts += 1
        return self.notified


def run(store: FakeStore, *, remove: bool = False, platform: str = "win32", executable: Path | None = EXE):
    out = Output(io.StringIO(), io.StringIO(), io.StringIO(), interactive=False)
    code = setup_path.run(out, remove=remove, executable=executable, platform=platform,
                          store_factory=lambda: store, environ=ENVIRON)
    return code, out.stdout.getvalue(), out.stderr.getvalue()  # type: ignore[attr-defined]


# --- Adding ---

def test_the_folder_is_appended_and_everything_else_is_kept_as_written():
    existing = r"%USERPROFILE%\bin;C:\Tools;;D:\Quoted Dir\ "
    store = FakeStore(PathValue(existing, REG_EXPAND_SZ))
    code, stdout, _ = run(store)
    assert code == 0
    assert store.writes == [PathValue(existing + ";" + FOLDER, REG_EXPAND_SZ)]
    assert store.broadcasts == 1
    assert "PATH に追加しました" in stdout and "ターミナル" in stdout


def test_the_value_type_is_kept():
    store = FakeStore(PathValue(r"C:\Tools", REG_SZ))
    run(store)
    assert store.value == PathValue(r"C:\Tools;" + FOLDER, REG_SZ)


def test_a_trailing_separator_is_not_doubled_and_an_empty_value_gets_no_leading_one():
    store = FakeStore(PathValue("C:\\Tools;", REG_EXPAND_SZ))
    run(store)
    assert store.value.text == "C:\\Tools;" + FOLDER
    empty = FakeStore(PathValue("", REG_SZ))
    run(empty)
    assert empty.value == PathValue(FOLDER, REG_SZ)


def test_a_missing_path_value_is_created_expandable():
    store = FakeStore(None)
    run(store)
    assert store.value == PathValue(FOLDER, REG_EXPAND_SZ)


@pytest.mark.parametrize("existing", [
    FOLDER,
    FOLDER.upper(),
    FOLDER + "\\",
    '"' + FOLDER + '"',
    FOLDER.replace("\\", "/"),
    r"%LOCALAPPDATA%\Papeer\sidecar",
    r"C:\Tools;" + FOLDER + r";D:\x",
])
def test_an_entry_already_there_is_not_added_again(existing):
    store = FakeStore(PathValue(existing, REG_EXPAND_SZ))
    code, stdout, _ = run(store)
    assert code == 0
    assert store.writes == [] and store.broadcasts == 0
    assert "すでに PATH にあります" in stdout


def test_a_long_path_is_never_truncated_and_a_too_long_one_is_refused():
    long_value = ";".join(rf"C:\Program Files\Tool{i:04d}" for i in range(300))
    assert len(long_value) > 1024
    store = FakeStore(PathValue(long_value, REG_EXPAND_SZ))
    run(store)
    assert store.value.text == long_value + ";" + FOLDER
    full = FakeStore(PathValue("x" * setup_path.MAX_VALUE_LENGTH, REG_SZ))
    with pytest.raises(CliError, match="長すぎる"):
        run(full)
    assert full.writes == []


def test_a_folder_with_a_percent_sign_cannot_go_into_an_expandable_value():
    store = FakeStore(PathValue(r"C:\Tools", REG_EXPAND_SZ))
    with pytest.raises(CliError, match="%"):
        run(store, executable=Path(r"C:\100%\sidecar\papeer-cli.exe"))
    assert store.writes == []
    plain = FakeStore(PathValue(r"C:\Tools", REG_SZ))
    run(plain, executable=Path(r"C:\100%\sidecar\papeer-cli.exe"))
    assert plain.value.text == r"C:\Tools;C:\100%\sidecar"


def test_an_unnotified_broadcast_is_reported_but_the_change_stays():
    store = FakeStore(PathValue("C:\\Tools", REG_EXPAND_SZ), notified=False)
    code, stdout, _ = run(store)
    assert code == 0 and store.value.text.endswith(FOLDER)
    assert "通知できませんでした" in stdout


# --- Removing ---

def test_remove_takes_out_only_our_entries():
    existing = rf"C:\Tools;{FOLDER};;%USERPROFILE%\bin;{FOLDER.lower()}\;"
    store = FakeStore(PathValue(existing, REG_EXPAND_SZ))
    code, stdout, _ = run(store, remove=True)
    assert code == 0
    assert store.writes == [PathValue(r"C:\Tools;;%USERPROFILE%\bin;", REG_EXPAND_SZ)]
    assert store.broadcasts == 1
    assert "PATH から削除しました" in stdout


def test_remove_when_it_is_not_there_changes_nothing():
    store = FakeStore(PathValue(r"C:\Tools;D:\x", REG_SZ))
    code, stdout, _ = run(store, remove=True)
    assert code == 0 and store.writes == [] and store.broadcasts == 0
    assert "PATH にありません" in stdout
    missing = FakeStore(None)
    assert run(missing, remove=True)[0] == 0 and missing.writes == []


# --- Output and the other platforms ---

def test_json_result():
    store = FakeStore(PathValue("C:\\Tools", REG_EXPAND_SZ))
    out = Output(io.StringIO(), io.StringIO(), io.StringIO(), json_mode=True)
    setup_path.run(out, remove=False, executable=EXE, platform="win32", store_factory=lambda: store, environ=ENVIRON)
    data = json.loads(out.stdout.getvalue())  # type: ignore[attr-defined]
    assert data == {"platform": "windows", "action": "add", "directory": FOLDER, "changed": True, "notified": True}


def test_a_source_checkout_is_refused_with_exit_2():
    store = FakeStore(PathValue("C:\\Tools", REG_EXPAND_SZ))
    code, stdout, stderr = run(store, executable=None)
    assert code == 2 and stdout == ""
    assert "ソースから実行" in stderr and "/usr/lib/Papeer/sidecar/papeer-cli" in stderr
    assert store.writes == []


@pytest.mark.parametrize("platform", ["darwin", "linux"])
def test_macos_and_linux_only_print_the_link_command(platform, monkeypatch):
    monkeypatch.setattr(setup_path.sys, "platform", platform)
    exe = Path("/Applications/Papeer.app/Contents/Resources/sidecar/papeer-cli")
    store = FakeStore(None)
    code, stdout, _ = run(store, platform=platform, executable=exe)
    assert code == 0 and store.writes == [] and store.broadcasts == 0
    assert f'ln -s "{exe}" ~/.local/bin/papeer-cli' in stdout
    code, stdout, _ = run(store, platform=platform, executable=exe, remove=True)
    assert "rm ~/.local/bin/papeer-cli" in stdout and "ln -s" not in stdout


def test_the_command_is_registered_and_refuses_from_source(capsys):
    # pytest is not a frozen build: exit 2 with the explanation, and no sidecar is looked for.
    assert main(["setup-path"]) == 2
    assert "ソースから実行" in capsys.readouterr().err
    assert main(["setup-path", "--remove", "--json"]) == 2


def test_the_windows_store_calls_the_documented_api(monkeypatch):
    """The broadcast is made as the Windows documentation has it: a handle and a message as 64-bit-safe ctypes."""
    if setup_path.sys.platform != "win32":
        pytest.skip("Windows only")
    import ctypes

    seen = {}

    class FakeFunction:
        argtypes = None
        restype = None

        def __call__(self, *args):
            seen["args"] = args
            seen["argtypes"] = self.argtypes
            seen["restype"] = self.restype
            return 1

    class FakeUser32:
        SendMessageTimeoutW = FakeFunction()

    monkeypatch.setattr(ctypes, "WinDLL", lambda name, use_last_error=False: FakeUser32())
    assert setup_path.WindowsUserPath().notify() is True
    assert seen["args"][:6] == (0xFFFF, 0x001A, 0, "Environment", 2, 5000)
    assert seen["restype"] is ctypes.c_ssize_t
    assert seen["argtypes"][0] is ctypes.c_void_p and seen["argtypes"][2] is ctypes.c_size_t
