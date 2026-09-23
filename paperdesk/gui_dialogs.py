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
        layout.addWidget(QLabel("今回の翻訳に使うモデルと推論の強さ (effort)"))
        
        provider = settings.provider
        cli_path = settings.gemini_path if provider == "gemini" else (settings.claude_path if provider == "claude" else settings.codex_path)

        form = QFormLayout()
        
        # Model combo
        self.model_combo = QComboBox()
        self.model_combo.addItem("AI接続の設定と同じ", "")
        models = query_available_models(provider, cli_path)
        for m_id, label in models:
            self.model_combo.addItem(label, m_id)
        
        # Effort combo
        self.effort_label = QLabel("推論の強さ (effort)")
        self.effort_combo = QComboBox()
        self.effort_combo.addItem("AI接続の設定と同じ", "")
        self.model_combo.currentIndexChanged.connect(self.update_efforts)
        
        form.addRow("モデル", self.model_combo)
        form.addRow(self.effort_label, self.effort_combo)
        layout.addLayout(form)

        self.model_summary = QLabel()
        self.model_summary.setWordWrap(True)
        layout.addWidget(self.model_summary)
        
        # Connect to update summary
        self.model_combo.currentIndexChanged.connect(self.update_model_summary)
        self.effort_combo.currentIndexChanged.connect(self.update_model_summary)

        # Initial effort population
        self.update_efforts()
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

    def update_efforts(self, *_):
        self.effort_combo.blockSignals(True)
        self.effort_combo.clear()
        self.effort_combo.addItem("AI接続の設定と同じ", "")
        provider = self.connection_settings.provider
        cli_path = self.connection_settings.gemini_path if provider == "gemini" else (self.connection_settings.claude_path if provider == "claude" else self.connection_settings.codex_path)
        m_id = self.model_combo.currentData() or self.connection_settings.model
        efforts = query_available_efforts(provider, cli_path, m_id)
        for e_id, label in efforts:
            self.effort_combo.addItem(label, e_id)
            
        has_efforts = self.effort_combo.count() > 1
        self.effort_label.setVisible(has_efforts)
        self.effort_combo.setVisible(has_efforts)
        self.adjustSize()
        self.effort_combo.blockSignals(False)

    def translation_settings(self):
        m_id = self.model_combo.currentData()
        e_id = self.effort_combo.currentData()
        kwargs = {}
        if m_id:
            kwargs["model"] = m_id
        if e_id is not None and e_id != "":
            kwargs["reasoning_effort"] = e_id
        return replace(self.connection_settings, **kwargs)

    def update_model_summary(self, *_):
        settings = self.translation_settings()
        provider_names = {
            "codex": "ChatGPT / Codex CLI",
            "api": "設定済みのAPI接続",
            "claude": "Claude Code CLI",
            "gemini": "Google Gemini (agy CLI)",
        }
        connection = provider_names.get(settings.provider, settings.provider)
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
        self.provider.addItem("Google Gemini (agy CLI)", "gemini")
        self.provider.addItem("Claude Code CLI", "claude")
        self.provider.addItem("ChatGPT / Codex CLI", "codex")
        self.provider.addItem("API / ローカルモデル（OpenAI互換）", "api")
        idx = self.provider.findData(current.provider)
        self.provider.setCurrentIndex(idx if idx >= 0 else 0)

        self.model = QComboBox()
        self.model.setEditable(True)  # Allow user input for API/fallback
        self.btn_refresh_models = QPushButton("再取得")
        self.btn_refresh_models.clicked.connect(self.update_provider_ui)
        model_layout = QHBoxLayout()
        model_layout.setContentsMargins(0, 0, 0, 0)
        model_layout.addWidget(self.model, 1)
        model_layout.addWidget(self.btn_refresh_models)

        self.effort_label = QLabel("推論の強さ（effort）")
        self.effort = QComboBox()
        
        # We need a dictionary to store CLI paths, but the current object only holds specific fields.
        # Create a dict mapping providers to their paths for the UI.
        self.cli_paths = {
            "codex": current.codex_path,
            "claude": current.claude_path,
            "gemini": current.gemini_path,
        }
        self.executable_label = QLabel("CLIのパス")
        self.executable = QLineEdit(self.cli_paths.get(current.provider, ""))
        self.executable.setPlaceholderText("通常は空欄で自動検出")

        self.url_label = QLabel("API URL")
        self.url = QLineEdit(current.base_url)
        self.key_label = QLabel("APIキー")
        self.key = QLineEdit(current.api_key)
        self.key.setEchoMode(QLineEdit.EchoMode.Password)
        self.key.setPlaceholderText("この起動中のみ保持 / PAPERDESK_API_KEYでも設定可")

        self.saved_models = {current.provider: current.model} if current.model else {}
        self.saved_efforts = {current.provider: current.reasoning_effort} if current.reasoning_effort else {}
        self.last_provider = current.provider

        form.addRow("接続先", self.provider)
        form.addRow("モデル", model_layout)
        form.addRow(self.effort_label, self.effort)
        form.addRow(self.executable_label, self.executable)
        form.addRow(self.url_label, self.url)
        form.addRow(self.key_label, self.key)
        layout.addLayout(form)

        self.effort_note = QLabel("effortを上げると推論に使う時間・トークンが増える場合があります。対応値はモデルによって異なります。\n"
                             "翻訳・解説・質問の新しいAI処理に適用します。翻訳済みの部分は引き続き再利用します。")
        self.effort_note.setWordWrap(True)
        self.effort_note.setObjectName("subtle")
        layout.addWidget(self.effort_note)

        # Add Login and Check Connection buttons
        self.btn_login = QPushButton("ログイン (CLI)")
        self.btn_check = QPushButton("接続を確認")
        self.btn_login.clicked.connect(self.run_login)
        self.btn_check.clicked.connect(self.run_check)
        
        btn_layout = QHBoxLayout()
        btn_layout.addWidget(self.btn_login)
        btn_layout.addWidget(self.btn_check)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        info = QLabel("CLI接続（Gemini agy / Claude Code / Codex）は各ツールのログイン状態と利用枠に従います。\n"
                      "ローカル例: http://localhost:11434/v1（Ollama）\n"
                      "ChatGPT接続はCodexの利用権限と利用枠に従います。\n"
                      "APIキーでの利用は接続先の従量課金となる場合があります。")
        info.setWordWrap(True)
        info.setObjectName("subtle")
        layout.addWidget(info)
        self.provider.currentIndexChanged.connect(self.on_provider_changed)
        self.on_provider_changed()
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def on_provider_changed(self):
        if self.last_provider in self.cli_paths:
            self.cli_paths[self.last_provider] = self.executable.text().strip()
            self.saved_models[self.last_provider] = self.model.currentData() or self.model.currentText().strip()
            self.saved_efforts[self.last_provider] = self.effort.currentData() or ""

        new_provider = self.provider.currentData()
        if new_provider in self.cli_paths:
            self.executable.setText(self.cli_paths[new_provider])
        self.last_provider = new_provider
        self.update_provider_ui()

    def update_provider_ui(self):
        provider = self.provider.currentData()
        cli_path = self.executable.text().strip()

        # Update Models dropdown dynamically
        self.btn_refresh_models.setText("取得中...")
        QApplication.processEvents()
        
        self.model.blockSignals(True)
        self.model.clear()
        
        # Use dynamic queries
        models = query_available_models(provider, cli_path)
        for m_id, label in models:
            self.model.addItem(label, m_id)

        target_model = self.saved_models.get(provider, "")
        if not target_model and models:
            target_model = models[0][0]

        idx = self.model.findData(target_model)
        if idx >= 0:
            self.model.setCurrentIndex(idx)
        elif target_model:
            self.model.insertItem(0, target_model, target_model)
            self.model.setCurrentIndex(0)
        elif models:
            self.model.setCurrentIndex(0)
        self.model.blockSignals(False)

        # Update Efforts dropdown dynamically
        self.effort.blockSignals(True)
        self.effort.clear()
        
        current_model_id = self.model.currentData() or self.model.currentText().strip()
        efforts = query_available_efforts(provider, cli_path, current_model_id)
        for e_id, label in efforts:
            self.effort.addItem(label, e_id)

        target_effort = self.saved_efforts.get(provider, "")
        e_idx = self.effort.findData(target_effort)
        if e_idx >= 0:
            self.effort.setCurrentIndex(e_idx)
        else:
            self.effort.setCurrentIndex(0)
        self.effort.blockSignals(False)
        
        self.btn_refresh_models.setText("再取得")

        # Update Executable label and placeholder
        if provider == "codex":
            self.executable_label.setText("Codexのパス")
            self.executable.setPlaceholderText("通常は空欄で自動検出（npm版やcodex.cmd等）")
        elif provider == "claude":
            self.executable_label.setText("Claude Codeのパス")
            self.executable.setPlaceholderText("通常は空欄で自動検出（claude.cmd等）")
        elif provider == "gemini":
            self.executable_label.setText("Gemini (agy) のパス")
            self.executable.setPlaceholderText("通常は空欄で自動検出（agy.exe等）")
        
        api = provider == "api"
        # Hide URL and API key fields for CLI providers
        self.url_label.setVisible(api)
        self.url.setVisible(api)
        self.key_label.setVisible(api)
        self.key.setVisible(api)
        self.executable_label.setVisible(not api)
        self.executable.setVisible(not api)
        self.btn_login.setVisible(not api)
        
        # Hide effort field if it only has 1 or fewer options
        has_efforts = self.effort.count() > 1
        self.effort_label.setVisible(has_efforts)
        self.effort.setVisible(has_efforts)
        self.effort_note.setVisible(has_efforts)
        
        self.adjustSize()

    def run_login(self):
        self.btn_login.setText("確認中...")
        self.btn_login.setEnabled(False)
        QApplication.processEvents()
        
        settings = self.settings()
        flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        is_logged_in = False
        
        try:
            if settings.provider == "codex":
                res = subprocess.run(codex_command(settings.codex_path) + ["login", "status"],
                                     capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5, **flags)
                is_logged_in = (res.returncode == 0)
            elif settings.provider == "claude":
                res = subprocess.run(claude_command(settings.claude_path) + ["auth", "status"],
                                     capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5, **flags)
                is_logged_in = (res.returncode == 0)
            elif settings.provider == "gemini":
                res = subprocess.run(gemini_command(settings.gemini_path) + ["models"],
                                     capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5, **flags)
                is_logged_in = (res.returncode == 0)
                
            if is_logged_in:
                QMessageBox.information(self, "ログイン状態", "すでにログインされています。")
                return
                
        except Exception:
            pass
        finally:
            self.btn_login.setText("ログイン (CLI)")
            self.btn_login.setEnabled(True)

        try:
            kwargs = {"creationflags": subprocess.CREATE_NEW_CONSOLE} if os.name == "nt" else {}
            if settings.provider == "codex":
                subprocess.Popen(codex_command(settings.codex_path) + ["login"], **kwargs)
                QMessageBox.information(self, "ログイン", "開いたブラウザーでChatGPTにログイン後、「接続を確認」を押してください。")
            elif settings.provider == "claude":
                subprocess.Popen(claude_command(settings.claude_path) + ["auth", "login"], **kwargs)
                QMessageBox.information(self, "ログイン", "開いたブラウザーでClaudeにログイン後、「接続を確認」を押してください。")
            elif settings.provider == "gemini":
                subprocess.Popen(gemini_command(settings.gemini_path), **kwargs)
                QMessageBox.information(self, "ログイン", "開いたブラウザーでAntigravityにログイン後、「接続を確認」を押してください。")
        except Exception as error:
            QMessageBox.warning(self, "CLIの準備エラー", str(error))

    def run_check(self):
        settings = self.settings()
        parent = self.parent()
        def action(cancel, progress):
            progress("接続を確認しています…")
            flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
            if settings.provider == "codex":
                result = subprocess.run(codex_command(settings.codex_path) + ["login", "status"],
                                        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, **flags)
                if result.returncode:
                    raise RuntimeError("未ログインです。「ログイン (CLI)」を実行してください。")
                return "Codexのログイン状態を確認しました。"
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
        
        self.btn_check.setText("確認中...")
        self.btn_check.setEnabled(False)
        QApplication.processEvents()
        
        try:
            import threading
            result_box = []
            def bg_task():
                try:
                    result_box.append(action(lambda: False, lambda x: None))
                except Exception as e:
                    result_box.append(e)
            
            t = threading.Thread(target=bg_task)
            t.start()
            while t.is_alive():
                QApplication.processEvents()
                t.join(0.05)
                
            res = result_box[0]
            if isinstance(res, Exception):
                QMessageBox.warning(self, "接続エラー", str(res))
            else:
                QMessageBox.information(self, "接続確認", res)
        finally:
            self.btn_check.setText("接続を確認")
            self.btn_check.setEnabled(True)

    def settings(self):
        if self.last_provider in self.cli_paths:
            self.cli_paths[self.last_provider] = self.executable.text().strip()
        model_val = self.model.currentData() or self.model.currentText().strip()
        effort_val = self.effort.currentData() or ""
        return replace(self.current, provider=self.provider.currentData(), model=model_val,
                       base_url=self.url.text().strip(), api_key=self.key.text().strip(),
                       codex_path=self.cli_paths.get("codex", ""),
                       claude_path=self.cli_paths.get("claude", ""),
                       gemini_path=self.cli_paths.get("gemini", ""),
                       reasoning_effort=effort_val)

