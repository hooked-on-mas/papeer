"""Windows shell integration: assets, launch target, shortcuts, and pinning identity."""
import ctypes
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from paperdesk.core import winintegration

# Relaunch properties live on a real HWND, which the offscreen Qt platform does not provide.
NATIVE_WINDOWS_GUI = winintegration.WINDOWS and os.environ.get("QT_QPA_PLATFORM", "windows") == "windows"


def read_window_property(handle: int, pid: int) -> str:
    store = ctypes.c_void_p()
    ctypes.windll.shell32.SHGetPropertyStoreForWindow(
        ctypes.c_void_p(handle),
        ctypes.pointer(winintegration.GUID(winintegration.IID_PROPERTY_STORE)),
        ctypes.pointer(store))
    if not store:
        return ""
    try:
        key = winintegration.PropertyKey(winintegration.GUID(winintegration.FMTID_APP_USER_MODEL), pid)
        variant = winintegration.PropVariant()
        if winintegration._call(store, 5, ctypes.pointer(key), ctypes.pointer(variant)) != 0:  # GetValue
            return ""
        try:
            return ctypes.wstring_at(variant.value) if variant.vt == winintegration.VT_LPWSTR else ""
        finally:
            ctypes.windll.ole32.PropVariantClear(ctypes.byref(variant))
    finally:
        winintegration._release(store)


class AssetTest(unittest.TestCase):
    def test_icon_files_are_shipped(self):
        for name in ["paperdesk.ico", "paperdesk.png"]:
            path = winintegration.asset(name)
            self.assertTrue(path.exists(), f"{name} is missing; run tools/make_icon.py")
            self.assertGreater(path.stat().st_size, 1000)

    def test_icon_path_matches_platform(self):
        self.assertEqual(winintegration.icon_path().suffix, ".ico" if winintegration.WINDOWS else ".png")

    def test_launch_target_points_at_this_installation(self):
        executable, arguments, working_directory = winintegration.launch_target()
        self.assertTrue(executable.exists())
        self.assertTrue((working_directory / "main.py").exists() or getattr(sys, "frozen", False))
        if not getattr(sys, "frozen", False):
            self.assertIn("main.py", arguments)


@unittest.skipUnless(winintegration.WINDOWS, "Shortcuts are a Windows shell feature")
class ShortcutTest(unittest.TestCase):
    def test_shortcut_carries_target_icon_and_app_id(self):
        executable, arguments, working_directory = winintegration.launch_target()
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "PaperDesk.lnk"
            winintegration.create_shortcut(destination, executable, arguments, working_directory,
                                           winintegration.icon_path(), "PaperDesk")
            self.assertTrue(destination.exists())
            data = destination.read_bytes()
            for expected in [str(winintegration.icon_path()), winintegration.APP_ID]:
                # Pinning groups the shortcut with the running window only via this app id.
                self.assertIn(expected.encode("utf-16-le"), data, expected)
            # The link target is written in the local code page, the icon and app id in UTF-16.
            self.assertIn(str(executable).encode("mbcs"), data)


@unittest.skipUnless(NATIVE_WINDOWS_GUI, "Needs a real Windows window handle")
class WindowIdentityTest(unittest.TestCase):
    def test_live_window_describes_how_to_relaunch_paperdesk(self):
        from PySide6.QtWidgets import QApplication, QWidget

        application = QApplication.instance() or QApplication([])
        widget = QWidget()
        handle = int(widget.winId())
        self.assertTrue(winintegration.apply_window_identity(handle))
        application.processEvents()
        # These are what the shell records when the running window is pinned; without them
        # it falls back to the host executable, which is python.exe.
        self.assertEqual(read_window_property(handle, winintegration.APP_ID_PID), winintegration.APP_ID)
        self.assertEqual(read_window_property(handle, winintegration.RELAUNCH_DISPLAY_NAME_PID), "PaperDesk")
        self.assertTrue(read_window_property(handle, winintegration.RELAUNCH_ICON_PID).endswith(".ico,0"))
        command = read_window_property(handle, winintegration.RELAUNCH_COMMAND_PID)
        self.assertIn("main.py" if not getattr(sys, "frozen", False) else "PaperDesk", command)
        self.assertNotIn("python.exe", command)  # pythonw.exe keeps the console window away
        widget.deleteLater()
        application.processEvents()


if __name__ == "__main__":
    unittest.main()
