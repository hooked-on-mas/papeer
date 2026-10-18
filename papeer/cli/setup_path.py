"""`setup-path`: make papeer-cli reachable by name from a terminal.

Windows: add (or, with --remove, take away) the folder of the installed papeer-cli.exe in the user's `Path`
(HKCU\\Environment), keeping what is there: the value's type (REG_EXPAND_SZ or REG_SZ), every other entry
exactly as written and in order, and the whole length (a `setx` would cut it at 1024 characters). Then
WM_SETTINGCHANGE is broadcast so that Explorer, and the terminals opened after it, read the new value.
The registry is reached through a `UserPathStore`, so the tests never touch the real one.

macOS and Linux: no shell profile is edited; the `ln -s` command for the installed location is printed.

Only an installed (frozen) build has a folder worth putting on the PATH: from source the command refuses.
Standard library only (winreg and ctypes are loaded when the Windows store is used).
"""
from __future__ import annotations

from dataclasses import dataclass
import ntpath
import os
from pathlib import Path
import re
import sys
from typing import Callable, Mapping, Protocol

from papeer.cli.client import CliError
from papeer.cli.output import Output

EXIT_USAGE = 2
PROG = "papeer-cli"
# winreg.REG_SZ and winreg.REG_EXPAND_SZ (numbers, so that this module loads and is tested on every platform).
REG_SZ = 1
REG_EXPAND_SZ = 2
# The longest value of an environment variable.
MAX_VALUE_LENGTH = 32767
UNIX_LINK = "~/.local/bin/papeer-cli"
# Where an installed build puts papeer-cli (frontend/src-tauri/tauri.conf.json: bundle.resources "sidecar/"),
# for the message of a source checkout.
INSTALLED_LOCATIONS = (
    "Windows: インストール先の sidecar フォルダー（例: %LOCALAPPDATA%\\Papeer\\sidecar\\papeer-cli.exe）",
    "macOS: /Applications/Papeer.app/Contents/Resources/sidecar/papeer-cli",
    "Linux（.deb）: /usr/lib/Papeer/sidecar/papeer-cli",
)


@dataclass(frozen=True)
class PathValue:
    """The user's `Path` as the registry holds it: the text and its registry type."""

    text: str
    kind: int = REG_EXPAND_SZ


class UserPathStore(Protocol):
    def read(self) -> PathValue | None:
        """The user's Path, None when there is none."""
        ...

    def write(self, value: PathValue) -> None: ...

    def notify(self) -> bool:
        """Tell running programs that the environment changed; False when nobody could be told."""
        ...


# --- The entries of a PATH value ---

_VARIABLE = re.compile(r"%([^%]+)%")


def normalize_entry(entry: str, environ: Mapping[str, str]) -> str:
    """An entry as Windows reads it for a comparison: variables expanded, quotes and a closing slash
    dropped, separators and case made equal. "" for an entry that names nothing."""
    upper = {name.upper(): value for name, value in environ.items()}
    text = _VARIABLE.sub(lambda match: upper.get(match.group(1).upper(), match.group(0)), entry.strip())
    text = text.strip().strip('"').strip()
    if not text:
        return ""
    return ntpath.normcase(ntpath.normpath(text))


def contains(value: str, directory: str, environ: Mapping[str, str]) -> bool:
    wanted = normalize_entry(directory, environ)
    return any(normalize_entry(entry, environ) == wanted for entry in value.split(";"))


def with_directory(value: PathValue | None, directory: str, environ: Mapping[str, str]) -> PathValue | None:
    """`value` with `directory` appended (what was there is kept as written); None when it is there already."""
    if value is not None and contains(value.text, directory, environ):
        return None
    kind = value.kind if value is not None else REG_EXPAND_SZ
    if kind == REG_EXPAND_SZ and "%" in directory:
        # A % in an expandable value starts a variable: this folder cannot be written in one.
        raise CliError(f"フォルダーのパスに % が含まれるため、PATH に追加できません: {directory}")
    if value is None:
        return PathValue(directory)
    separator = "" if not value.text or value.text.endswith(";") else ";"
    return PathValue(value.text + separator + directory, value.kind)


def without_directory(value: PathValue | None, directory: str, environ: Mapping[str, str]) -> PathValue | None:
    """`value` without the entries that are `directory`, the others as written; None when none was there."""
    if value is None or not contains(value.text, directory, environ):
        return None
    wanted = normalize_entry(directory, environ)
    kept = [entry for entry in value.text.split(";") if normalize_entry(entry, environ) != wanted]
    return PathValue(";".join(kept), value.kind)


# --- Windows ---

