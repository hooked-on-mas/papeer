import sys

def read_lines(file):
    with open(file, 'r', encoding='utf-8') as f:
        return f.readlines()

def write_lines(file, lines):
    with open(file, 'w', encoding='utf-8') as f:
        f.writelines(lines)

lines = read_lines('paperdesk/gui.py')

header = lines[0:45]

# 1. gui_widgets.py
widgets_code = header + ["\n"] + lines[45:268]
write_lines('paperdesk/gui_widgets.py', widgets_code)

# 2. gui_dialogs.py
dialogs_code = header + [
    "\nfrom .gui_widgets import *\n\n"
] + lines[269:730]
write_lines('paperdesk/gui_dialogs.py', dialogs_code)

# 3. gui_window_base.py
base_code = header + [
    "\nfrom .gui_widgets import *\n",
    "from .gui_dialogs import *\n\n",
    "class WindowBase(QMainWindow):\n"
] + lines[733:1216]
write_lines('paperdesk/gui_window_base.py', base_code)

# 4. gui_window_library.py
library_code = header + [
    "\nfrom .gui_widgets import *\n",
    "from .gui_dialogs import *\n\n",
    "class WindowLibraryMixin:\n"
] + lines[1216:1644]
write_lines('paperdesk/gui_window_library.py', library_code)

# 5. gui_window_viewer.py
viewer_code = header + [
    "\nfrom .gui_widgets import *\n",
    "from .gui_dialogs import *\n\n",
    "class WindowViewerMixin:\n"
] + lines[1937:2142]
write_lines('paperdesk/gui_window_viewer.py', viewer_code)

# 6. gui.py
gui_code = header + [
    "\nfrom .gui_widgets import *\n",
    "from .gui_dialogs import *\n",
    "from .gui_window_base import WindowBase\n",
    "from .gui_window_library import WindowLibraryMixin\n",
    "from .gui_window_viewer import WindowViewerMixin\n\n",
    "class Window(WindowBase, WindowLibraryMixin, WindowViewerMixin):\n",
    lines[732]  # translation_page_ready = Signal(str, int)
] + lines[1644:1937] + lines[2142:2238] + ["\n"] + lines[2239:]
write_lines('paperdesk/gui.py', gui_code)

print("Split completed.")

