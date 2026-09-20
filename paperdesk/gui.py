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

from . import winintegration
from .config import REASONING_EFFORTS, Settings, data_directory
from .pdf_viewer import page_image
from .page_selection import parse_page_selection
from .providers import Cancelled, Provider, codex_command
from .service import PaperService
from .storage import Library, normalize_collection_name
from .bibliography import paper_display_name
from .translation_preview import read_preview, translated_page, translated_page_numbers

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


class LocalTextBrowser(QTextBrowser):
    def setMarkdown(self, text):
        super().setMarkdown(text)
        block = self.document().begin()
        while block.isValid():
            cursor = QTextCursor(block)
            formatting = block.blockFormat()
            formatting.setTopMargin(16 if formatting.headingLevel() else 6)
            formatting.setBottomMargin(6)
            formatting.setLineHeight(145, QTextBlockFormat.LineHeightTypes.ProportionalHeight.value)
            cursor.setBlockFormat(formatting)
            block = block.next()

    def loadResource(self, resource_type, name):
        # Generated Markdown is text and internal page links only.
        # Never fetch remote images or read arbitrary local paths from document content.
        return None


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


class TranslationPagesDialog(QDialog):
    def __init__(self, page_count, current_page, parent=None, selected_pages=None,
                 settings=None, preset="connection"):
        super().__init__(parent)
        self.connection_settings = replace(settings or Settings())
        self.page_count, self.current_page = page_count, current_page
        self.pages = set(range(1, page_count + 1))
        self.setWindowTitle("翻訳の設定")
        self.setMinimumWidth(600)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("今回の翻訳に使うモデル・effort"))
        self.preset = QComboBox()
        for key, (_model, _effort, description) in TRANSLATION_PRESETS.items():
            self.preset.addItem(f"{key}：{description}", key)
        self.preset.addItem("AI接続の設定をそのまま使う", "connection")
        selected_index = self.preset.findData(preset)
        self.preset.setCurrentIndex(selected_index if selected_index >= 0 else self.preset.findData("connection"))
        layout.addWidget(self.preset)
        self.model_summary = QLabel()
        self.model_summary.setWordWrap(True)
        layout.addWidget(self.model_summary)
        self.preset.currentIndexChanged.connect(self.update_model_summary)
        self.update_model_summary()
        note = QLabel(f"全{page_count}ページ。PDFの先頭を1ページとして指定します。\n"
                      "文が前後のページへ続く場合は、つながるページも翻訳対象に含めます。\n"
                      "同じモデルでは保存済みの訳文を再利用します（effortの変更は次のAI処理から適用）。\n"
                      "モデルを変更すると指定ページを再翻訳し、指定外の訳文は引き継がれません。")
        note.setWordWrap(True)
        layout.addWidget(note)
        self.scope = QComboBox()
        self.scope.addItems(["全ページ", f"現在のページ（{current_page}ページ）", "ページを指定"])
        layout.addWidget(self.scope)
        self.page_input = QLineEdit()
        self.page_input.setPlaceholderText("例: 1, 3-5, 8")
        layout.addWidget(self.page_input)
        self.validation = QLabel()
        self.validation.setWordWrap(True)
        layout.addWidget(self.validation)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        self.start_button = buttons.button(QDialogButtonBox.StandardButton.Ok)
        self.start_button.setText("翻訳を開始")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("キャンセル")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.scope.currentIndexChanged.connect(self.validate_pages)
        self.page_input.textChanged.connect(self.validate_pages)
        if selected_pages and set(selected_pages) != set(range(1, page_count + 1)):
            self.scope.setCurrentIndex(2)
            self.page_input.setText(", ".join(str(p) for p in sorted(selected_pages)))
        self.validate_pages()

    def translation_settings(self):
        values = TRANSLATION_PRESETS.get(self.preset.currentData())
        if values:
            model, effort, _description = values
            return replace(self.connection_settings, model=model, reasoning_effort=effort)
        return replace(self.connection_settings)

    def update_model_summary(self, *_):
        settings = self.translation_settings()
        connection = "ChatGPT / Codex CLI" if settings.provider == "codex" else "設定済みのAPI接続"
        self.model_summary.setText(
            f"{connection}：{settings.model or '既定モデル'} / effort: {settings.reasoning_effort or '既定値'}\n"
            "今回の翻訳にのみ適用します。接続先・解説・質問の設定は変更しません。")

    def validate_pages(self, *_):
        self.page_input.setEnabled(self.scope.currentIndex() == 2)
        try:
            self.pages = (set(range(1, self.page_count + 1)) if self.scope.currentIndex() == 0 else
                          {self.current_page} if self.scope.currentIndex() == 1 else
                          parse_page_selection(self.page_input.text(), self.page_count))
            self.validation.setText(f"翻訳対象: {len(self.pages)}ページ")
            self.start_button.setEnabled(True)
        except ValueError as error:
            self.pages = set()
            self.validation.setText(str(error))
            self.start_button.setEnabled(False)

    def accept(self):
        self.validate_pages()
        if self.pages:
            super().accept()


class JobErrorDialog(QDialog):
    def __init__(self, message: str, parent=None):
        super().__init__(parent)
        self.setWindowTitle("処理を完了できませんでした")
        self.resize(640, 360)
        layout = QVBoxLayout(self)
        details = QPlainTextEdit()
        details.setReadOnly(True)
        details.setPlainText(message)
        details.setAccessibleName("エラー詳細")
        layout.addWidget(details)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        close_button = buttons.button(QDialogButtonBox.StandardButton.Close)
        close_button.setText("閉じる")
        close_button.setDefault(True)
        copy_button = buttons.addButton("エラーをコピー", QDialogButtonBox.ButtonRole.ActionRole)
        copy_button.setAutoDefault(False)

        def copy_error():
            QApplication.clipboard().setText(message)
            copy_button.setText("コピーしました")

        copy_button.clicked.connect(copy_error)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)


class SettingsDialog(QDialog):
    def __init__(self, current: Settings, parent=None):
        super().__init__(parent)
        self.setWindowTitle("AI接続の設定")
        self.setMinimumWidth(580)
        self.current = current
        layout = QVBoxLayout(self)
        note = QLabel("翻訳・解説・質問を実行すると、対象テキストが選択したAI接続へ送られます。")
        note.setWordWrap(True)
        layout.addWidget(note)
        form = QFormLayout()
        self.provider = QComboBox()
        self.provider.addItem("ChatGPT / Codex CLI", "codex")
        self.provider.addItem("API / ローカルモデル（OpenAI互換）", "api")
        self.provider.setCurrentIndex(0 if current.provider == "codex" else 1)
        self.model = QLineEdit(current.model)
        self.model.setPlaceholderText("空欄にするとCodexの既定モデル / API接続では必須")
        self.effort = QComboBox()
        captions = ["既定値（接続先に任せる）", "low — 少なめ", "medium — 標準", "high — 多め", "xhigh — さらに多め"]
        for value, caption in zip(REASONING_EFFORTS, captions):
            self.effort.addItem(caption, value)
        self.effort.setCurrentIndex(self.effort.findData(current.reasoning_effort))
        self.url = QLineEdit(current.base_url)
        self.key = QLineEdit(current.api_key)
        self.key.setEchoMode(QLineEdit.EchoMode.Password)
        self.key.setPlaceholderText("この起動中のみ保持 / PAPERDESK_API_KEYでも設定可")
        self.executable = QLineEdit(current.codex_path)
        self.executable.setPlaceholderText("通常は空欄で自動検出")
        form.addRow("接続先", self.provider)
        form.addRow("モデル", self.model)
        form.addRow("推論の強さ（effort）", self.effort)
        form.addRow("API URL", self.url)
        form.addRow("APIキー", self.key)
        form.addRow("Codexのパス", self.executable)
        layout.addLayout(form)
        effort_note = QLabel("effortを上げると推論に使う時間・トークンが増える場合があります。対応値はモデルによって異なります。\n"
                             "翻訳・解説・質問の新しいAI処理に適用します。翻訳済みの部分は引き続き再利用します。")
        effort_note.setWordWrap(True)
        effort_note.setObjectName("subtle")
        layout.addWidget(effort_note)
        info = QLabel("ローカル例: http://localhost:11434/v1（Ollama）\n"
                      "ChatGPT接続はCodexの利用権限と利用枠に従います。\n"
                      "APIキーでの利用は接続先の従量課金となる場合があります。")
        info.setWordWrap(True)
        info.setObjectName("subtle")
        layout.addWidget(info)
        self.provider.currentIndexChanged.connect(self.toggle_fields)
        self.toggle_fields()
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def toggle_fields(self):
        api = self.provider.currentData() == "api"
        self.url.setEnabled(api)
        self.key.setEnabled(api)
        self.executable.setEnabled(not api)

    def settings(self):
        return replace(self.current, provider=self.provider.currentData(), model=self.model.text().strip(),
                       base_url=self.url.text().strip(), api_key=self.key.text().strip(),
                       codex_path=self.executable.text().strip(), reasoning_effort=self.effort.currentData())


