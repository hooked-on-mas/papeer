from __future__ import annotations

from dataclasses import replace
import html
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import threading

from PySide6.QtCore import Qt, QEvent, QMimeData, QObject, QSettings, QThread, QTimer, QUrl, Signal
from PySide6.QtGui import QAction, QDesktopServices, QDrag, QFont, QIcon, QKeySequence, QPainter, QPixmap, QTextBlockFormat, QTextCursor
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QDialog, QDialogButtonBox, QFileDialog,
    QFormLayout, QFrame, QHBoxLayout, QLabel, QLineEdit, QTreeWidget, QTreeWidgetItem,
    QInputDialog, QMainWindow, QMenu, QMessageBox, QPlainTextEdit, QProgressBar, QPushButton, QScrollArea,
    QSpinBox, QSplitter, QSizePolicy, QStyle, QSystemTrayIcon, QTabWidget, QTextBrowser, QVBoxLayout, QWidget,
)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebEngineCore import QWebEnginePage
import markdown

from paperdesk.core import winintegration
from paperdesk.core.config import REASONING_EFFORTS, Settings, data_directory
from paperdesk.pdf.pdf_viewer import PageRenderer, page_image
from paperdesk.layout.page_selection import parse_page_selection
from paperdesk.core.providers import Cancelled, Provider, codex_command, claude_command, gemini_command, query_available_models, query_available_efforts
from paperdesk.core.service import PaperService
from paperdesk.core.storage import Library, normalize_collection_name
from paperdesk.core.bibliography import paper_display_name
from paperdesk.translation.translation_preview import read_preview, translated_page, translated_page_numbers

COUNTER = re.compile(r"(\d+)\s*/\s*(\d+)")
PAPER_ROLE = Qt.ItemDataRole.UserRole
ITEM_KIND_ROLE = Qt.ItemDataRole.UserRole + 1
COLLECTION_ROLE = Qt.ItemDataRole.UserRole + 2
TRANSLATION_PRESETS = {
    "sol-medium": ("gpt-5.6-sol", "medium", "普段の全文翻訳用"),
    "sol-high": ("gpt-5.6-sol", "high", "難解な理論・証明用"),
    "terra-medium": ("gpt-5.6-terra", "medium", "多数の論文を読む際の、品質とAPI費用のバランス重視"),
}



def app_icon() -> QIcon:
    path = winintegration.icon_path()
    return QIcon(str(path)) if path.exists() else QIcon()


def dropped_pdfs(event) -> list[Path]:
    if not event.mimeData().hasUrls():
        return []
    return [Path(url.toLocalFile()) for url in event.mimeData().urls()
            if url.isLocalFile() and url.toLocalFile().lower().endswith(".pdf")]


STYLE = """
QMainWindow, QDialog { background:#f4f6fa; color:#202b40; }
QWidget { font-family:'Yu Gothic UI','Segoe UI','Noto Sans CJK JP',sans-serif; font-size:13px; }
QFrame#sidebar { background:#172338; border-radius:12px; }
QFrame#sidebar QLabel, QFrame#sidebar QCheckBox { color:#dce7f6; }
QLabel#brand { color:#ffffff; font-size:25px; font-weight:700; }
QLabel#title { color:#192b47; font-size:15px; font-weight:600; }
QLabel#subtle { color:#6a778d; }
QPushButton { background:white; border:1px solid #d4dce8; border-radius:7px; padding:5px 9px; color:#263957; }
QPushButton:hover { background:#eaf0fc; border-color:#a9bde3; }
QPushButton:disabled { background:#edf0f5; color:#99a4b5; border-color:#e2e6ed; }
QPushButton#primary { color:white; background:#285ee6; border-color:#285ee6; font-weight:600; }
QPushButton#primary:hover { background:#1d4fce; }
QPushButton#primary:disabled { background:#9daed4; border-color:#9daed4; }
QLineEdit, QPlainTextEdit, QTextBrowser, QComboBox, QSpinBox { background:white; color:#24314a; border:1px solid #d7dfea; border-radius:7px; padding:7px; selection-background-color:#ccdafe; }
QTextBrowser { font-size:15px; padding:14px; }
QTreeWidget { background:transparent; border:0; color:#dce7f6; outline:0; }
QTreeWidget::item { padding:7px 5px; margin:2px 0; border-radius:7px; }
QTreeWidget::item:selected { background:#304869; color:white; }
QTreeWidget::item:hover { background:#243954; }
QTabWidget::pane { border:1px solid #d7dfea; border-radius:8px; background:white; }
QTabBar::tab { padding:5px 16px; margin-right:3px; color:#65748a; }
QTabBar::tab:selected { color:#285ee6; background:white; border-top:2px solid #285ee6; }
QScrollArea { border:0; background:#e3e8ef; }
QProgressBar { border:0; background:#e4eaf4; border-radius:3px; max-height:6px; }
QProgressBar::chunk { background:#285ee6; border-radius:3px; }
QSplitter::handle { background:#d7dfea; width:10px; }
QSplitter::handle:hover { background:#a9bde3; }
"""