class WindowsUserPath:
    """HKCU\\Environment\\Path through winreg, and the broadcast through user32."""

    SUBKEY = "Environment"
    NAME = "Path"
    HWND_BROADCAST = 0xFFFF
    WM_SETTINGCHANGE = 0x001A
    SMTO_ABORTIFHUNG = 0x0002
    TIMEOUT_MS = 5000

    def read(self) -> PathValue | None:
        if sys.platform != "win32":
            raise OSError("Windows PATH storage is only available on Windows")
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, self.SUBKEY, 0, winreg.KEY_READ) as key:
            try:
                text, kind = winreg.QueryValueEx(key, self.NAME)
            except FileNotFoundError:
                return None
        if kind not in (REG_SZ, REG_EXPAND_SZ) or not isinstance(text, str):
            raise CliError("ユーザーの PATH が文字列として保存されていないため、変更しませんでした。")
        return PathValue(text, kind)

    def write(self, value: PathValue) -> None:
        if sys.platform != "win32":
            raise OSError("Windows PATH storage is only available on Windows")
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, self.SUBKEY, 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, self.NAME, 0, value.kind, value.text)

    def notify(self) -> bool:
        if sys.platform != "win32":
            return False
        import ctypes

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        send = user32.SendMessageTimeoutW
        # LRESULT SendMessageTimeoutW(HWND, UINT, WPARAM, LPARAM, UINT, UINT, PDWORD_PTR): spelled out,
        # because ctypes passes a plain Python int as a 32-bit C int, which is wrong for a handle on 64 bits.
        send.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_wchar_p, ctypes.c_uint,
                         ctypes.c_uint, ctypes.POINTER(ctypes.c_size_t)]
        send.restype = ctypes.c_ssize_t
        result = ctypes.c_size_t(0)
        reply = send(self.HWND_BROADCAST, self.WM_SETTINGCHANGE, 0, "Environment", self.SMTO_ABORTIFHUNG,
                     self.TIMEOUT_MS, ctypes.byref(result))
        return bool(reply)


# --- The command ---

def installed_executable() -> Path | None:
    """This papeer-cli's own exe when it is an installed (frozen) build; None when run from source."""
    if getattr(sys, "frozen", False):
        return Path(os.path.abspath(sys.executable))
    return None


def _source_message() -> str:
    return ("ソースから実行しているため、PATH の設定は行いません"
            f"（setup-path はインストールした Papeer の {PROG} 用です）。\n"
            f"インストールした {PROG} の場所:\n" + "\n".join("  " + line for line in INSTALLED_LOCATIONS))


def _windows(out: Output, directory: Path, remove: bool, store: UserPathStore, environ: Mapping[str, str]) -> int:
    text = str(directory)
    current = store.read()
    updated = without_directory(current, text, environ) if remove else with_directory(current, text, environ)
    data: dict[str, object] = {"platform": "windows", "action": "remove" if remove else "add", "directory": text,
                               "changed": updated is not None}
    if updated is None:
        message = "PATH にありません（何も変更していません）: " if remove else "すでに PATH にあります（何も変更していません）: "
        out.emit(data, message + text)
        return 0
    if len(updated.text) > MAX_VALUE_LENGTH:
        raise CliError(f"PATH が長すぎるため、追加できません（{MAX_VALUE_LENGTH} 文字まで）。何も変更していません。")
    store.write(updated)
    announced = store.notify()
    data["notified"] = announced
    lines = [("PATH から削除しました: " if remove else "PATH に追加しました: ") + text,
             "新しく開いたターミナルから反映されます（すでに開いているターミナルは開き直してください）。"]
    if not announced:
        lines.append("警告: 環境の変更を他のプログラムへ通知できませんでした。反映されないときはサインインし直してください。")
    out.emit(data, "\n".join(lines))
    return 0


def _unix(out: Output, executable: Path, remove: bool) -> int:
    platform = "macos" if sys.platform == "darwin" else "linux"
    if remove:
        command = f"rm {UNIX_LINK}"
        text = f"次のコマンドで、貼ったリンクを削除できます（このコマンドは何も変更しません）:\n  {command}"
    else:
        command = f'mkdir -p ~/.local/bin && ln -s "{executable}" {UNIX_LINK}'
        text = (f"次のコマンドで {PROG} を PATH の通った場所に置けます（このコマンドは何も変更しません）:\n  {command}\n"
                "~/.local/bin が PATH に入っていなければ、シェルの設定（~/.profile など）に "
                'export PATH="$HOME/.local/bin:$PATH" を足してください。')
    out.emit({"platform": platform, "action": "remove" if remove else "add", "executable": str(executable),
              "link": UNIX_LINK, "command": command, "changed": False}, text)
    return 0


def run(out: Output, *, remove: bool, executable: Path | None, platform: str | None = None,
        store_factory: Callable[[], UserPathStore] = WindowsUserPath,
        environ: Mapping[str, str] | None = None) -> int:
    """`setup-path` for the papeer-cli at `executable` (None: not an installed build)."""
    if executable is None:
        out.error(_source_message())
        return EXIT_USAGE
    if (platform or sys.platform) == "win32":
        return _windows(out, executable.parent, remove, store_factory(), os.environ if environ is None else environ)
    return _unix(out, executable, remove)
