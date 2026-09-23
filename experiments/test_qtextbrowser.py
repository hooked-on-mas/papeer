
import sys
from PySide6.QtWidgets import QApplication, QTextBrowser
from pathlib import Path
app = QApplication(sys.argv)
tb = QTextBrowser()
# Use the extracted image
img_path = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures' / 'sample-paper' / 'media' / 'p6f1.png'
uri = img_path.as_uri()
tb.setMarkdown(f'Hello\n\n![Image]({uri})')
print('HTML:', tb.toHtml())

