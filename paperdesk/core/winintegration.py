"""Windows shell integration: taskbar identity, taskbar progress, and shortcuts.

Every entry point degrades to a no-op when the platform, the COM interface, or the
shell API is unavailable, so the application behaves the same way on other systems.
"""
from __future__ import annotations

import ctypes
from ctypes import POINTER, byref, c_void_p, c_wchar_p
import os
from pathlib import Path
import sys

# Shared identity for the process, its windows, and the shortcuts users pin.
# Windows groups a pinned shortcut with a running window only when both carry this string.
APP_ID = "PaperDeskLocal.PaperDesk"
WINDOWS = sys.platform == "win32"

NO_PROGRESS, INDETERMINATE, NORMAL, ERROR, PAUSED = 0, 0x1, 0x2, 0x4, 0x8

CLSID_TASKBAR_LIST = "{56FDF344-FD6D-11D0-958A-006097C9A090}"
IID_TASKBAR_LIST_3 = "{EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF}"
CLSID_SHELL_LINK = "{00021401-0000-0000-C000-000000000046}"
IID_SHELL_LINK_W = "{000214F9-0000-0000-C000-000000000046}"
IID_PERSIST_FILE = "{0000010B-0000-0000-C000-000000000046}"
IID_PROPERTY_STORE = "{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}"
FMTID_APP_USER_MODEL = "{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}"
# Property ids within FMTID_APP_USER_MODEL.
RELAUNCH_COMMAND_PID = 2
RELAUNCH_ICON_PID = 3
RELAUNCH_DISPLAY_NAME_PID = 4
APP_ID_PID = 5

CLSCTX_INPROC_SERVER = 1
COINIT_APARTMENTTHREADED = 0x2
VT_LPWSTR = 31


def asset(name: str) -> Path:
    return Path(__file__).resolve().parent / "assets" / name


def icon_path() -> Path:
    return asset("paperdesk.ico" if WINDOWS else "paperdesk.png")


class GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]

    def __init__(self, text: str = ""):
        super().__init__()
        if text:
            ctypes.oledll.ole32.IIDFromString(c_wchar_p(text), byref(self))


