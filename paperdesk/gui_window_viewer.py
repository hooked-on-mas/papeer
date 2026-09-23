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
from .pdf_viewer import PageRenderer, page_image
from .page_selection import parse_page_selection
from .providers import Cancelled, Provider, codex_command, claude_command, gemini_command, query_available_models, query_available_efforts
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



from .gui_widgets import *
from .gui_dialogs import *

class WindowViewerMixin:
    def render_pages(self, *_):
        if not self.current_id or self.tabs.currentIndex() != 0:
            return
        folder = self.library.folder(self.current_id)
        document = self.library.reading_info(self.current_id)
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
        translated_caption = ("原文（PDF生成をスキップ）" if preview and self.current_page + 1 in preview.get("skipped_pages", []) else
            "日本語訳" if self.current_page + 1 in completed_pages else
            "原文（未翻訳）" if preview and (preview["complete"] or self.current_page + 1 not in preview.get("target_pages", range(1, count + 1)))
            else "日本語訳（翻訳待ち）")
        info_text = ""
        cache_path = folder / "translation-cache.json"
        if self.current_page + 1 in completed_pages and cache_path.exists():
            try:
                cache = json.loads(cache_path.read_text("utf-8"))
                page_info = cache.get("completed_pages", {}).get(str(self.current_page + 1))
                if page_info:
                    version = page_info.get("version", "")
                    sha = version.split("code-sha256-")[1][:7] if "code-sha256-" in version else "不明"
                    model = page_info.get("model", "不明")
                    info_text = f"翻訳時SHA：{sha} ({model}) "
            except Exception:
                pass
        if hasattr(self, 'translation_info_label'):
            self.translation_info_label.setText(info_text)

        self.pdf_captions[1].setText(translated_caption)
        self.render_generation = self.page_renderer.invalidate()
        factor = self.zoom.currentData()
        for scroll in self.pdf_scrolls:
            scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff if factor == 1
                                                else Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        fit_width = max(250, min(x.viewport().width() for x in self.pdf_scrolls) - 8)
        
        requests = []
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
            
            width = int(fit_width * factor)
            pixel_width = math.ceil(width * label.devicePixelRatioF())
            # Tuple must match: (pane, path, page_index, pixels, width)
            requests.append((index, str(path), page_index, pixel_width, width))
            
        if requests:
            self.page_renderer.submit(self.render_generation, requests)
        self.update_controls()

    def display_page(self, generation: int, index: int, image, width: int):
        if generation != self.render_generation:
            return
        label = self.pdf_labels[index]
        scroll = self.pdf_scrolls[index]
        label.clear()
        if image is not None:
            image.setDevicePixelRatio(image.width() / width)
            pixmap = QPixmap.fromImage(image)
            label.setPixmap(pixmap)
            size = pixmap.deviceIndependentSize()
            label.resize(max(scroll.viewport().width(), math.ceil(size.width()) + 6), math.ceil(size.height()) + 6)
        else:
            label.setText("対応する原文ページがありません。再翻訳すると原文と同じページ数になります。")
            label.setWordWrap(True)
            label.resize(scroll.viewport().size())

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
                pages = translated_page_numbers(folder, self.library.reading_info(self.current_id)["page_count"])
                if not pages:
                    return
                position = pages.index(self.current_page + 1) if self.current_page + 1 in pages else 0
                self.current_page = pages[max(0, min(position + amount, len(pages) - 1))] - 1
            else:
                self.current_page += amount
            self.render_pages()
            for scroll in self.pdf_scrolls:
                scroll.verticalScrollBar().setValue(0)

