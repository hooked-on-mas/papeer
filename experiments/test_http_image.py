
import sys
from PySide6.QtWidgets import QApplication
from paperdesk.gui_widgets import LocalTextBrowser
app = QApplication(sys.argv)
tb = LocalTextBrowser()
tb.setMarkdown('Hello ![math](https://latex.codecogs.com/png.image?%5Cbg%7Bwhite%7D%5C1%2B1%3D2)')
html = tb.toHtml()
print('HTML:', html)
res = tb.loadResource(3, 'https://latex.codecogs.com/png.image?%5Cbg%7Bwhite%7D%5C1%2B1%3D2')
print('Res:', type(res))

