"""Headless desktop integration smoke test; no real model calls."""
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from unittest.mock import Mock, patch
import pymupdf as fitz

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PySide6.QtCore import QUrl
from PySide6.QtWidgets import QApplication

from paperdesk.gui import COLLECTION_ROLE, SettingsDialog, STYLE, TranslationPagesDialog, Window
from paperdesk.service import PaperService
from test_workflow import FakeProvider


app = QApplication.instance() or QApplication([])
app.setStyleSheet(STYLE)

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    window = Window(root)
    window.show()
    app.processEvents()
    identity, created = window.library.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
    assert created
    window.refresh_list()
    window.select_paper(identity)
    app.processEvents()
    window.render_pages()
    assert not window.pdf_labels[0].pixmap().isNull()
    window.page_filter.setCurrentIndex(1)
    assert 'まだありません' in window.pdf_labels[1].text()
    window.page_filter.setCurrentIndex(0)
    pixmap = window.pdf_labels[0].pixmap()
    logical_width = max(250, min(s.viewport().width() for s in window.pdf_scrolls) - 8)
    assert abs(pixmap.deviceIndependentSize().width() - logical_width) < 1
    assert abs(pixmap.devicePixelRatio() - window.pdf_labels[0].devicePixelRatioF()) < .01
    window.note.setPlainText("日本語メモの保存を検証")
    window.save_note()
    assert window.library.paper(identity)["note"] == "日本語メモの保存を検証"
    window.collection.setText(r"制御工学\読書会")
    window.save_metadata()
    paper_item = window._paper_tree_item(identity)
    assert paper_item.parent().data(0, COLLECTION_ROLE) == "制御工学 / 読書会"
    assert paper_item.parent().parent().isExpanded()
    window.search.setText("日本語メモ")
    assert window._paper_tree_item(identity) is not None
    window.search.clear()
    results = []
    next_page_waiting, continue_translation = threading.Event(), threading.Event()
    class PausedProvider(FakeProvider):
        def generate(self, instruction, data, schema=None):
            if self.calls == 1:
                next_page_waiting.set()
                if not continue_translation.wait(20):
                    raise RuntimeError("page preview test timed out")
            return super().generate(instruction, data, schema)
    def action(cancel, progress):
        return PaperService(window.library, PausedProvider(), cancel, progress,
                            window.translation_page_ready.emit).translate(identity)
    window.run_job(action, results.append)
    try:
        deadline = time.monotonic() + 15
        while (not next_page_waiting.is_set() or window.pdf_labels[1].pixmap().isNull()) and time.monotonic() < deadline:
            app.processEvents()
            time.sleep(.01)
        assert next_page_waiting.is_set() and window.job.isRunning()
        assert not window.pdf_labels[1].pixmap().isNull(), "page one must appear while page two is still translating"
        assert not window.export_button.isEnabled()
        window.page_filter.setCurrentIndex(1)
        window.move_page(1)
        assert window.current_page == 0, "translated-only navigation must skip the unfinished page"
        window.page_filter.setCurrentIndex(0)
        with patch('paperdesk.gui.QDesktopServices.openUrl', return_value=True) as opened:
            window.external_pdf_buttons['translated.pdf'].trigger()
            assert not opened.called, 'the complete PDF does not exist yet'
            window.external_pdf_buttons['original.pdf'].trigger()
            assert Path(opened.call_args.args[0].toLocalFile()).name == 'original.pdf'
        window.move_page(1)
        assert '翻訳待ち' in window.pdf_labels[1].text()
        assert not window.external_pdf_buttons['translated.pdf'].isEnabled()
        window.move_page(-1)
        assert not window.pdf_labels[1].pixmap().isNull()
    finally:
        continue_translation.set()
    deadline = time.monotonic() + 30
    while window.job.isRunning() and time.monotonic() < deadline:
        app.processEvents()
        time.sleep(0.01)
    app.processEvents()
    assert not window.job.isRunning()
    assert results and results[0]["pages"] >= 2
    with patch('paperdesk.gui.QDesktopServices.openUrl', return_value=True) as opened:
        window.external_pdf_buttons['translated.pdf'].trigger()
        assert Path(opened.call_args.args[0].toLocalFile()).name == 'translated.pdf'
        with patch('paperdesk.gui.read_preview', return_value={
                'complete': False, 'pages': [], 'total_pages': 2, 'target_pages': [1, 2]}):
            window.update_controls()
            assert window.external_pdf_buttons['translated.pdf'].isEnabled()
            window.external_pdf_buttons['translated.pdf'].trigger()
            assert Path(opened.call_args.args[0].toLocalFile()).name == 'translated.pdf'
        paired = window.library.folder(identity) / 'interleaved.pdf'
        assert paired.is_file()
        paired.unlink()  # Older libraries have no automatic paired output.
        window.external_pdf_buttons['interleaved.pdf'].trigger()
        deadline = time.monotonic() + 20
        while window.job.isRunning() and time.monotonic() < deadline:
            app.processEvents()
            time.sleep(.01)
        app.processEvents()
        assert paired.is_file()
        assert Path(opened.call_args.args[0].toLocalFile()) == paired
    window.select_paper(identity)
    window.render_pages()
    assert not window.pdf_labels[1].pixmap().isNull()
    selection = TranslationPagesDialog(8, 3, window)
    selection.scope.setCurrentIndex(1)
    assert selection.pages == {3}
    selection.scope.setCurrentIndex(2)
    selection.page_input.setText('1, 3-5')
    assert selection.pages == {1, 3, 4, 5}
    selection.page_input.setText('0, 9')
    assert not selection.start_button.isEnabled()
    selection.reject()
    restored_selection = TranslationPagesDialog(8, 1, window, selected_pages={2, 5})
    assert restored_selection.scope.currentIndex() == 2 and restored_selection.pages == {2, 5}
    restored_selection.reject()
    from paperdesk.config import Settings
    connection = Settings(provider="api", model="local-model", base_url="http://localhost:1234/v1",
                          api_key="session-only", reasoning_effort="low")
    presets = TranslationPagesDialog(8, 1, window, settings=connection)
    for name, model, effort in [("sol-medium", "gpt-5.6-sol", "medium"),
                                ("sol-high", "gpt-5.6-sol", "high"),
                                ("terra-medium", "gpt-5.6-terra", "medium")]:
        presets.preset.setCurrentIndex(presets.preset.findData(name))
        chosen = presets.translation_settings()
        assert (chosen.model, chosen.reasoning_effort) == (model, effort)
        assert (chosen.provider, chosen.base_url, chosen.api_key) == ("api", connection.base_url, "session-only")
    presets.preset.setCurrentIndex(presets.preset.findData("connection"))
    assert presets.translation_settings() == connection
    assert connection.model == "local-model" and connection.reasoning_effort == "low"
    presets.reject()
    def choose_page_two(dialog):
        dialog.scope.setCurrentIndex(2)
        dialog.page_input.setText('2')
        dialog.preset.setCurrentIndex(dialog.preset.findData("sol-high"))
        return dialog.DialogCode.Accepted
    with patch('paperdesk.gui.TranslationPagesDialog.exec', choose_page_two), patch.object(window, 'service_job') as start:
        window.translate()
        service = Mock()
        start.call_args.args[0](service, identity)
        service.translate.assert_called_once_with(identity, {2})
        selected_settings = start.call_args.kwargs["settings_override"]
        assert (selected_settings.model, selected_settings.reasoning_effort) == ("gpt-5.6-sol", "high")
        assert window.settings.reasoning_effort == ""
        assert window.preferences.value("translation/preset") == "sol-high"
    # The worker snapshots the translation override, while other operations use global settings.
    with patch.object(window, "run_job") as run:
        window.service_job(lambda service, identity: service.provider.settings.reasoning_effort,
                           None, settings_override=selected_settings)
        selected_settings.reasoning_effort = "low"
        assert run.call_args.args[0](threading.Event(), lambda _: None) == "high"
        window.service_job(lambda service, identity: service.provider.settings.reasoning_effort, None)
        assert run.call_args.args[0](threading.Event(), lambda _: None) == ""
    with patch('paperdesk.gui.TranslationPagesDialog.exec', return_value=0), patch.object(window, 'service_job') as start:
        window.translate()
        start.assert_not_called()
        assert window.preferences.value("translation/preset") == "sol-high"
    window.follow_citation(QUrl(f"paperdesk://{identity}/2"))
    assert window.current_page == 1
    dialog = SettingsDialog(window.settings, window)
    assert dialog.effort.currentData() == ""
    dialog.effort.setCurrentIndex(dialog.effort.findData("high"))
    dialog.provider.setCurrentIndex(1)
    assert dialog.url.isEnabled()
    assert dialog.settings().reasoning_effort == "high"
    settings_root = root / "effort-settings"
    dialog.settings().save(settings_root)
    restored_dialog = SettingsDialog(type(window.settings).load(settings_root), window)
    assert restored_dialog.effort.currentData() == "high"
    restored_dialog.provider.setCurrentIndex(0)
    assert restored_dialog.settings().reasoning_effort == "high"
    restored_dialog.reject()
    dialog.reject()
    window.report_progress("翻訳 3/12 — 完了 5/40 ブロック")
    assert (window.progress_bar.value(), window.progress_bar.maximum()) == (3, 12)
    window.report_progress("日本語PDFを作成しています…")
    assert window.progress_bar.maximum() == 0
    # Non-adjacent translated pages retain original page numbers in both panes.
    three_pages = root / 'three-pages.pdf'
    with fitz.open(Path(__file__).parent / 'fixtures/sample.pdf') as original, fitz.open() as pdf:
        pdf.insert_pdf(original)
        pdf.insert_pdf(original, from_page=0, to_page=0)
        pdf.save(three_pages)
    selected_id, _ = window.library.import_pdf(three_pages)
    PaperService(window.library, FakeProvider(), threading.Event()).translate(selected_id, {1, 3})
    window.select_paper(selected_id)
    window.page_filter.setCurrentIndex(1)
    window.move_page(1)
    assert window.current_page == 2 and '原文 p.3' in window.page_label.text()
    assert not window.pdf_labels[1].pixmap().isNull()
    window.follow_citation(QUrl(f'paperdesk://{selected_id}/2'))
    assert window.page_filter.currentIndex() == 0 and window.current_page == 1
    assert window.pdf_captions[1].text() == '原文（未翻訳）'
    assert window.export_button.isEnabled()
    window.reader_split.setSizes([700, 500])
    saved = window.reader_split.sizes()
    window.close()
    app.processEvents()
    reopened = Window(root)
    assert reopened.preferences.value("translation/preset") == "sol-high"
    assert reopened.preferences.value("window/geometry")
    assert reopened._paper_tree_item(identity).parent().isExpanded()
    # QSplitter renormalises to the current width, so compare the proportion rather than the pixels.
    assert abs(reopened.reader_split.sizes()[0] / sum(reopened.reader_split.sizes())
               - saved[0] / sum(saved)) < 0.02
    duplicate = reopened.library.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
    assert duplicate == (identity, False)
    reopened.close()
    app.processEvents()
print("GUI smoke test passed: folder tree, PDF panes, background translation, notes, search, citations, settings, progress reporting, saved layout")