class Window(QMainWindow):
    translation_page_ready = Signal(str, int)
    def __init__(self, root: Path | None = None):
        super().__init__()
        self.root = root or data_directory()
        self.library = Library(self.root)
        self.settings = Settings.load(self.root)
        self.current_id = None
        self.current_collection = ""
        self.expanded_collections = None
        self.list_filtered = False
        self.move_history = []
        self.current_page = 0
        self.job = None
        self.busy_buttons = []
        self.setWindowTitle("PaperDesk — 日本語で論文を読む")
        self.setWindowIcon(app_icon())
        self.resize(1380, 880)
        self.setMinimumSize(1000, 680)
        self.setAcceptDrops(True)
        # Kept beside the library rather than in the registry, so PAPERDESK_DATA_DIR isolates it too.
        self.preferences = QSettings(str(self.root / "window.ini"), QSettings.Format.IniFormat)
        self.taskbar = winintegration.TaskbarProgress()
        self.tray = None
        # winId() creates the native window, so the shell can read the relaunch properties
        # that make "pin to taskbar" record PaperDesk rather than the Python interpreter.
        winintegration.apply_window_identity(self.window_handle())
        self.note_timer = QTimer(self)
        self.note_timer.setSingleShot(True)
        self.note_timer.timeout.connect(self.save_note)
        self.render_timer = QTimer(self)
        self.render_timer.setSingleShot(True)
        self.render_timer.timeout.connect(self.render_pages)
        self.translation_page_ready.connect(self.refresh_translation_page)
        self._build()
        self._build_tray()
        self.restore_layout()
        self.refresh_list()
        self.restore_reading()
        self.update_controls()

    def _build_tray(self):
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return
        self.tray = QSystemTrayIcon(app_icon(), self)
        self.tray.setToolTip("PaperDesk")
        menu = QMenu(self)
        show = QAction("PaperDeskを開く", self)
        show.triggered.connect(self.reveal)
        quit_action = QAction("終了", self)
        quit_action.triggered.connect(self.close)
        menu.addAction(show)
        menu.addSeparator()
        menu.addAction(quit_action)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(lambda reason: self.reveal()
                                    if reason == QSystemTrayIcon.ActivationReason.Trigger else None)
        self.tray.show()

    def reveal(self):
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def notify(self, title, message):
        """Toast the result of a long job when the user has looked away."""
        if self.tray and not self.isActiveWindow():
            self.tray.showMessage(title, message, app_icon(), 8000)

    def restore_layout(self):
        # saveGeometry already encodes the maximized state, so it is the only key needed here.
        geometry = self.preferences.value("window/geometry")
        if geometry:
            self.restoreGeometry(geometry)
        sizes = self.preferences.value("window/reader_split")
        if sizes:
            self.reader_split.setSizes([int(value) for value in sizes])
        state = self.preferences.value("window/library_split_state")
        if state:
            self.library_split.restoreState(state)
        expanded = self.preferences.value("library/expanded_collections")
        if expanded is not None:
            self.expanded_collections = {expanded} if isinstance(expanded, str) else set(expanded)

    def store_layout(self):
        self.preferences.setValue("window/geometry", self.saveGeometry())
        self.preferences.setValue("window/reader_split", self.reader_split.sizes())
        self.preferences.setValue("window/library_split_state", self.library_split.saveState())
        self.preferences.setValue("library/sort", self.sort_order.currentIndex())
        expanded = self.expanded_collections if self.list_filtered else self._expanded_collection_paths()
        self.preferences.setValue("library/expanded_collections", sorted(expanded or set()))
        self.remember_reading()

    def remember_reading(self):
        if self.current_id:
            self.preferences.setValue(f"reading/{self.current_id}", self.current_page)
            self.preferences.setValue("reading/last_paper", self.current_id)

    def saved_page(self, identity):
        try:
            return max(0, int(self.preferences.value(f"reading/{identity}", 0)))
        except (TypeError, ValueError):
            return 0

    def restore_reading(self):
        identity = self.preferences.value("reading/last_paper")
        if identity:
            try:
                self.select_paper(identity)
                self.status_label.setText(f"前回の続き：{self.current_page + 1}ページから再開しました。")
            except (KeyError, ValueError, OSError):
                self.status_label.setText("前回のPDFを開けませんでした。ライブラリから選択してください。")

    def clear_library_filters(self):
        self.search.blockSignals(True)
        self.search.clear()
        self.search.blockSignals(False)
        self.refresh_list()

    def reveal_current_paper(self):
        self.focus_search()
        if not self.current_id:
            return
        self.clear_library_filters()
        item = self._paper_tree_item(self.current_id)
        if item:
            parent = item.parent()
            while parent:
                parent.setExpanded(True)
                parent = parent.parent()
            self.paper_list.scrollToItem(item)
            self.paper_list.setFocus()

    def focus_search(self):
        if self.focus_button.isChecked():
            self.focus_button.click()
        self.sidebar_button.setChecked(True)
        self.toggle_sidebar(True)
        self.search.setFocus()
        self.search.selectAll()

    def focus_page(self):
        if self.current_id:
            self.tabs.setCurrentIndex(0)
            self.page_input.setFocus()
            self.page_input.selectAll()

    def button(self, text, action, primary=False, busy=True):
        button = QPushButton(text)
        button.clicked.connect(action)
        if primary:
            button.setObjectName("primary")
        if busy:
            self.busy_buttons.append(button)
        return button

    def _build(self):
        central = QWidget()
        self.setCentralWidget(central)
        outer = QHBoxLayout(central)
        outer.setContentsMargins(6, 6, 6, 6)
        sidebar = self.sidebar = QFrame()
        sidebar.setObjectName("sidebar")
        sidebar.setMinimumWidth(200)
        left = QVBoxLayout(sidebar)
        left.setContentsMargins(10, 10, 10, 10)
        brand = QLabel("PaperDesk")
        brand.setObjectName("brand")
        left.addWidget(brand)
        self.import_button = self.button("＋ PDFを追加", self.import_pdfs, True)
        left.addWidget(self.import_button)
        self.import_target_label = CompactLabel("追加先：未分類")
        left.addWidget(self.import_target_label)
        self.search = QLineEdit()
        self.search.setClearButtonEnabled(True)
        self.search.setToolTip("タイトル・ファイル名・本文・メモ・フォルダー名を検索（Ctrl+F）")
        self.search.setPlaceholderText("タイトル・本文・メモを検索")
        self.search.textChanged.connect(self.refresh_list)
        left.addWidget(self.search)
        self.sort_order = QComboBox()
        self.sort_order.addItems(["追加が新しい順", "追加が古い順", "名前順（昇順）", "名前順（降順）"])
        self.sort_order.setCurrentIndex(int(self.preferences.value("library/sort", 0)))
        self.sort_order.currentIndexChanged.connect(self.refresh_list)
        left.addWidget(self.sort_order)
        self.paper_list = LibraryTree()
        self.paper_list.installEventFilter(self)
        self.paper_list.viewport().installEventFilter(self)
        self.paper_list.paper_moved.connect(self.move_paper)
        self.paper_list.files_dropped.connect(self.import_paths)
        self.paper_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.paper_list.customContextMenuRequested.connect(self.show_library_menu)
        self.paper_list.setToolTip("右クリックで名前変更・子フォルダー作成。PDFをドラッグして移動（F2：名前変更）")
        self.paper_list.setHeaderHidden(True)
        self.paper_list.setIndentation(16)
        self.paper_list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.paper_list.currentItemChanged.connect(self.select_item)
        self.paper_list.setWordWrap(True)
        left.addWidget(self.paper_list, 1)
        self.empty_library_label = QLabel()
        self.empty_library_label.setWordWrap(True)
        left.addWidget(self.empty_library_label)
        self.clear_filters_button = self.button("検索・絞り込みを解除", self.clear_library_filters, busy=False)
        left.addWidget(self.clear_filters_button)
        self.count_label = QLabel()
        left.addWidget(self.count_label)
        settings_button = QPushButton("接続・設定")
        settings_menu = QMenu(settings_button)
        for caption, callback in [("AI接続の設定", self.configure), ("ChatGPTにログイン", self.login),
                                  ("接続を確認", self.check_connection)]:
            action = settings_menu.addAction(caption)
            action.triggered.connect(callback)
            self.busy_buttons.append(action)
        if winintegration.WINDOWS:
            settings_menu.addSeparator()
            settings_menu.addAction("スタートメニューに追加", self.install_shortcuts)
        settings_button.setMenu(settings_menu)
        left.addWidget(settings_button)
        self.library_split = QSplitter(Qt.Orientation.Horizontal)
        self.library_split.setChildrenCollapsible(False)
        self.library_split.setHandleWidth(10)
        self.library_split.addWidget(sidebar)
        content = QWidget()
        content.setMinimumWidth(700)
        right = QVBoxLayout(content)
        right.setContentsMargins(0, 0, 0, 0)
        right.setSpacing(4)
        self.reader_header = QWidget()
        toolbar = QHBoxLayout(self.reader_header)
        toolbar.setContentsMargins(0, 0, 0, 0)
        self.sidebar_button = self.button("ライブラリ", self.toggle_sidebar, busy=False)
        self.sidebar_button.setCheckable(True)
        self.sidebar_button.setChecked(True)
        self.sidebar_button.setToolTip("左パネルの表示を切り替え")
        toolbar.addWidget(self.sidebar_button)
        self.title_label = CompactLabel("論文を追加して、読み始めよう")
        self.title_label.setObjectName("title")
        toolbar.addWidget(self.title_label, 1)
        self.meta_label = CompactLabel("PDFを追加 → AI接続を設定 → 翻訳・解説・質問")
        self.meta_label.setObjectName("subtle")
        self.translate_button = self.button("翻訳 / 再開", self.translate, True)
        toolbar.addWidget(self.translate_button)
        more = QPushButton("その他")
        self.document_menu = QMenu(more)
        self.article_button = self.document_menu.addAction("解説を作成", self.generate_article)
        self.export_button = self.document_menu.addAction("PDFを書き出す", self.export_pdf)
        self.busy_buttons.extend([self.article_button, self.export_button])
        more.setMenu(self.document_menu)
        toolbar.addWidget(more)
        right.addWidget(self.reader_header)
        self.tabs = QTabWidget()
        self.tabs.currentChanged.connect(self.tab_changed)
        self._reader_tab()
        self._article_tab()
        self._ask_tab()
        self._notes_tab()
        right.addWidget(self.tabs, 1)
        self.status_bar = QWidget()
        status = QHBoxLayout(self.status_bar)
        status.setContentsMargins(0, 0, 0, 0)
        self.status_label = CompactLabel("準備できました。PDFの追加・閲覧・メモ保存にはAI接続は不要です。")
        self.status_label.setObjectName("subtle")
        status.addWidget(self.status_label, 1)
        self.undo_move_button = self.button("移動を戻す", self.undo_move, busy=False)
        self.undo_move_button.setEnabled(False)
        self.undo_move_button.setToolTip("今回の起動中に行った分類移動を、直前のものから取り消します。")
        status.addWidget(self.undo_move_button)
        self.cancel_button = self.button("中止", self.cancel_job, busy=False)
        self.cancel_button.hide()
        status.addWidget(self.cancel_button)
        right.addWidget(self.status_bar)
        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 0)
        self.progress_bar.hide()
        right.addWidget(self.progress_bar)
        self.library_split.addWidget(content)
        self.library_split.setSizes([230, 1138])
        self.library_split.setStretchFactor(0, 0)
        self.library_split.setStretchFactor(1, 1)
        self.library_split.splitterMoved.connect(lambda *_: self.render_timer.start(150))
        self.library_split.handle(1).setToolTip("ドラッグして左パネルの幅を変更")
        outer.addWidget(self.library_split)
        for key, callback in [("F2", self.rename_selected), ("Ctrl+Shift+N", self.create_child_folder)]:
            action = QAction(self.paper_list)
            action.setShortcut(QKeySequence(key))
            action.setShortcutContext(Qt.ShortcutContext.WidgetShortcut)
            action.triggered.connect(callback)
            self.paper_list.addAction(action)
        for key, callback in [("Ctrl+O", self.import_pdfs), ("Ctrl+F", self.focus_search),
                              ("Ctrl+L", self.reveal_current_paper), ("Ctrl+G", self.focus_page)]:
            action = QAction(self)
            action.setShortcut(QKeySequence(key))
            action.triggered.connect(callback)
            self.addAction(action)
            if key == "Ctrl+O":
                self.busy_buttons.append(action)

    def tab_changed(self, index):
        if index != 0 and self.focus_button.isChecked():
            self.focus_button.setChecked(False)
            self.toggle_reading_focus(False)
        self.render_timer.start(50)

    def toggle_sidebar(self, checked):
        self.sidebar.setVisible(checked)
        self.render_timer.start(50)

    def toggle_reading_focus(self, checked):
        if checked:
            self.tabs.setCurrentIndex(0)
        self.reader_header.setVisible(not checked)
        self.tabs.tabBar().setVisible(not checked)
        self.status_bar.setVisible(not checked or bool(self.job and self.job.isRunning()))
        self.sidebar.setVisible(not checked and self.sidebar_button.isChecked())
        self.focus_button.setText("集中表示を終了" if checked else "集中表示")
        self.render_timer.start(50)

    def _reader_tab(self):
        reader = QWidget()
        layout = QVBoxLayout(reader)
        layout.setContentsMargins(4, 4, 4, 4)
        layout.setSpacing(4)
        nav = QHBoxLayout()
        nav.setSpacing(4)
        nav.addWidget(self.button("←", lambda: self.move_page(-1), busy=False))
        self.page_input = QSpinBox()
        self.page_input.setFixedWidth(54)
        self.page_input.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        self.page_input.setRange(1, 1)
        self.page_input.setKeyboardTracking(False)
        self.page_input.setToolTip("ページ番号を入力し、Enterで移動（Ctrl+G）")
        self.page_input.editingFinished.connect(self.jump_to_page)
        nav.addWidget(self.page_input)
        self.jump_button = self.button("移動", self.jump_to_page, busy=False)
        nav.addWidget(self.jump_button)
        nav.addWidget(self.button("→", lambda: self.move_page(1), busy=False))
        self.page_label = CompactLabel("—")
        nav.addWidget(self.page_label, 1)
        self.page_filter = QComboBox()
        self.page_filter.addItems(["全ページ", "翻訳済みページのみ"])
        self.page_filter.setToolTip("表示するページ")
        self.page_filter.currentIndexChanged.connect(self.render_pages)
        nav.addWidget(self.page_filter)
        self.zoom_out_button = self.button("−", lambda: self.change_zoom(-1), busy=False)
        self.zoom_out_button.setToolTip("原文・日本語訳を縮小（Ctrl＋マウスホイール下）")
        nav.addWidget(self.zoom_out_button)
        self.zoom = QComboBox()
        for caption, factor in [("幅に合わせる", 1), ("125%", 1.25), ("150%", 1.5),
                                ("200%", 2), ("250%", 2.5), ("300%", 3), ("400%", 4)]:
            self.zoom.addItem(caption, factor)
        self.zoom.setToolTip("原文・日本語訳の共通倍率（幅に合わせた表示が基準）")
        self.zoom.currentIndexChanged.connect(self.render_pages)
        nav.addWidget(self.zoom)
        self.zoom_in_button = self.button("＋", lambda: self.change_zoom(1), busy=False)
        self.zoom_in_button.setToolTip("原文・日本語訳を拡大（Ctrl＋マウスホイール上）")
        nav.addWidget(self.zoom_in_button)
        self.focus_button = self.button("集中表示", self.toggle_reading_focus, busy=False)
        self.focus_button.setCheckable(True)
        self.focus_button.setToolTip("PDFとページ操作を大きく表示（F11で切り替え）")
        nav.addWidget(self.focus_button)
        focus_action = QAction(self)
        focus_action.setShortcut(QKeySequence("F11"))
        focus_action.triggered.connect(self.focus_button.click)
        self.addAction(focus_action)
        self.document_menu.addSeparator()
        self.external_pdf_buttons = {}
        for name, caption in [("original.pdf", "原文を外部で開く"),
                              ("translated.pdf", "日本語訳を外部で開く"),
                              ("interleaved.pdf", "原文・日本語訳（交互）を外部で開く")]:
            action = self.document_menu.addAction(caption, lambda checked=False, name=name: self.open_file(name))
            self.external_pdf_buttons[name] = action
        self.document_menu.addSeparator()
        self.document_menu.addAction("エクスプローラーで開く", self.open_folder)
        layout.addLayout(nav)
        splitter = self.reader_split = QSplitter(Qt.Orientation.Horizontal)
        self.pdf_labels, self.pdf_scrolls, self.pdf_captions = [], [], []
        self._pinch_start_zoom = None
        self._native_pinch_zoom = None
        for caption in ["原文", "日本語訳"]:
            container = QWidget()
            pane = QVBoxLayout(container)
            pane.setContentsMargins(0, 0, 0, 0)
            pane.setSpacing(2)
            label = QLabel(caption)
            label.setObjectName("subtle")
            self.pdf_captions.append(label)
            pane.addWidget(label)
            scroll = QScrollArea()
            scroll.installEventFilter(self)
            scroll.viewport().installEventFilter(self)
            scroll.viewport().setAttribute(Qt.WidgetAttribute.WA_AcceptTouchEvents)
            scroll.viewport().grabGesture(Qt.GestureType.PinchGesture)
            scroll.setToolTip("ピンチアウト／ピンチイン、またはCtrl＋ホイールで左右を同時に拡大・縮小")
            scroll.setWidgetResizable(False)
            image = QLabel("PDFを追加してください" if caption == "原文" else "「日本語に翻訳」で訳文を作成")
            image.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignHCenter)
            image.setMargin(3)
            scroll.setWidget(image)
            pane.addWidget(scroll)
            splitter.addWidget(container)
            self.pdf_labels.append(image)
            self.pdf_scrolls.append(scroll)
        self.pdf_scroll_links = [
            LinkedScrollBars([scroll.verticalScrollBar() for scroll in self.pdf_scrolls], self),
            LinkedScrollBars([scroll.horizontalScrollBar() for scroll in self.pdf_scrolls], self),
        ]
        splitter.setSizes([600, 600])
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 1)
        splitter.splitterMoved.connect(lambda *_: self.render_timer.start(150))
        layout.addWidget(splitter, 1)
        self.tabs.addTab(reader, "PDFを読む")

    def browser(self):
        browser = LocalTextBrowser()
        browser.setOpenLinks(False)
        browser.setOpenExternalLinks(False)
        browser.anchorClicked.connect(self.follow_citation)
        browser.document().setDefaultStyleSheet("body {line-height:1.65;} a {color:#285ee6;} h1,h2,h3 {color:#233c61;}")
        return browser

    def _article_tab(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        self.article_view = self.browser()
        self.article_view.setMarkdown("## 論文の理解を、もう一歩深く\n\n「解説を作成」で、目的・手法・結果・限界を日本語で整理します。")
        layout.addWidget(self.article_view)
        layout.addWidget(self.button("解説をMarkdownで保存", lambda: self.export_text("article.md"), busy=False))
        self.tabs.addTab(widget, "解説")

    def _ask_tab(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        self.chat_view = self.browser()
        layout.addWidget(self.chat_view, 1)
        self.all_papers = QCheckBox("保存したほかの論文も検索する")
        layout.addWidget(self.all_papers)
        input_row = QHBoxLayout()
        self.question = QLineEdit()
        self.question.setPlaceholderText("例：従来手法と比べた改善点と、実験の限界は？")
        self.question.returnPressed.connect(self.ask)
        input_row.addWidget(self.question, 1)
        self.ask_button = self.button("質問する", self.ask, True)
        input_row.addWidget(self.ask_button)
        layout.addLayout(input_row)
        self.tabs.addTab(widget, "質問")

    def _notes_tab(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.addWidget(self.meta_label)
        form = QFormLayout()
        self.edit_title = QLineEdit()
        self.edit_author = QLineEdit()
        self.edit_year = QLineEdit()
        self.edit_author.setPlaceholderText("例：Smith / 山田太郎")
        self.edit_year.setPlaceholderText("例：2024（不明なら空欄）")
        self.edit_year.setMaxLength(4)
        self.collection = QLineEdit()
        self.collection.setPlaceholderText("例：制御工学 / 読書会")
        form.addRow("タイトル", self.edit_title)
        form.addRow("筆頭著者", self.edit_author)
        form.addRow("出版年", self.edit_year)
        form.addRow("フォルダー", self.collection)
        layout.addLayout(form)
        folder_hint = QLabel("「/」で区切るとサブフォルダーになります。例：制御工学 / 読書会")
        folder_hint.setObjectName("subtle")
        folder_hint.setWordWrap(True)
        layout.addWidget(folder_hint)
        self.save_metadata_button = self.button("論文情報・フォルダーを保存", self.save_metadata, busy=False)
        layout.addWidget(self.save_metadata_button)
        layout.addWidget(QLabel("メモ / Markdownで記入できます。入力後に自動保存します。"))
        self.note = QPlainTextEdit()
        self.note.textChanged.connect(lambda: self.note_timer.start(600))
        layout.addWidget(self.note, 1)
        layout.addWidget(self.button("保存フォルダーを開く", self.open_folder, busy=False))
        self.tabs.addTab(widget, "メモ・整理")

    def refresh_list(self, *_):
        keep = self.current_id
        selected_before = self.paper_list.currentItem()
        selected_folder = (selected_before.data(0, COLLECTION_ROLE) if selected_before
                           and selected_before.data(0, ITEM_KIND_ROLE) == "folder" else None)
        filtered = bool(self.search.text().strip())
        if not self.list_filtered and self.paper_list.topLevelItemCount():
            self.expanded_collections = self._expanded_collection_paths()
        expanded = self.expanded_collections
        self.paper_list.blockSignals(True)
        self.paper_list.clear_drop_target()
        self.paper_list.clear()
        papers = self.library.papers(self.search.text())
        order = self.sort_order.currentIndex()
        if order == 1:
            papers.reverse()
        elif order in (2, 3):
            papers.sort(key=lambda paper: paper["title"].casefold(), reverse=order == 3)
        grouped = {}
        for paper in papers:
            path = normalize_collection_name(paper["collection_name"])
            grouped.setdefault(path, []).append(paper)

        folder_items = {}
        paths = {path for path in grouped if path}
        if not filtered:
            paths.update(self.library.collections())
        paths.update(" / ".join(path.split(" / ")[:depth])
                     for path in list(paths) for depth in range(1, len(path.split(" / "))))
        for path in sorted(paths, key=lambda value: (len(value.split(" / ")), value.casefold())):
            parts = path.split(" / ")
            parent_path = " / ".join(parts[:-1])
            item = QTreeWidgetItem([parts[-1]])
            item.setData(0, ITEM_KIND_ROLE, "folder")
            item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsDragEnabled)
            item.setData(0, COLLECTION_ROLE, path)
            item.setToolTip(0, path)
            if parent_path:
                folder_items[parent_path].addChild(item)
            else:
                self.paper_list.addTopLevelItem(item)
            folder_items[path] = item

        if (not self.search.text().strip()) or "" in grouped:
            unfiled = QTreeWidgetItem(["未分類"])
            unfiled.setData(0, ITEM_KIND_ROLE, "folder")
            unfiled.setFlags(unfiled.flags() & ~Qt.ItemFlag.ItemIsDragEnabled)
            unfiled.setData(0, COLLECTION_ROLE, "")
            unfiled.setToolTip(0, "フォルダー未指定のPDF")
            self.paper_list.addTopLevelItem(unfiled)
            folder_items[""] = unfiled

        selected = None
        for path, folder in folder_items.items():
            for paper in grouped.get(path, []):
                text = paper_display_name(paper)
                text += f"\n{paper['pages']}ページ · {paper['status']}"
                item = QTreeWidgetItem([text])
                item.setData(0, PAPER_ROLE, paper["id"])
                item.setData(0, ITEM_KIND_ROLE, "paper")
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsDropEnabled)
                item.setData(0, COLLECTION_ROLE, path)
                item.setToolTip(0, f"{paper_display_name(paper)}\nファイル名：{paper['original_name']}")
                folder.addChild(item)
                if paper["id"] == keep:
                    selected = item

        def label_folder(item):
            count = 0
            for index in range(item.childCount()):
                child = item.child(index)
                count += 1 if child.data(0, ITEM_KIND_ROLE) == "paper" else label_folder(child)
            name = item.data(0, COLLECTION_ROLE).split(" / ")[-1] or "未分類"
            item.setText(0, f"{name}  ({count})")
            item.setIcon(0, self.style().standardIcon(QStyle.StandardPixmap.SP_DirIcon))
            return count

        for index in range(self.paper_list.topLevelItemCount()):
            label_folder(self.paper_list.topLevelItem(index))
        if selected_folder in folder_items:
            self.paper_list.setCurrentItem(folder_items[selected_folder])
        elif selected:
            self.paper_list.setCurrentItem(selected)
        # Qt may expand ancestors when restoring the current row; apply the user's
        # expansion state afterwards so clearing a search really restores it.
        if filtered or expanded is None:
            self.paper_list.expandAll()
        else:
            for path, item in folder_items.items():
                item.setExpanded(path in expanded)
        self.paper_list.blockSignals(False)
        self.list_filtered = filtered
        if not filtered:
            self.expanded_collections = self._expanded_collection_paths()
        self.count_label.setText(f"{len(papers)} 件の論文")
        self.empty_library_label.setText("見つかりませんでした。検索語や絞り込みを変更してください。" if filtered
                                         else "PDFを追加するか、フォルダーへドロップして読み始めましょう。")
        self.empty_library_label.setVisible(not papers)
        self.clear_filters_button.setVisible(filtered)

    def create_child_folder(self, _checked=False, parent=None):
        if parent is None:
            item = self.paper_list.currentItem()
            parent = item.data(0, COLLECTION_ROLE) if item else ""
        self.create_folder(parent=parent)

    def create_folder(self, _checked=False, parent=None):
        name, accepted = QInputDialog.getText(
            self, "フォルダーを作成", f"「{parent or 'ライブラリ'}」内のフォルダー名" if parent is not None else "フォルダー名（ / でサブフォルダーを指定）",
            text="" if parent is not None else (f"{self.current_collection} / " if self.current_collection else ""))
        if not accepted:
            return
        try:
            if not normalize_collection_name(name):
                raise ValueError("フォルダー名を入力してください。")
            if parent:
                name = parent + " / " + name
            if normalize_collection_name(name) in self.library.collections():
                raise ValueError("同じ名前のフォルダーが既にあります。")
            path = self.library.create_collection(name)
        except (ValueError, sqlite3.Error) as error:
            QMessageBox.warning(self, "フォルダーを作成できませんでした", str(error))
            return
        self.clear_library_filters()
        pending = [self.paper_list.topLevelItem(i) for i in range(self.paper_list.topLevelItemCount())]
        while pending:
            item = pending.pop()
            if item.data(0, ITEM_KIND_ROLE) == "folder" and item.data(0, COLLECTION_ROLE) == path:
                self.paper_list.setCurrentItem(item)
                item.setExpanded(True)
                parent = item.parent()
                while parent:
                    parent.setExpanded(True)
                    parent = parent.parent()
                self.paper_list.scrollToItem(item)
                break
            pending.extend(item.child(i) for i in range(item.childCount()))
        self.status_label.setText(f"「{path}」を作成しました。PDFをドロップして追加できます。")

    def show_library_menu(self, position):
        item = self.paper_list.itemAt(position)
        if not item or item.data(0, ITEM_KIND_ROLE) == "folder":
            path = item.data(0, COLLECTION_ROLE) if item else ""
            menu = QMenu(self)
            menu.addAction("子フォルダーを作成…" if path else "フォルダーを作成…",
                           lambda: self.create_child_folder(parent=path))
            if path:
                menu.addAction("名前を変更…", lambda: self.rename_folder(path))
                action = menu.addAction("フォルダーを削除", lambda: self.delete_folder(path))
                action.setEnabled(not (self.job and self.job.isRunning()))
            menu.exec(self.paper_list.viewport().mapToGlobal(position))
            menu.deleteLater()
            return
        # Capture identifiers: refreshing after an action destroys tree items.
        identity = item.data(0, PAPER_ROLE)
        current = item.data(0, COLLECTION_ROLE)
        menu = QMenu(self)
        destinations = menu.addMenu("分類を変更")
        paths = set(self.library.collections())
        for path in [""] + sorted(paths - {""}, key=str.casefold):
            action = destinations.addAction((path or "未分類").replace("&", "&&"))
            action.setCheckable(True)
            action.setChecked(path == current)
            action.triggered.connect(lambda _checked=False, path=path: self.move_paper(identity, path))
        destinations.addSeparator()
        create = destinations.addAction("新しい分類を入力…")
        create.triggered.connect(lambda: self.choose_new_collection(identity, current))
        menu.addSeparator()
        menu.addAction("ファイル名を変更…", lambda: self.rename_file(identity))
        menu.addAction("原文PDFを開く", lambda: QDesktopServices.openUrl(
            QUrl.fromLocalFile(str(self.library.folder(identity) / "original.pdf"))))
        menu.addAction("原文PDFを名前を付けて保存…", lambda: self.save_original(identity))
        menu.addAction("保存フォルダーを開く", lambda: QDesktopServices.openUrl(
            QUrl.fromLocalFile(str(self.library.folder(identity)))))
        menu.exec(self.paper_list.viewport().mapToGlobal(position))
        menu.deleteLater()

    def rename_selected(self):
        item = self.paper_list.currentItem()
        if item and item.data(0, ITEM_KIND_ROLE) == "paper":
            self.rename_file(item.data(0, PAPER_ROLE))
        elif item and item.data(0, COLLECTION_ROLE):
            self.rename_folder(item.data(0, COLLECTION_ROLE))

    def rename_file(self, identity):
        paper = self.library.paper(identity)
        name, accepted = QInputDialog.getText(self, "ファイル名を変更", "新しいファイル名（.pdfは自動で付きます）", text=paper["original_name"])
        if not accepted:
            return
        try:
            name = self.library.rename_paper(identity, name)
        except (ValueError, KeyError, sqlite3.Error) as error:
            QMessageBox.warning(self, "名前を変更できませんでした", str(error))
            return
        if identity == self.current_id:
            self.title_label.setText(paper_display_name(self.library.paper(identity)))
            self.edit_title.setText(name[:-4])
        self.refresh_list()
        self.status_label.setText(f"ファイル名を「{name}」に変更しました。取り込み元のファイル名は変更されません。")

    def rename_folder(self, path):
        selected = self.paper_list.currentItem()
        selected_path = (selected.data(0, COLLECTION_ROLE) if selected
                         and selected.data(0, ITEM_KIND_ROLE) == "folder" else None)
        name, accepted = QInputDialog.getText(self, "フォルダー名を変更", "新しい名前", text=path.split(" / ")[-1])
        if not accepted:
            return
        try:
            destination = self.library.rename_collection(path, name)
        except (ValueError, sqlite3.Error) as error:
            QMessageBox.warning(self, "名前を変更できませんでした", str(error))
            return
        def mapped(value):
            return destination + value[len(path):] if value == path or value.startswith(path + " / ") else value
        self.current_collection = mapped(self.current_collection)
        self.collection.setText(mapped(normalize_collection_name(self.collection.text())))
        self.move_history = [(identity, mapped(old), mapped(new)) for identity, old, new in self.move_history]
        expanded = self.expanded_collections if self.list_filtered else self._expanded_collection_paths()
        self.expanded_collections = {mapped(value) for value in expanded or set()}
        # Prevent refresh from replacing the remapped expansion paths with old rows.
        self.list_filtered = True
        self.refresh_list()
        if selected_path is not None:
            pending = [self.paper_list.topLevelItem(i) for i in range(self.paper_list.topLevelItemCount())]
            while pending:
                item = pending.pop()
                if item.data(0, ITEM_KIND_ROLE) == "folder" and item.data(0, COLLECTION_ROLE) == mapped(selected_path):
                    self.paper_list.setCurrentItem(item)
                    break
                pending.extend(item.child(i) for i in range(item.childCount()))
        self.import_target_label.setText(f"追加先：{self.current_collection or '未分類'}")
        self.import_button.setToolTip(f"追加するPDFを「{self.current_collection or '未分類'}」へ入れます。")
        self.status_label.setText(f"「{path}」を「{destination}」に変更しました。")

    def delete_folder(self, path):
        if self.job and self.job.isRunning():
            return
        path = normalize_collection_name(path)
        def inside(value):
            value = normalize_collection_name(value)
            return value == path or value.startswith(path + " / ")
        try:
            count = sum(inside(paper["collection_name"]) for paper in self.library.papers())
            if count:
                answer = QMessageBox.question(
                    self, "フォルダーを削除",
                    f"「{path}」には、子フォルダーを含めて{count}件の論文が入っています。\n"
                    "フォルダーを削除しますか？\n論文はすべて未分類へ移動します。",
                    QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                    QMessageBox.StandardButton.Cancel)
                if answer != QMessageBox.StandardButton.Ok:
                    return
            moved = self.library.delete_collection(path)
        except (ValueError, sqlite3.Error) as error:
            QMessageBox.warning(self, "フォルダーを削除できませんでした", str(error))
            return
        if inside(self.current_collection):
            self.current_collection = ""
        if self.current_id in moved or inside(self.collection.text()):
            self.collection.clear()
        # Old move history must not recreate the deleted subtree.
        self.move_history = [(identity, old, new) for identity, old, new in self.move_history
                             if identity not in moved and not inside(old) and not inside(new)]
        self.undo_move_button.setEnabled(bool(self.move_history))
        expanded = self.expanded_collections if self.list_filtered else self._expanded_collection_paths()
        self.expanded_collections = {value for value in expanded or set() if not inside(value)}
        self.list_filtered = True
        self.refresh_list()
        self.import_target_label.setText(f"追加先：{self.current_collection or '未分類'}")
        self.import_button.setToolTip(f"追加するPDFを「{self.current_collection or '未分類'}」へ入れます。")
        self.status_label.setText(f"「{path}」を削除しました。" + (f"{len(moved)}件の論文を未分類へ移動しました。" if moved else ""))

    def save_original(self, identity):
        paper = self.library.paper(identity)
        path, _ = QFileDialog.getSaveFileName(self, "原文PDFを保存", paper["original_name"], "PDF (*.pdf)")
        if path:
            try:
                shutil.copyfile(self.library.folder(identity) / "original.pdf", path)
            except OSError as error:
                QMessageBox.warning(self, "保存できませんでした", str(error))
                return
            self.status_label.setText(f"原文PDFを保存しました：{path}")

    def choose_new_collection(self, identity, current):
        name, accepted = QInputDialog.getText(
            self, "新しい分類", "フォルダー名（例：制御工学 / 読書会）", text=current)
        if accepted and normalize_collection_name(name):
            self.move_paper(identity, name)

    def move_paper(self, identity, collection, record_history=True):
        collection = normalize_collection_name(collection)
        try:
            previous = self.library.paper(identity)["collection_name"]
            if normalize_collection_name(previous) == collection:
                return False
            self.library.update(identity, collection_name=collection)
        except (KeyError, ValueError, OSError, sqlite3.Error) as error:
            QMessageBox.warning(self, "分類を変更できませんでした", str(error))
            return False
        if record_history:
            self.move_history.append((identity, previous, collection))
            self.undo_move_button.setEnabled(True)
        if identity == self.current_id:
            self.collection.setText(collection)
            self.current_collection = collection
            self.import_target_label.setText(f"追加先：{collection or '未分類'}")
            self.import_button.setToolTip(f"追加するPDFを「{collection or '未分類'}」へ入れます。")
        self.refresh_list()
        item = self._paper_tree_item(identity)
        if item:
            parent = item.parent()
            while parent:
                parent.setExpanded(True)
                parent = parent.parent()
            self.paper_list.scrollToItem(item)
        self.status_label.setText(f"「{collection or '未分類'}」へ移動しました。")
        return True

    def undo_move(self):
        if not self.move_history:
            return
        identity, previous, destination = self.move_history[-1]
        # Do not overwrite a later edit made through the metadata form.
        if normalize_collection_name(self.library.paper(identity)["collection_name"]) != destination:
            self.move_history.pop()
            self.status_label.setText("分類が別の操作で変更されています。この移動は取り消せません。")
        elif self.move_paper(identity, previous, record_history=False):
            self.move_history.pop()
            self.status_label.setText(f"移動を取り消しました：{previous or '未分類'}")
        self.undo_move_button.setEnabled(bool(self.move_history))

    def select_item(self, item, _previous=None):
        if not item:
            return
        if item.data(0, ITEM_KIND_ROLE) == "folder":
            self.current_collection = item.data(0, COLLECTION_ROLE)
            self.import_target_label.setText(
                f"追加先：{self.current_collection or '未分類'}")
            self.import_button.setToolTip(
                f"追加するPDFを「{self.current_collection or '未分類'}」へ入れます。")
            return
        self.current_collection = item.data(0, COLLECTION_ROLE)
        self.import_target_label.setText(
            f"追加先：{self.current_collection or '未分類'}")
        self.import_button.setToolTip(
            f"追加するPDFを「{self.current_collection or '未分類'}」へ入れます。")
        self.select_paper(item.data(0, PAPER_ROLE))

    def _expanded_collection_paths(self):
        paths = set()
        iterator = self.paper_list.invisibleRootItem()
        pending = [iterator.child(index) for index in range(iterator.childCount())]
        while pending:
            item = pending.pop()
            if item.data(0, ITEM_KIND_ROLE) == "folder":
                if item.isExpanded():
                    paths.add(item.data(0, COLLECTION_ROLE))
                pending.extend(item.child(index) for index in range(item.childCount()))
        return paths

    def _paper_tree_item(self, paper_id):
        pending = [self.paper_list.topLevelItem(index)
                   for index in range(self.paper_list.topLevelItemCount())]
        while pending:
            item = pending.pop()
            if item.data(0, PAPER_ROLE) == paper_id:
                return item
            pending.extend(item.child(index) for index in range(item.childCount()))
        return None

    def select_paper(self, paper_id, page=None):
        self.save_note()
        self.remember_reading()
        paper = self.library.paper(paper_id)
        page = self.saved_page(paper_id) if page is None else page
        self.current_id = paper_id
        self.current_page = max(0, min(page, paper["pages"] - 1))
        self.page_input.setRange(1, paper["pages"])
        self.page_input.setValue(self.current_page + 1)
        self.remember_reading()
        self.current_collection = normalize_collection_name(paper["collection_name"])
        tree_item = self._paper_tree_item(paper_id)
        if tree_item and self.paper_list.currentItem() is not tree_item:
            self.paper_list.blockSignals(True)
            self.paper_list.setCurrentItem(tree_item)
            self.paper_list.blockSignals(False)
        if tree_item:
            parent = tree_item.parent()
            while parent:
                parent.setExpanded(True)
                parent = parent.parent()
        self.import_button.setToolTip(
            f"追加するPDFを「{self.current_collection or '未分類'}」へ入れます。")
        self.import_target_label.setText(
            f"追加先：{self.current_collection or '未分類'}")
        self.title_label.setText(paper_display_name(paper))
        self.edit_title.setText(paper["title"])
        self.edit_author.setText(paper["first_author"])
        self.edit_year.setText(paper["publication_year"])
        self.collection.setText(paper["collection_name"])
        self.note.blockSignals(True)
        self.note.setPlainText(paper["note"])
        self.note.blockSignals(False)
        self.note_timer.stop()
        info = self.library.document(paper_id)
        extra = f" / 文字のないページ: {', '.join(map(str, info['empty_pages']))}" if info["empty_pages"] else ""
        # Scan pages are retained, but never silently presented as translated text.
        self.meta_label.setText(f"{paper['pages']} ページ / {paper['status']}{extra}")
        folder = self.library.folder(paper_id)
        report_path = folder / "translation-report.json"
        if report_path.exists():
            report = json.loads(report_path.read_text("utf-8"))
            if report.get("scaled_blocks"):
                self.meta_label.setText(self.meta_label.text() + f" / {report['scaled_blocks']}ブロックの長い訳文を縮小表示")
            if report.get("readability_warnings"):
                small_pages = sorted({item["page"] for item in report["readability_warnings"]})
                self.meta_label.setText(self.meta_label.text() + f" / 小さい文字のあるページ: {len(small_pages)}ページ")
                self.meta_label.setToolTip("拡大して確認してください: p." + ", ".join(map(str, small_pages)))
            else:
                self.meta_label.setToolTip("")
            if report.get("skipped_pages"):
                self.meta_label.setText(self.meta_label.text() + " / PDF生成スキップ: p." + ", ".join(map(str, report["skipped_pages"])))
        article = folder / "article.md"
        self.article_view.setMarkdown(article.read_text("utf-8") if article.exists() else "## 解説はまだありません\n\n「解説を作成」を押してください。")
        self.refresh_chat()
        self.update_controls()
        self.render_timer.start(30)

    def update_controls(self):
        busy = self.job is not None and self.job.isRunning()
        self.status_bar.setVisible(not self.focus_button.isChecked() or busy)
        self.paper_list.imports_enabled = not busy
        for widget in [self.page_input, self.jump_button]:
            widget.setEnabled(bool(self.current_id))
        for button in self.busy_buttons:
            button.setEnabled(not busy)
        for widget in [self.translate_button, self.article_button, self.export_button, self.ask_button]:
            widget.setEnabled(bool(self.current_id) and not busy)
        for widget in [self.note, self.edit_title, self.edit_author, self.edit_year, self.collection, self.save_metadata_button]:
            widget.setEnabled(bool(self.current_id))
        for name, button in self.external_pdf_buttons.items():
            path = None
            if self.current_id:
                folder = self.library.folder(self.current_id)
                path = folder / ("translated.pdf" if name == "interleaved.pdf" else name)
            button.setEnabled(path is not None and path.is_file())
            if name == "interleaved.pdf" and busy:
                button.setEnabled(False)
        if self.current_id:
            preview = read_preview(self.library.folder(self.current_id))
            if preview and not preview["complete"]:
                self.export_button.setEnabled(False)
        self.progress_bar.setVisible(busy)
        self.cancel_button.setVisible(busy)

    def run_job(self, action, completed=None):
        if self.job and self.job.isRunning():
            return
        job = Job(action, self)
        self.job = job
        job.progress.connect(self.report_progress)
        job.failed.connect(self.job_failed)
        if completed:
            job.succeeded.connect(completed)
        job.finished.connect(self.job_finished)
        job.start()
        self.update_controls()

    def report_progress(self, message):
        self.status_label.setText(message)
        # Steps are reported as "3/12"; mirror that on the progress bar and the taskbar button.
        match = COUNTER.search(message)
        if match:
            done, total = (int(value) for value in match.groups())
            self.progress_bar.setRange(0, total)
            self.progress_bar.setValue(done)
            self.taskbar.state(self.window_handle(), winintegration.NORMAL)
            self.taskbar.value(self.window_handle(), done, total)
        else:
            self.progress_bar.setRange(0, 0)
            self.taskbar.busy(self.window_handle(), True)

    def refresh_translation_page(self, paper_id, number):
        if paper_id != self.current_id:
            return
        self.update_controls()
        self.render_timer.start(0)

    def window_handle(self) -> int:
        return int(self.winId())

    def job_failed(self, message, cancelled):
        self.status_label.setText(message)
        if not cancelled:
            self.taskbar.state(self.window_handle(), winintegration.ERROR)
            self.notify("処理を完了できませんでした", message)
            JobErrorDialog(message, self).exec()

    def job_finished(self):
        self.taskbar.busy(self.window_handle(), False)
        self.progress_bar.setRange(0, 0)
        self.update_controls()
        self.refresh_list()
        if self.current_id:
            self.select_paper(self.current_id, self.current_page)

    def cancel_job(self):
        if self.job:
            self.job.cancel.set()
            self.status_label.setText("中止しています… API通信中の場合は応答またはタイムアウトまで待ちます。")

    def import_pdfs(self):
        paths, _ = QFileDialog.getOpenFileNames(self, "論文PDFを追加", "", "PDF (*.pdf)")
        self.import_paths([Path(path) for path in paths])

    def import_paths(self, paths: list[Path], collection_name: str | None = None):
        if not paths or (self.job and self.job.isRunning()):
            return
        def action(cancel, progress):
            imported = []
            for index, path in enumerate(paths):
                if cancel.is_set():
                    raise Cancelled("追加を中止しました。追加済みの論文は保存されています。")
                progress(f"PDFを追加 {index + 1}/{len(paths)}")
                imported.append(self.library.import_pdf(path, collection_name))
            return imported
        def done(results):
            self.refresh_list()
            self.select_paper(results[-1][0])
            self.refresh_list()
            message = f"{sum(1 for _, new in results if new)}件を追加しました。重複するPDFは既存の論文を開きます。"
            self.status_label.setText(message)
            self.notify("PDFを追加しました", message)
        collection_name = self.current_collection if collection_name is None else collection_name
        self.run_job(action, done)

    def dragEnterEvent(self, event):
        if self.paper_list.imports_enabled and dropped_pdfs(event):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragMoveEvent(self, event):
        if self.paper_list.imports_enabled and dropped_pdfs(event):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event):
        # A rejected tree drop must not fall back to importing into the selection.
        if (not self.paper_list.imports_enabled or self.paper_list.rect().contains(
                self.paper_list.mapFrom(self, event.position().toPoint()))):
            event.ignore()
            return
        paths = [path for path in dropped_pdfs(event) if path.is_file()]
        if not paths:
            return
        event.acceptProposedAction()
        self.reveal()
        self.import_paths(paths)

    def install_shortcuts(self):
        try:
            created = winintegration.install_shortcuts()
        except Exception as error:
            QMessageBox.warning(self, "ショートカットを作成できませんでした", str(error))
            return
        places = "・".join(path.parent.name for path in created)
        QMessageBox.information(
            self, "ショートカットを作成しました",
            f"{places} にPaperDeskを追加しました。\n"
            "スタートメニューのPaperDeskを右クリックすると、"
            "「スタートにピン留めする」「タスクバーにピン留めする」を選べます。")
        self.status_label.setText("ショートカットを作成しました。右クリックからピン留めできます。")

    def service_job(self, operation, completed, settings_override=None):
        if not self.current_id:
            return
        settings = replace(settings_override if settings_override is not None else self.settings)
        paper_id = self.current_id
        def action(cancel, progress):
            provider = Provider(settings, cancel)
            service = PaperService(self.library, provider, cancel, progress, self.translation_page_ready.emit)
            return operation(service, paper_id)
        self.run_job(action, completed)

    def translate(self):
        if not self.current_id or (self.job and self.job.isRunning()):
            return
        count = self.library.document(self.current_id)["page_count"]
        preview = read_preview(self.library.folder(self.current_id))
        dialog = TranslationPagesDialog(count, min(self.current_page + 1, count), self,
                                        selected_pages=preview.get("target_pages") if preview else None,
                                        settings=self.settings,
                                        preset=self.preferences.value("translation/preset", "connection"))
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        pages = set(dialog.pages)
        selected_settings = dialog.translation_settings()
        self.preferences.setValue("translation/preset", dialog.preset.currentData())
        def done(report):
            message = (f"指定した{len(report['selected_pages'])}ページの翻訳処理が終了しました。"
                       f"全{report['pages']}ページ中{len(report['translated_pages'])}ページ翻訳済み。")
            if report.get("skipped_pages"):
                message += " PDF生成に失敗したページは原文のままです：p." + ", ".join(map(str, report["skipped_pages"]))
            self.status_label.setText(message)
            self.notify("翻訳処理が終了しました", message)
        self.service_job(lambda service, identity: service.translate(identity, pages), done,
                         settings_override=selected_settings)

    def generate_article(self):
        def done(_):
            self.status_label.setText("解説を保存しました。ページ参照をクリックすると原文へ移動します。")
            self.notify("解説ができました", "「解説」タブで確認できます。")
            self.tabs.setCurrentIndex(1)
        self.service_job(lambda service, identity: service.article(identity), done)

    def ask(self):
        question = self.question.text().strip()
        if not question or not self.current_id or (self.job and self.job.isRunning()):
            return
        all_papers = self.all_papers.isChecked()
        self.service_job(lambda service, identity: service.ask(identity, question, all_papers),
                         lambda _: self.ask_done())

    def ask_done(self):
        self.question.clear()
        self.refresh_chat()
        self.status_label.setText("回答を保存しました。参照リンクから原文を確認できます。")
        self.notify("回答ができました", "「質問」タブで確認できます。")

    def refresh_chat(self):
        if not self.current_id:
            return
        messages = self.library.messages(self.current_id)
        if not messages:
            self.chat_view.setMarkdown("## 本文を根拠に、質問する\n\n手法の違い、実験条件、限界などを聞いてみてください。")
            return
        pieces = []
        for message in messages:
            role = "あなた" if message["role"] == "user" else "回答"
            content = message["content"] if message["role"] == "assistant" else html.escape(message["content"])
            pieces.append(f"### {role}\n\n{content}")
        self.chat_view.setMarkdown("\n\n---\n\n".join(pieces))
        self.chat_view.verticalScrollBar().setValue(self.chat_view.verticalScrollBar().maximum())

    def save_note(self):
        self.note_timer.stop()
        if self.current_id:
            self.library.update(self.current_id, note=self.note.toPlainText())

    def save_metadata(self):
        if self.current_id and self.edit_title.text().strip():
            try:
                self.library.update(self.current_id, title=self.edit_title.text().strip(),
                                    first_author=self.edit_author.text(), publication_year=self.edit_year.text(),
                                    collection_name=self.collection.text().strip())
            except ValueError as error:
                QMessageBox.warning(self, "論文情報", str(error))
                return
            self.refresh_list()
            self.select_paper(self.current_id, self.current_page)
            self.status_label.setText("論文情報・フォルダーを保存しました。")

    def configure(self):
        dialog = SettingsDialog(self.settings, self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.settings = dialog.settings()
            self.settings.save(self.root)
            self.status_label.setText("接続設定を保存しました。APIキーはこの起動中のみ保持します。")

    def login(self):
        try:
            command = codex_command(self.settings.codex_path) + ["login"]
            kwargs = {"creationflags": subprocess.CREATE_NEW_CONSOLE} if os.name == "nt" else {}
            subprocess.Popen(command, **kwargs)
            self.status_label.setText("開いたブラウザーでChatGPTにログイン後、「接続を確認」を押してください。")
        except Exception as error:
            QMessageBox.information(self, "Codex CLIの準備", str(error))

    def check_connection(self):
        settings = replace(self.settings)
        def action(cancel, progress):
            progress("接続を確認しています…")
            if settings.provider == "codex":
                flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
                result = subprocess.run(codex_command(settings.codex_path) + ["login", "status"],
                                        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, **flags)
                if result.returncode:
                    raise RuntimeError("未ログインです。「ChatGPTにログイン」を実行してください。")
                return "Codexのログイン状態を確認しました。AI処理の実行可否は利用枠・モデル設定にも依存します。"
            provider = Provider(settings, cancel)
            answer = provider.generate("Reply with OK only.", "Connection test, no document data.")
            return "APIから応答を受信しました: " + answer[:120]
        self.run_job(action, self.status_label.setText)

    def render_pages(self, *_):
        if not self.current_id or self.tabs.currentIndex() != 0:
            return
        folder = self.library.folder(self.current_id)
        document = self.library.document(self.current_id)
        count = document["page_count"]
        preview = read_preview(folder)
        report_path = folder / "translation-report.json"
        if report_path.exists() and not (preview and not preview["complete"]):
            count = max(count, json.loads(report_path.read_text("utf-8"))["pages"])
        completed_pages = translated_page_numbers(folder, count)
        visible_pages = completed_pages if self.page_filter.currentIndex() == 1 else list(range(1, count + 1))
        if not visible_pages:
            self.page_label.setText("翻訳済みページ: 0")
            for label, scroll in zip(self.pdf_labels, self.pdf_scrolls):
                label.clear()
                label.setText("翻訳済みのページはまだありません。完了すると自動で表示します。")
                label.setWordWrap(True)
                label.resize(scroll.viewport().size())
            self.update_controls()
            return
        self.current_page = max(0, min(self.current_page, count - 1))
        if self.current_page + 1 not in visible_pages:
            self.current_page = visible_pages[0] - 1
        self.page_input.setRange(1, document["page_count"])
        if not self.page_input.hasFocus():
            self.page_input.setValue(min(self.current_page + 1, document["page_count"]))
        self.remember_reading()
        self.page_label.setText(f"{self.current_page + 1} / {count}")
        if self.page_filter.currentIndex() == 1:
            position = visible_pages.index(self.current_page + 1) + 1
            self.page_label.setText(f"原文 p.{self.current_page + 1}（表示 {position} / {len(visible_pages)}）")
        elif preview and len(completed_pages) < count:
            self.page_label.setText(f"{self.current_page + 1} / {count}（{len(completed_pages)}ページ翻訳済み）")
        self.pdf_captions[1].setText("原文（PDF生成をスキップ）" if preview and self.current_page + 1 in preview.get("skipped_pages", []) else
            "日本語訳" if self.current_page + 1 in completed_pages else
            "原文（未翻訳）" if preview and (preview["complete"] or self.current_page + 1 not in preview.get("target_pages", range(1, count + 1)))
            else "日本語訳（翻訳待ち）")
        factor = self.zoom.currentData()
        for scroll in self.pdf_scrolls:
            scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff if factor == 1
                                                else Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        fit_width = max(250, min(x.viewport().width() for x in self.pdf_scrolls) - 8)
        for index, name in enumerate(["original.pdf", "translated.pdf"]):
            label, scroll = self.pdf_labels[index], self.pdf_scrolls[index]
            path = folder / name
            page_index = self.current_page
            if name == "translated.pdf":
                path, page_index = translated_page(folder, self.current_page)
            if path is None or not path.exists():
                label.clear()
                label.setText("このページは翻訳待ちです。完了したページから表示します。" if preview and not preview["complete"]
                              else "「日本語に翻訳」で訳文を作成")
                label.setWordWrap(True)
                label.resize(scroll.viewport().size())
                continue
            try:
                width = int(fit_width * factor)
                image = page_image(path, page_index, math.ceil(width * label.devicePixelRatioF()))
                label.clear()
                if image is not None:
                    # Keep the logical page size while supplying native display pixels.
                    image.setDevicePixelRatio(image.width() / width)
                    pixmap = QPixmap.fromImage(image)
                    label.setPixmap(pixmap)
                    size = pixmap.deviceIndependentSize()
                    label.resize(max(scroll.viewport().width(), math.ceil(size.width()) + 6), math.ceil(size.height()) + 6)
                else:
                    label.setText("対応する原文ページがありません。再翻訳すると原文と同じページ数になります。")
                    label.setWordWrap(True)
                    label.resize(scroll.viewport().size())
            except Exception as error:
                self.status_label.setText("PDF表示エラー: " + str(error))
        self.update_controls()

    def change_zoom(self, steps):
        self.zoom.setCurrentIndex(max(0, min(self.zoom.currentIndex() + steps, self.zoom.count() - 1)))

    def pinch_zoom(self, factor):
        # Keep the cumulative gesture scale separate from the displayed preset:
        # small finger movements must accumulate before changing zoom levels.
        if math.isfinite(factor) and factor > 0:
            index = min(range(self.zoom.count()), key=lambda i: abs(self.zoom.itemData(i) - factor))
            self.zoom.setCurrentIndex(index)

    def pdf_gesture(self, event):
        if event.type() == QEvent.Type.Gesture:
            pinch = event.gesture(Qt.GestureType.PinchGesture)
            if pinch is None:
                return False
            if pinch.state() == Qt.GestureState.GestureStarted or self._pinch_start_zoom is None:
                self._pinch_start_zoom = self.zoom.currentData()
            if pinch.state() == Qt.GestureState.GestureCanceled:
                self.pinch_zoom(self._pinch_start_zoom)
            else:
                self.pinch_zoom(self._pinch_start_zoom * pinch.totalScaleFactor())
            if pinch.state() in (Qt.GestureState.GestureFinished, Qt.GestureState.GestureCanceled):
                self._pinch_start_zoom = None
            event.accept(pinch)
            return True
        if event.type() == QEvent.Type.NativeGesture:
            kind = event.gestureType()
            if kind == Qt.NativeGestureType.BeginNativeGesture:
                self._native_pinch_zoom = self.zoom.currentData()
            elif kind == Qt.NativeGestureType.EndNativeGesture:
                self._native_pinch_zoom = None
            elif kind == Qt.NativeGestureType.ZoomNativeGesture:
                multiplier = 1 + event.value()
                if math.isfinite(multiplier) and multiplier > 0:
                    factor = (self._native_pinch_zoom or self.zoom.currentData()) * multiplier
                    self._native_pinch_zoom = max(1, min(factor, self.zoom.itemData(self.zoom.count() - 1)))
                    self.pinch_zoom(self._native_pinch_zoom)
            else:
                return False
            event.accept()
            return True
        return False

    def jump_to_page(self):
        if not self.current_id:
            return
        target = self.page_input.value() - 1
        self.page_filter.blockSignals(True)
        self.page_filter.setCurrentIndex(0)
        self.page_filter.blockSignals(False)
        self.current_page = target
        self.tabs.setCurrentIndex(0)
        self.render_pages()
        for scroll in self.pdf_scrolls:
            scroll.verticalScrollBar().setValue(0)

    def _page_arrow(self, event):
        if (not self.current_id or self.tabs.currentIndex() != 0
                or event.modifiers() != Qt.KeyboardModifier.NoModifier
                or event.key() not in (Qt.Key.Key_Left, Qt.Key.Key_Right)):
            return False
        focus = QApplication.focusWidget()
        if isinstance(focus, (QLineEdit, QPlainTextEdit, QTextBrowser, QSpinBox, QComboBox)):
            return False
        if focus is self.paper_list or focus is self.paper_list.viewport():
            item = self.paper_list.currentItem()
            if item is None or item.data(0, PAPER_ROLE) != self.current_id:
                return False
        self.move_page(-1 if event.key() == Qt.Key.Key_Left else 1)
        event.accept()
        return True

    def eventFilter(self, watched, event):
        if (event.type() in (QEvent.Type.Gesture, QEvent.Type.NativeGesture)
                and any(watched is area or watched is area.viewport()
                        for area in getattr(self, "pdf_scrolls", []))
                and self.pdf_gesture(event)):
            return True
        if (event.type() == QEvent.Type.Wheel
                and event.modifiers() & Qt.KeyboardModifier.ControlModifier
                and any(watched is area or watched is area.viewport()
                        for area in getattr(self, "pdf_scrolls", []))):
            delta = event.angleDelta().y() or event.pixelDelta().y()
            if delta:
                self.change_zoom(1 if delta > 0 else -1)
            event.accept()
            return True
        # The library tree and PDF scroll areas consume arrows before the window.
        if event.type() == QEvent.Type.KeyPress and self._page_arrow(event):
            return True
        return super().eventFilter(watched, event)

    def keyPressEvent(self, event):
        if not self._page_arrow(event):
            super().keyPressEvent(event)

    def move_page(self, amount):
        if self.current_id:
            if self.page_filter.currentIndex() == 1:
                folder = self.library.folder(self.current_id)
                pages = translated_page_numbers(folder, self.library.document(self.current_id)["page_count"])
                if not pages:
                    return
                position = pages.index(self.current_page + 1) if self.current_page + 1 in pages else 0
                self.current_page = pages[max(0, min(position + amount, len(pages) - 1))] - 1
            else:
                self.current_page += amount
            self.render_pages()
            for scroll in self.pdf_scrolls:
                scroll.verticalScrollBar().setValue(0)

    def follow_citation(self, url: QUrl):
        if url.scheme() != "paperdesk":
            return
        try:
            identity, page = url.host(), int(url.path().strip("/"))
            if not 1 <= page <= self.library.paper(identity)["pages"]:
                return
            self.page_filter.setCurrentIndex(0)
            self.select_paper(identity, page - 1)
            self.refresh_list()
            self.tabs.setCurrentIndex(0)
            self.render_pages()
        except (ValueError, KeyError):
            self.status_label.setText("参照先が見つかりませんでした。")

    def open_file(self, name):
        if self.current_id:
            folder = self.library.folder(self.current_id)
            path = folder / name
            if name == "interleaved.pdf" and (folder / "translated.pdf").is_file():
                # Also support papers translated before automatic paired output.
                self.service_job(lambda service, identity: service.export_interleaved(identity, path),
                                 lambda _: self._open_pdf_path(path))
            elif path.is_file():
                self._open_pdf_path(path)

    def _open_pdf_path(self, path):
        if not QDesktopServices.openUrl(QUrl.fromLocalFile(str(path))):
            self.status_label.setText("PDFを開けませんでした。Windowsの既定のPDFアプリを確認してください。")

    def open_folder(self):
        path = self.library.folder(self.current_id) if self.current_id else self.root
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))

    def export_text(self, name):
        if not self.current_id:
            return
        source = self.library.folder(self.current_id) / name
        if not source.exists():
            QMessageBox.information(self, "未作成", "先に解説を作成してください。")
            return
        destination, _ = QFileDialog.getSaveFileName(self, "Markdownを保存", name, "Markdown (*.md)")
        if destination and Path(destination).resolve() != source.resolve():
            shutil.copyfile(source, destination)

    def export_pdf(self):
        if not self.current_id:
            return
        identity = self.current_id
        preview = read_preview(self.library.folder(identity))
        if preview and not preview["complete"]:
            QMessageBox.information(self, "翻訳途中", "指定したページの翻訳が終わると書き出せます。完了したページはアプリ内で確認できます。")
            return
        source = self.library.folder(identity) / "translated.pdf"
        if not source.exists():
            QMessageBox.information(self, "未翻訳", "先に日本語訳を作成してください。")
            return
        destination, selected = QFileDialog.getSaveFileName(
            self, "PDFを書き出す", "translated.pdf", "日本語訳 (*.pdf);;原文と訳文の交互ページ (*.pdf);;原文と訳文の対訳（左右） (*.pdf)")
        if not destination:
            return
        target = Path(destination).resolve()
        if target in {source.resolve(), (source.parent / "original.pdf").resolve(), (source.parent / "interleaved.pdf").resolve()}:
            QMessageBox.information(self, "保存先", "別の保存先を選んでください。")
            return
        if selected.startswith("原文と訳文の交互"):
            self.service_job(lambda service, _identity: service.export_interleaved(identity, target),
                             lambda _: self.status_label.setText("原文・日本語訳の交互PDFを保存しました。"))
        elif selected.startswith("原文"):
            self.service_job(lambda service, _identity: service.export_bilingual(identity, target),
                             lambda _: self.status_label.setText("対訳PDFを保存しました。"))
        else:
            shutil.copyfile(source, target)
            self.status_label.setText("日本語訳PDFを保存しました。")

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if hasattr(self, "render_timer"):
            self.render_timer.start(200)

    def closeEvent(self, event):
        if self.job and self.job.isRunning():
            self.cancel_job()
            QMessageBox.information(self, "処理中", "中止を要求しました。処理の終了後に閉じてください。")
            event.ignore()
            return
        self.save_note()
        self.store_layout()
        self.taskbar.busy(self.window_handle(), False)
        self.taskbar.close()
        if self.tray:
            self.tray.hide()
        event.accept()


def main():
    winintegration.apply_app_identity()
    app = QApplication(sys.argv)
    app.setApplicationName("PaperDesk")
    app.setApplicationDisplayName("PaperDesk")
    app.setOrganizationName("PaperDeskLocal")
    app.setDesktopFileName("PaperDesk")
    app.setWindowIcon(app_icon())
    app.setStyleSheet(STYLE)
    app.setFont(QFont("Yu Gothic UI", 10))
    window = Window()
    window.show()
    return app.exec()