class LinkedScrollBars(QObject):
    """Keep paired views at the same fraction of their scrollable range."""

    def __init__(self, bars, parent=None):
        super().__init__(parent)
        self.bars = bars
        self.fraction = 0.0
        self.updating = False
        for bar in bars:
            bar.valueChanged.connect(lambda value, bar=bar: self.scroll_changed(bar, value))
            bar.rangeChanged.connect(lambda _min, _max, bar=bar: self.restore_position(bar))

    def scroll_changed(self, source, value):
        if self.updating or source.maximum() == source.minimum():
            return
        self.fraction = (value - source.minimum()) / (source.maximum() - source.minimum())
        for bar in self.bars:
            if bar is not source:
                self.restore_position(bar)

    def restore_position(self, bar):
        if self.updating:
            return
        self.updating = True
        try:
            bar.setValue(bar.minimum() + round(self.fraction * (bar.maximum() - bar.minimum())))
        finally:
            self.updating = False


class CompactLabel(QLabel):
    """One-line text with a tooltip, without forcing the reader to shrink."""
    def __init__(self, text="", parent=None):
        super().__init__(text, parent)
        self.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Fixed)
        self.setMinimumWidth(0)
        self.setToolTip(text)

    def setText(self, text):
        super().setText(text)
        self.setToolTip(text)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setPen(self.palette().color(self.foregroundRole()))
        text = self.fontMetrics().elidedText(self.text(), Qt.TextElideMode.ElideRight, self.contentsRect().width())
        painter.drawText(self.contentsRect(), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, text)


class LibraryTree(QTreeWidget):
    """Drops change library metadata, never Qt's tree model or the source file."""
    paper_moved = Signal(str, str)
    files_dropped = Signal(list, str)
    paper_mime = "application/x-paperdesk-paper-id"

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setDragEnabled(True)
        self.setAcceptDrops(True)
        self.setDragDropMode(QTreeWidget.DragDropMode.DragDrop)
        self.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.imports_enabled = True
        self.drop_target = None
        self.hover_timer = QTimer(self)
        self.hover_timer.setSingleShot(True)
        self.hover_timer.timeout.connect(self.expand_drop_target)

    def startDrag(self, _actions):
        item = self.currentItem()
        if not item or item.data(0, ITEM_KIND_ROLE) != "paper":
            return
        mime = QMimeData()
        mime.setData(self.paper_mime, item.data(0, PAPER_ROLE).encode("ascii"))
        drag = QDrag(self)
        drag.setMimeData(mime)
        drag.exec(Qt.DropAction.MoveAction)

    def accepts_drag(self, event):
        return ((event.source() is self and event.mimeData().hasFormat(self.paper_mime))
                or (self.imports_enabled and bool(dropped_pdfs(event))))

    def dragEnterEvent(self, event):
        if self.accepts_drag(event):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragMoveEvent(self, event):
        target = self.itemAt(event.position().toPoint())
        if not self.accepts_drag(event) or not target or target.data(0, ITEM_KIND_ROLE) != "folder":
            self.clear_drop_target()
            event.ignore()
            return
        if target is not self.drop_target:
            self.drop_target = target
            self.hover_timer.start(700)
            self.viewport().update()
        event.setDropAction(Qt.DropAction.MoveAction if event.source() is self else Qt.DropAction.CopyAction)
        event.accept()

    def expand_drop_target(self):
        if self.drop_target:
            self.drop_target.setExpanded(True)

    def clear_drop_target(self):
        self.hover_timer.stop()
        self.drop_target = None
        self.viewport().update()

    def dragLeaveEvent(self, event):
        self.clear_drop_target()
        event.accept()

    def dropEvent(self, event):
        target = self.itemAt(event.position().toPoint())
        self.clear_drop_target()
        if not self.accepts_drag(event) or not target or target.data(0, ITEM_KIND_ROLE) != "folder":
            event.ignore()
            return
        collection = target.data(0, COLLECTION_ROLE)
        if event.source() is self:
            identity = bytes(event.mimeData().data(self.paper_mime)).decode("ascii", errors="replace")
            event.setDropAction(Qt.DropAction.MoveAction)
            event.accept()
            self.paper_moved.emit(identity, collection)
        else:
            paths = [path for path in dropped_pdfs(event) if path.is_file()]
            if not paths:
                event.ignore()
                return
            event.setDropAction(Qt.DropAction.CopyAction)
            event.accept()
            self.files_dropped.emit(paths, collection)

    def paintEvent(self, event):
        super().paintEvent(event)
        if self.drop_target:
            painter = QPainter(self.viewport())
            painter.setPen(self.palette().highlight().color())
            painter.drawRect(self.visualItemRect(self.drop_target).adjusted(1, 1, -2, -2))
            painter.end()


