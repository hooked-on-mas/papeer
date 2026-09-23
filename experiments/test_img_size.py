import sys; from PySide6.QtGui import QImage; from PySide6.QtWidgets import QApplication; app=QApplication(sys.argv); img = QImage('test_local_math.png'); print(img.width(), img.height())
