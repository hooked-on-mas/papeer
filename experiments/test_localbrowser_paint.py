
import sys
from PySide6.QtWidgets import QApplication
from paperdesk.gui_widgets import LocalTextBrowser
from pathlib import Path
app = QApplication(sys.argv)
tb = LocalTextBrowser()
img_path = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures' / 'sample-paper' / 'media' / 'p6f1.png'
uri = img_path.as_uri()
tb.setMarkdown(f'![Image]({uri})')
tb.show()
sys.exit(0) # exit immediately, just want to see if it throws or what, actually we can just check if loadResource blocks it