KATEX_HTML_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"></script>
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.min.js"></script>
    <link href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/copy-tex.min.css" rel="stylesheet" type="text/css">
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/copy-tex.min.js"></script>
    <script>
        document.addEventListener("DOMContentLoaded", function() {
            renderMathInElement(document.body, {
              delimiters: [
                  {left: '$$', right: '$$', display: true},
                  {left: '$', right: '$', display: false},
                  {left: '\\\\[', right: '\\\\]', display: true},
                  {left: '\\\\(', right: '\\\\)', display: false}
              ],
              throwOnError : false
            });
        });
    </script>
    <style>
        body {
            font-family: 'Yu Gothic UI', 'Segoe UI', 'Noto Sans CJK JP', sans-serif;
            font-size: 15px;
            line-height: 1.65;
            color: #24314a;
            padding: 14px;
            background-color: white;
            margin: 0;
            overflow-x: hidden;
            word-wrap: break-word;
        }
        a { color: #285ee6; }
        h1, h2, h3 { color: #233c61; margin-top: 16px; margin-bottom: 6px; }
        p { margin-top: 6px; margin-bottom: 6px; }
        img { max-width: 100%; }
        code { background-color: #f4f6fa; padding: 2px 4px; border-radius: 4px; font-family: monospace; }
        pre code { display: block; padding: 10px; overflow-x: auto; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #d7dfea; padding: 8px; }
        th { background-color: #f4f6fa; }
    </style>
</head>
<body>
{content}
</body>
</html>
"""

class CustomWebEnginePage(QWebEnginePage):
    anchorClicked = Signal(QUrl)

    def acceptNavigationRequest(self, url, _type, isMainFrame):
        if _type == QWebEnginePage.NavigationType.NavigationTypeLinkClicked:
            self.anchorClicked.emit(url)
            return False
        return True

class MockDocument:
    def setDefaultStyleSheet(self, style):
        pass

class MockScrollBar:
    def __init__(self, page):
        self.page = page
    
    def setValue(self, value):
        if value > 0:
            self.page.runJavaScript("window.scrollTo(0, document.body.scrollHeight);")
    
    def maximum(self):
        return 1

class LocalTextBrowser(QWebEngineView):
    anchorClicked = Signal(QUrl)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setPage(CustomWebEnginePage(self))
        self.page().anchorClicked.connect(self.anchorClicked)
        
    def setOpenLinks(self, open):
        pass
        
    def setOpenExternalLinks(self, open):
        pass
        
    def document(self):
        return MockDocument()
        
    def verticalScrollBar(self):
        return MockScrollBar(self.page())

    def setMarkdown(self, text):
        math_blocks = []
        def save_math(match):
            idx = len(math_blocks)
            math_blocks.append(match.group(0))
            return f"<!--MATH_BLOCK_{idx}-->"
            
        text = re.sub(r"\$\$(.*?)\$\$", save_math, text, flags=re.DOTALL)
        text = re.sub(r"\$([^\n\$]+?)\$", save_math, text)
        
        html_content = markdown.markdown(text, extensions=['tables', 'fenced_code'])
        
        for i, block in enumerate(math_blocks):
            html_content = html_content.replace(f"<!--MATH_BLOCK_{i}-->", block)
            
        full_html = KATEX_HTML_TEMPLATE.replace("{content}", html_content)
        self.setHtml(full_html)




class Job(QThread):
    progress = Signal(str)
    succeeded = Signal(object)
    failed = Signal(str, bool)

    def __init__(self, action, parent=None):
        super().__init__(parent)
        self.action = action
        self.cancel = threading.Event()

    def run(self):
        try:
            self.succeeded.emit(self.action(self.cancel, self.progress.emit))
        except Cancelled as error:
            self.failed.emit(str(error), True)
        except Exception as error:
            self.failed.emit(str(error), False)