class PropertyKey(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", ctypes.c_uint32)]


class PropVariant(ctypes.Structure):
    _fields_ = [("vt", ctypes.c_ushort), ("reserved1", ctypes.c_ushort),
                ("reserved2", ctypes.c_ushort), ("reserved3", ctypes.c_ushort),
                ("value", c_void_p), ("padding", c_void_p)]


def _call(interface: c_void_p, slot: int, *arguments) -> int:
    """Invoke method `slot` of a COM interface pointer through its vtable."""
    vtable = ctypes.cast(interface, POINTER(c_void_p))[0]
    address = ctypes.cast(vtable, POINTER(c_void_p))[slot]
    signature = ctypes.WINFUNCTYPE(ctypes.c_long, c_void_p, *(type(a) for a in arguments))
    return signature(address)(interface, *arguments)


def _create_instance(clsid: str, iid: str) -> c_void_p | None:
    interface = c_void_p()
    try:
        ctypes.oledll.ole32.CoCreateInstance(
            byref(GUID(clsid)), None, CLSCTX_INPROC_SERVER, byref(GUID(iid)), byref(interface))
    except OSError:
        return None
    return interface if interface else None


def _query(interface: c_void_p, iid: str) -> c_void_p | None:
    result = c_void_p()
    # ctypes.pointer (not byref) so the vtable signature below sees a real pointer type.
    if _call(interface, 0, ctypes.pointer(GUID(iid)), ctypes.pointer(result)) != 0:
        return None
    return result if result else None


def _release(interface: c_void_p | None) -> None:
    if interface:
        _call(interface, 2)


def initialize_com() -> None:
    if WINDOWS:
        try:
            ctypes.windll.ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
        except OSError:
            pass


def apply_app_identity() -> None:
    """Tell the shell which application this process is, so pinning targets PaperDesk."""
    if not WINDOWS:
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(c_wchar_p(APP_ID))
    except (OSError, AttributeError):
        pass


def apply_window_identity(handle: int) -> bool:
    """Describe how to relaunch this window, so pinning it pins PaperDesk and not python.exe.

    Without these properties the shell falls back to the running executable, which is the
    interpreter. With them, "pin to taskbar" on the live window records our launch command,
    display name, and icon even when no Start menu shortcut exists yet.
    """
    if not WINDOWS or not handle:
        return False
    store = c_void_p()
    try:
        result = ctypes.windll.shell32.SHGetPropertyStoreForWindow(
            c_void_p(handle), ctypes.pointer(GUID(IID_PROPERTY_STORE)), ctypes.pointer(store))
    except (OSError, AttributeError):
        return False
    if result != 0 or not store:
        return False
    executable, arguments, _ = launch_target()
    command = f'"{executable}" {arguments}'.strip()
    try:
        written = all(_write_property(store, pid, value) for pid, value in [
            (APP_ID_PID, APP_ID),
            (RELAUNCH_COMMAND_PID, command),
            (RELAUNCH_DISPLAY_NAME_PID, "PaperDesk"),
            (RELAUNCH_ICON_PID, f"{icon_path()},0"),
        ])
        return written and _call(store, 7) == 0  # Commit
    finally:
        _release(store)


class TaskbarProgress:
    """Progress indicator drawn on the taskbar button, via ITaskbarList3."""

    def __init__(self):
        self.interface = None
        if not WINDOWS:
            return
        interface = _create_instance(CLSID_TASKBAR_LIST, IID_TASKBAR_LIST_3)
        if interface and _call(interface, 3) == 0:  # HrInit
            self.interface = interface
        else:
            _release(interface)

    def state(self, handle: int, flag: int) -> None:
        if self.interface and handle:
            _call(self.interface, 10, c_void_p(handle), ctypes.c_int(flag))

    def busy(self, handle: int, active: bool) -> None:
        self.state(handle, INDETERMINATE if active else NO_PROGRESS)

    def value(self, handle: int, completed: int, total: int) -> None:
        if self.interface and handle and total > 0:
            _call(self.interface, 9, c_void_p(handle),
                  ctypes.c_ulonglong(max(0, completed)), ctypes.c_ulonglong(total))

    def close(self) -> None:
        _release(self.interface)
        self.interface = None


def _string_variant(text: str) -> PropVariant | None:
    """VT_LPWSTR PROPVARIANT owning a shell-allocated copy, freed by PropVariantClear."""
    buffer = ctypes.create_unicode_buffer(text)
    size = ctypes.sizeof(buffer)
    allocate = ctypes.windll.ole32.CoTaskMemAlloc
    allocate.restype = c_void_p
    allocate.argtypes = [ctypes.c_size_t]
    address = allocate(size)
    if not address:
        return None
    ctypes.memmove(address, buffer, size)
    variant = PropVariant()
    variant.vt = VT_LPWSTR
    variant.value = c_void_p(address)
    return variant


def _write_property(store: c_void_p, pid: int, text: str) -> bool:
    variant = _string_variant(text)
    if not variant:
        return False
    try:
        key = PropertyKey(GUID(FMTID_APP_USER_MODEL), pid)
        return _call(store, 6, ctypes.pointer(key), ctypes.pointer(variant)) == 0  # SetValue
    finally:
        ctypes.windll.ole32.PropVariantClear(byref(variant))


def _set_shortcut_app_id(link: c_void_p, app_id: str) -> None:
    store = _query(link, IID_PROPERTY_STORE)
    if not store:
        return
    try:
        if _write_property(store, APP_ID_PID, app_id):
            _call(store, 7)  # Commit
    finally:
        _release(store)


def create_shortcut(destination: Path, target: Path, arguments: str = "",
                    working_directory: Path | None = None, icon: Path | None = None,
                    description: str = "") -> Path:
    """Write a .lnk carrying the PaperDesk identity, so pinning it behaves as expected."""
    if not WINDOWS:
        raise RuntimeError("ショートカットの作成はWindowsでのみ利用できます。")
    initialize_com()
    link = _create_instance(CLSID_SHELL_LINK, IID_SHELL_LINK_W)
    if not link:
        raise RuntimeError("Windowsのショートカット機能を初期化できませんでした。")
    try:
        _call(link, 20, c_wchar_p(str(target)))  # SetPath
        if arguments:
            _call(link, 11, c_wchar_p(arguments))  # SetArguments
        if working_directory:
            _call(link, 9, c_wchar_p(str(working_directory)))  # SetWorkingDirectory
        if description:
            _call(link, 7, c_wchar_p(description[:255]))  # SetDescription
        if icon and icon.exists():
            _call(link, 17, c_wchar_p(str(icon)), ctypes.c_int(0))  # SetIconLocation
        _set_shortcut_app_id(link, APP_ID)
        persist = _query(link, IID_PERSIST_FILE)
        if not persist:
            raise RuntimeError("ショートカットを保存する準備ができませんでした。")
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            if _call(persist, 6, c_wchar_p(str(destination)), ctypes.c_int(1)) != 0:  # Save
                raise RuntimeError(f"ショートカットを保存できませんでした: {destination}")
        finally:
            _release(persist)
    finally:
        _release(link)
    return destination


def launch_target() -> tuple[Path, str, Path]:
    """Executable, arguments, and working directory that start this installation."""
    if getattr(sys, "frozen", False):
        executable = Path(sys.executable)
        return executable, "", executable.parent
    project = Path(__file__).resolve().parent.parent.parent
    interpreter = Path(sys.executable)
    windowless = interpreter.with_name("pythonw.exe")
    if windowless.exists():
        interpreter = windowless  # Start without a console window, like a packaged app.
    return interpreter, f'"{project / "main.py"}"', project


def start_menu_directory() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData/Roaming")
    return Path(base) / "Microsoft" / "Windows" / "Start Menu" / "Programs"


def install_shortcuts() -> list[Path]:
    """Place PaperDesk in the Start menu and on the desktop, ready to be pinned."""
    executable, arguments, working_directory = launch_target()
    desktop = Path(os.environ.get("USERPROFILE") or Path.home()) / "Desktop"
    targets = [start_menu_directory() / "PaperDesk.lnk"]
    if desktop.is_dir():
        targets.append(desktop / "PaperDesk.lnk")
    return [create_shortcut(path, executable, arguments, working_directory,
                            icon_path(), "PaperDesk — 日本語で論文を読む")
            for path in targets]
