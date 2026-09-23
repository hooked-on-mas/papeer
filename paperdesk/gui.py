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
from .gui_window_base import WindowBase
from .gui_window_library import WindowLibraryMixin, render_markdown_with_math
from .gui_window_viewer import WindowViewerMixin

class Window(WindowLibraryMixin, WindowViewerMixin, WindowBase):
    translation_page_ready = Signal(str, int)
    def update_controls(self):
        if not hasattr(self, "jobs"):
            self.jobs = {}
            if hasattr(self, "job") and self.job is not None:
                self.jobs[self.job] = {"paper_id": None, "message": ""}
        
        busy_current = any(j.isRunning() for j in self.jobs if self.jobs[j].get("paper_id") == self.current_id or self.jobs[j].get("paper_id") is None)
        any_busy = any(j.isRunning() for j in self.jobs)

        self.status_bar.setVisible(not self.focus_button.isChecked() or any_busy)
        self.paper_list.imports_enabled = not any_busy
        for widget in [self.page_input, self.jump_button]:
            widget.setEnabled(bool(self.current_id))
        for button in self.busy_buttons:
            # デフォルトで追加されたボタンは一旦現在のペーパーに依存するものとして扱う
            button.setEnabled(not busy_current)
        for widget in [self.translate_button, self.article_button, self.export_button, self.ask_button]:
            widget.setEnabled(bool(self.current_id) and not busy_current)
        for widget in [self.note, self.edit_title, self.edit_author, self.edit_year, self.collection, self.save_metadata_button]:
            widget.setEnabled(bool(self.current_id))
        for name, button in self.external_pdf_buttons.items():
            path = None
            if self.current_id:
                folder = self.library.folder(self.current_id)
                path = folder / ("translated.pdf" if name == "interleaved.pdf" else name)
            button.setEnabled(path is not None and path.is_file())
            if name == "interleaved.pdf" and busy_current:
                button.setEnabled(False)
        if self.current_id:
            preview = read_preview(self.library.folder(self.current_id))
            if preview and not preview["complete"]:
                self.export_button.setEnabled(False)
        self.progress_bar.setVisible(any_busy)
        self.cancel_button.setVisible(any_busy)

    def update_status_display(self):
        if not hasattr(self, "jobs"):
            return
        current_job = next((j for j in self.jobs if self.jobs[j].get("paper_id") == self.current_id and j.isRunning()), None)
        global_job = next((j for j in self.jobs if self.jobs[j].get("paper_id") is None and j.isRunning()), None)
        active_job = current_job or global_job

        if active_job:
            message = self.jobs[active_job].get("message", "処理中...")
            self.status_label.setText(message)
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
        elif any(j.isRunning() for j in self.jobs):
            num = sum(1 for j in self.jobs if j.isRunning())
            self.status_label.setText(f"バックグラウンドで {num} 件のタスクが実行中です...")
            self.progress_bar.setRange(0, 0)
            self.taskbar.busy(self.window_handle(), True)
        else:
            self.progress_bar.setRange(0, 0)
            self.taskbar.busy(self.window_handle(), False)

    def run_job(self, action, completed=None, paper_id=None):
        if not hasattr(self, "jobs"):
            self.jobs = {}
        if paper_id is not None:
            if any(info.get("paper_id") == paper_id for j, info in self.jobs.items() if j.isRunning()):
                return
        else:
            if any(j.isRunning() for j in self.jobs):
                return

        job = Job(action, self)
        self.jobs[job] = {"paper_id": paper_id, "message": "準備中..."}

        job.progress.connect(lambda msg, j=job: self.report_progress(j, msg))
        job.failed.connect(lambda msg, cancelled, j=job: self.job_failed(j, msg, cancelled))
        if completed:
            job.succeeded.connect(lambda res, j=job, c=completed: self.job_succeeded(j, res, c))
        job.finished.connect(lambda j=job: self.job_finished(j))
        
        job.start()
        self.update_controls()
        self.update_status_display()

    def job_succeeded(self, job, result, completed_callback):
        completed_callback(result)

    def report_progress(self, job, message):
        if job in self.jobs:
            self.jobs[job]["message"] = message
        if getattr(self, "current_id", None) == self.jobs.get(job, {}).get("paper_id") or self.jobs.get(job, {}).get("paper_id") is None:
            self.update_status_display()

    def refresh_translation_page(self, paper_id, number):
        if paper_id != self.current_id:
            return
        self.update_controls()
        self.render_timer.start(0)

    def window_handle(self) -> int:
        return int(self.winId())

    def job_failed(self, job, message, cancelled):
        if job in self.jobs:
            self.jobs[job]["message"] = message
        if getattr(self, "current_id", None) == self.jobs.get(job, {}).get("paper_id") or self.jobs.get(job, {}).get("paper_id") is None:
            self.status_label.setText(message)
            if not cancelled:
                self.taskbar.state(self.window_handle(), winintegration.ERROR)
        if not cancelled:
            self.notify("処理を完了できませんでした", message)
            JobErrorDialog(message, self).exec()
        self.update_status_display()

    def job_finished(self, job):
        if job in self.jobs:
            del self.jobs[job]
        
        self.update_controls()
        self.update_status_display()
        self.refresh_list()
        
        paper_id = getattr(job, "paper_id", None)
        if paper_id == self.current_id and self.current_id:
            self.select_paper(self.current_id, self.current_page)

    def cancel_job(self):
        if not hasattr(self, "jobs"):
            return
        canceled_any = False
        for job in list(self.jobs.keys()):
            if job.isRunning() and (self.jobs[job].get("paper_id") == self.current_id or self.jobs[job].get("paper_id") is None):
                job.cancel.set()
                canceled_any = True
        
        if canceled_any:
            self.status_label.setText("中止しています… API通信中の場合は応答またはタイムアウトまで待ちます。")
        else:
            QMessageBox.information(self, "中止", "現在表示中の論文で実行中の処理はありません。他の論文の処理を中止する場合は、その論文を開いてから中止を押してください。")

    def import_pdfs(self):
        paths, _ = QFileDialog.getOpenFileNames(self, "論文PDFを追加", "", "PDF (*.pdf)")
        self.import_paths([Path(path) for path in paths])

    def import_paths(self, paths: list[Path], collection_name: str | None = None):
        if not paths or (hasattr(self, "jobs") and any(j.isRunning() for j in self.jobs if self.jobs[j].get("paper_id") is None)):
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
        self.run_job(action, completed, paper_id=paper_id)

    def translate(self):
        if not self.current_id or (hasattr(self, "jobs") and any(j.isRunning() for j in self.jobs if self.jobs[j].get("paper_id") == self.current_id)):
            return
        count = self.library.reading_info(self.current_id)["page_count"]
        preview = read_preview(self.library.folder(self.current_id))
        dialog = TranslationPagesDialog(count, min(self.current_page + 1, count), self,
                                        selected_pages=preview.get("target_pages") if preview else None,
                                        settings=self.settings)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        pages = set(dialog.pages)
        selected_settings = dialog.translation_settings()
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
        if not question or not self.current_id or (hasattr(self, "jobs") and any(j.isRunning() for j in self.jobs if self.jobs[j].get("paper_id") == self.current_id)):
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
        text = "\n\n---\n\n".join(pieces)
        folder = self.library.folder(self.current_id)
        self.chat_view.setMarkdown(render_markdown_with_math(text, folder))
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
            kwargs = {"creationflags": subprocess.CREATE_NEW_CONSOLE} if os.name == "nt" else {}
            if self.settings.provider == "codex":
                command = codex_command(self.settings.codex_path) + ["login"]
                subprocess.Popen(command, **kwargs)
                self.status_label.setText("開いたブラウザーでChatGPTにログイン後、「接続を確認」を押してください。")
            elif self.settings.provider == "claude":
                command = claude_command(self.settings.claude_path) + ["auth", "login"]
                subprocess.Popen(command, **kwargs)
                self.status_label.setText("開いたブラウザーでClaudeにログイン後、「接続を確認」を押してください。")
            elif self.settings.provider == "gemini":
                command = gemini_command(self.settings.gemini_path)
                subprocess.Popen(command, **kwargs)
                self.status_label.setText("開いたブラウザーでAntigravityにログイン後、「接続を確認」を押してください。")
            else:
                self.status_label.setText("API接続ではログイン操作は不要です。")
        except Exception as error:
            QMessageBox.information(self, "CLIの準備エラー", str(error))

    def check_connection(self):
        settings = replace(self.settings)
        def action(cancel, progress):
            progress("接続を確認しています…")
            flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
            if settings.provider == "codex":
                result = subprocess.run(codex_command(settings.codex_path) + ["login", "status"],
                                        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, **flags)
                if result.returncode:
                    raise RuntimeError("未ログインです。「ログイン (CLI)」を実行してください。")
                return "Codexのログイン状態を確認しました。AI処理の実行可否は利用枠・モデル設定にも依存します。"
            elif settings.provider == "claude":
                result = subprocess.run(claude_command(settings.claude_path) + ["auth", "status"],
                                        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, **flags)
                if result.returncode:
                    raise RuntimeError("未ログインです。「ログイン (CLI)」を実行してください。\n" + result.stdout.strip())
                return "Claude Codeのログイン状態を確認しました。"
            elif settings.provider == "gemini":
                result = subprocess.run(gemini_command(settings.gemini_path) + ["models"],
                                        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, **flags)
                if result.returncode:
                    detail = result.stderr.strip() or result.stdout.strip()
                    raise RuntimeError("Gemini (agy) の接続確認に失敗しました。\n" + detail)
                return f"Gemini (agy) の疎通を確認しました（応答: {result.stdout.strip()[:60]}）。"
            
            provider = Provider(settings, cancel)
            answer = provider.generate("Reply with OK only.", "Connection test, no document data.")
            return "APIから応答を受信しました: " + answer[:120]
        self.run_job(action, self.status_label.setText)

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
        if hasattr(self, "page_renderer"):
            self.page_renderer.stop()
        if hasattr(self, "jobs") and any(j.isRunning() for j in self.jobs):
            for job in list(self.jobs.keys()):
                if job.isRunning():
                    job.cancel.set()
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
