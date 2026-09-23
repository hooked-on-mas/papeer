
import sys
from PySide6.QtWidgets import QApplication
from paperdesk.gui_widgets import LocalTextBrowser
from pathlib import Path
app = QApplication(sys.argv)
tb = LocalTextBrowser()
img_path = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures' / 'sample-paper' / 'media' / 'p6f1.png'
uri = img_path.as_uri()
tb.setMarkdown(f'![Image]({uri})')
print('HTML:', tb.toHtml())

