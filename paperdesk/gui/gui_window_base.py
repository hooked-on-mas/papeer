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



from paperdesk.gui.gui_widgets import *
from paperdesk.gui.gui_dialogs import *

class WindowBase(QMainWindow):
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
        self.jobs = {}
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
        self.render_generation = 0
        self.page_renderer = PageRenderer()
        self.page_renderer.ready.connect(self.display_page)
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
        self.paper_list = self.library_tree = LibraryTree()
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
        for caption, callback in [("AI接続の設定", self.configure), ("ログイン (CLI)", self.login),
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
        self.status_bar.setVisible(not checked or bool(hasattr(self, "jobs") and any(j.isRunning() for j in self.jobs)))
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

        self.translation_info_label = QLabel("")
        font = self.translation_info_label.font()
        if font.pointSize() > 0:
            font.setPointSize(max(1, font.pointSize() - 2))
        elif font.pixelSize() > 0:
            font.setPixelSize(max(1, font.pixelSize() - 2))
        self.translation_info_label.setFont(font)
        self.translation_info_label.setStyleSheet("color: gray;")
        nav.addWidget(self.translation_info_label)

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
        self.article_view.setMarkdown("## 論文の理解を、もう一歩深く\n\n「サマリーを作成」で、イントロダクションから目的・手法・結果・限界まで、具体例を交えながら日本語で詳しく整理します。")
        layout.addWidget(self.article_view)

        button_row = QHBoxLayout()
        button_row.addWidget(self.button("サマリーを作成", self.generate_article))
        button_row.addWidget(self.button("サマリーをMarkdownで保存", lambda: self.export_text("article.md"), busy=False))
        layout.addLayout(button_row)

        self.tabs.addTab(widget, "サマリー")

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

