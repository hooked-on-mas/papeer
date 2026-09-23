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

def render_markdown_with_math(text: str, folder: Path) -> str:
    import hashlib
    math_dir = folder / "math"
    math_dir.mkdir(exist_ok=True)
    def replace_math(match):
        is_block = match.group(0).startswith("$$")
        formula = match.group(1).strip()
        if not formula:
            return match.group(0)
        
        # Use a new salt to ignore old Codecogs/low-res caches
        h = hashlib.md5(f"matplotlib_300dpi_{formula}".encode('utf-8')).hexdigest()
        img_path = math_dir / f"{h}.png"
        
        if not img_path.exists():
            try:
                import matplotlib.pyplot as plt
                fig = plt.figure(figsize=(0.01, 0.01))
                # Add math delimiters for matplotlib mathtext
                clean_formula = formula.replace(r"\text", r"\mathrm")
                clean_formula = re.sub(r"\\ge\b", r"\\geq", clean_formula)
                clean_formula = re.sub(r"\\le\b", r"\\leq", clean_formula)
                fig.text(0, 0, f"${clean_formula}$", fontsize=12)
                # dpi=300 for crisp high-resolution rendering
                fig.savefig(str(img_path), format='png', dpi=300, bbox_inches='tight', pad_inches=0.02, transparent=True)
                plt.close(fig)
            except Exception:
                return match.group(0)
                
        # Read image size to scale it down in HTML
        from PySide6.QtGui import QImage
        img = QImage(str(img_path))
        display_height = int(img.height() / 3.0)
        display_width = int(img.width() / 3.0)
        
        uri = img_path.as_uri()
        if is_block:
            return f'\n\n<p align="center"><img src="{uri}" width="{display_width}" height="{display_height}" /></p>\n\n'
        else:
            return f'<img src="{uri}" width="{display_width}" height="{display_height}" style="vertical-align: middle;" />'
            
    text = re.sub(r"\$\$(.*?)\$\$", replace_math, text, flags=re.DOTALL)
    text = re.sub(r"\$([^\n\$]+?)\$", replace_math, text)
    return text

class WindowLibraryMixin:
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
        info = self.library.reading_info(paper_id)
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
        text = article.read_text("utf-8") if article.exists() else "## 解説はまだありません\n\n「解説を作成」を押してください。"
        self.article_view.setMarkdown(render_markdown_with_math(text, folder))
        self.refresh_chat()
        self.update_controls()
        self.render_timer.start(30)

