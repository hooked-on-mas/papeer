"""Isolated checks for folder creation, undo, reading resume, and finding papers."""
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PySide6.QtWidgets import QApplication
from PySide6.QtGui import QFontDatabase
from paperdesk.gui import COLLECTION_ROLE, ITEM_KIND_ROLE, STYLE, Window
from paperdesk.storage import Library

app = QApplication.instance() or QApplication([])
# The offscreen platform does not discover Windows fonts automatically.
if os.environ.get("PAPERDESK_TEST_SCREENSHOTS") and os.name == "nt":
    for filename in ["YuGothR.ttc", "YuGothB.ttc", "segoeui.ttf"]:
        QFontDatabase.addApplicationFont(str(Path(os.environ["WINDIR"]) / "Fonts" / filename))
app.setStyleSheet(STYLE)


def folder(window, name):
    root = window.paper_list.invisibleRootItem()
    pending = [root.child(i) for i in range(root.childCount())]
    while pending:
        item = pending.pop()
        if item.data(0, ITEM_KIND_ROLE) == "folder" and item.data(0, COLLECTION_ROLE) == name:
            return item
        pending.extend(item.child(i) for i in range(item.childCount()))
    raise AssertionError(name)


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    window = Window(root / "library")
    window.show()
    app.processEvents()
    assert window.empty_library_label.isVisible()
    assert not window.page_input.isEnabled()
    assert not window.undo_move_button.isEnabled()
    with patch("paperdesk.gui.QInputDialog.getText", return_value=(r"研究\2026", True)):
        window.create_folder()
    assert Library(window.root).collections() == ["研究", "研究 / 2026"]
    assert window.current_collection == "研究 / 2026"
    window.refresh_list()
    assert window.paper_list.currentItem().data(0, COLLECTION_ROLE) == window.current_collection
    with patch("paperdesk.gui.QInputDialog.getText", return_value=("取り消し", False)):
        window.create_folder()
    assert "取り消し" not in window.library.collections()
    fixture = Path(__file__).parent / "fixtures/sample.pdf"
    identity, _ = window.library.import_pdf(fixture, "研究 / 2026")
    second_pdf = root / "second.pdf"
    second_pdf.write_bytes(fixture.read_bytes() + b"\n% second")
    second, _ = window.library.import_pdf(second_pdf, "資料")
    window.library.update(identity, title="Adaptive Control")
    window.library.update(second, title="Robot Design")
    window.refresh_list()
    window.select_paper(identity)
    app.processEvents()

    window.move_paper(identity, "資料")
    window.move_paper(identity, "")
    assert window.undo_move_button.isEnabled()
    window.undo_move_button.click()
    assert window.library.paper(identity)["collection_name"] == "資料"
    window.undo_move_button.click()
    assert window.library.paper(identity)["collection_name"] == "研究 / 2026"
    assert not window.undo_move_button.isEnabled()
    window.move_paper(identity, "資料")
    window.library.update(identity, collection_name="研究 / 2026")
    window.undo_move()
    assert window.library.paper(identity)["collection_name"] == "研究 / 2026"
    assert not window.undo_move_button.isEnabled()

    window.refresh_list()
    folder(window, "研究").setExpanded(False)
    window.search.setText("Adaptive")
    assert folder(window, "研究").isExpanded()
    window.search.clear()
    assert not folder(window, "研究").isExpanded()
    window.search.setText("no matching paper")
    assert window.empty_library_label.isVisible()
    assert window.clear_filters_button.isVisible()
    window.reveal_current_paper()
    assert not window.search.text()
    assert folder(window, "研究").isExpanded()

    window.page_input.setValue(2)
    window.jump_button.click()
    assert window.current_page == 1
    window.select_paper(second)
    assert window.current_page == 0
    window.select_paper(identity)
    assert window.current_page == 1
    window.page_filter.setCurrentIndex(1)
    window.page_input.setValue(2)
    window.jump_to_page()
    assert window.page_filter.currentIndex() == 0 and window.current_page == 1
    app.processEvents()
    screenshot_dir = os.environ.get("PAPERDESK_TEST_SCREENSHOTS")
    if screenshot_dir:
        destination = Path(screenshot_dir)
        destination.mkdir(parents=True, exist_ok=True)
        window.resize(1380, 880)
        app.processEvents()
        window.render_pages()
        window.grab().save(str(destination / "usability-wide.png"))
        window.resize(1000, 680)
        app.processEvents()
        window.render_pages()
        window.grab().save(str(destination / "usability-compact.png"))
    # Compact reader reserves most of the window height for the PDF panes.
    window.resize(1000, 680)
    app.processEvents()
    assert window.pdf_scrolls[0].height() > window.height() * .70
    normal_width = window.pdf_scrolls[0].width()
    window.sidebar_button.click()
    app.processEvents()
    assert not window.sidebar.isVisible()
    assert window.pdf_scrolls[0].width() > normal_width
    window.focus_button.click()
    app.processEvents()
    assert not window.reader_header.isVisible() and not window.tabs.tabBar().isVisible()
    assert window.pdf_scrolls[0].height() > window.height() * .85
    assert window.focus_button.isVisible()
    if screenshot_dir:
        window.render_pages()
        window.grab().save(str(destination / "usability-focus.png"))
    window.focus_button.click()
    assert not window.sidebar.isVisible()  # restore the user's panel choice
    window.focus_search()
    app.processEvents()
    assert window.sidebar.isVisible() and window.reader_header.isVisible()
    # Folder context menu, child creation, rename propagation, and filename export.
    from PySide6.QtWidgets import QMenu
    from PySide6.QtCore import Qt
    window.paper_list.setCurrentItem(folder(window, "研究"))
    class RenameMenu(QMenu):
        def exec(self, position):
            next(a for a in self.actions() if a.text() == "名前を変更…").trigger()
    with patch("paperdesk.gui.QMenu", RenameMenu), patch("paperdesk.gui.QInputDialog.getText", return_value=("実験", True)):
        window.show_library_menu(window.paper_list.visualItemRect(folder(window, "研究")).center())
    assert window.library.paper(identity)["collection_name"] == "実験 / 2026"
    assert window.current_collection == "実験"
    assert window.paper_list.currentItem().data(0, COLLECTION_ROLE) == "実験"
    with patch("paperdesk.gui.QInputDialog.getText", return_value=("子", True)):
        window.create_child_folder()
    assert "実験 / 子" in window.library.collections()
    with patch("paperdesk.gui.QInputDialog.getText", return_value=("資料", True)), patch("paperdesk.gui.QMessageBox.warning") as warning:
        window.rename_folder("実験")
        warning.assert_called_once()
    assert "実験 / 2026" in window.library.collections()
    window.select_paper(identity)
    window.note.setPlainText("名前変更後も残るメモ")
    original = (window.library.folder(identity) / "original.pdf").read_bytes()
    with patch("paperdesk.gui.QInputDialog.getText", return_value=("新しい名前", True)):
        window.rename_selected()
    assert window.library.paper(identity)["original_name"] == "新しい名前.pdf"
    assert window.note.toPlainText() == "名前変更後も残るメモ"
    assert window.library.papers("新しい名前.pdf")[0]["id"] == identity
    with patch("paperdesk.gui.QInputDialog.getText", return_value=("CON.pdf", True)), patch("paperdesk.gui.QMessageBox.warning") as warning:
        window.rename_file(identity)
        warning.assert_called_once()
    exported = root / "export.pdf"
    with patch("paperdesk.gui.QFileDialog.getSaveFileName", return_value=(str(exported), "PDF (*.pdf)")):
        window.save_original(identity)
    assert exported.read_bytes() == original
    assert (window.library.folder(identity) / "original.pdf").read_bytes() == original
    assert not hasattr(window, "favorites") and not hasattr(window, "star_button")
    window.resize(1380, 880)
    window.library_split.setSizes([390, 950])
    window.sort_order.setCurrentIndex(3)
    app.processEvents()
    saved_width = window.library_split.sizes()[0]
    window.close()
    app.processEvents()
    reopened = Window(root / "library")
    assert reopened.current_id == identity and reopened.current_page == 1
    assert folder(reopened, "実験 / 2026") is not None
    reopened.show()
    reopened.resize(1380, 880)
    app.processEvents()
    assert abs(reopened.library_split.sizes()[0] - saved_width) < 5, (saved_width, reopened.library_split.sizes(), reopened.size())
    assert reopened.sort_order.currentIndex() == 3
    assert reopened.library.paper(identity)["note"] == "名前変更後も残るメモ"
    assert reopened.library.paper(identity)["original_name"] == "新しい名前.pdf"
    from PySide6.QtWidgets import QMessageBox, QPushButton
    assert not {"閲覧中へ", "＋ フォルダー"} & {button.text() for button in reopened.findChildren(QPushButton)}
    reopened.library.create_collection("実験追加")
    reopened.note.setPlainText("削除時にも保持するメモ")
    reopened.move_paper(second, "実験")
    # Cancellation leaves the whole subtree and its papers intact.
    with patch("paperdesk.gui.QMessageBox.question", return_value=QMessageBox.StandardButton.Cancel) as question:
        reopened.delete_folder("実験")
        assert "2件" in question.call_args.args[2]
    assert reopened.library.paper(identity)["collection_name"] == "実験 / 2026"
    assert reopened.library.paper(second)["collection_name"] == "実験"
    class DeleteMenu(QMenu):
        def exec(self, position):
            next(a for a in self.actions() if a.text() == "フォルダーを削除").trigger()
    with patch("paperdesk.gui.QMenu", DeleteMenu), patch("paperdesk.gui.QMessageBox.question", return_value=QMessageBox.StandardButton.Ok):
        reopened.show_library_menu(reopened.paper_list.visualItemRect(folder(reopened, "実験")).center())
    assert reopened.library.paper(identity)["collection_name"] == ""
    assert reopened.library.paper(second)["collection_name"] == ""
    assert not any(name == "実験" or name.startswith("実験 / ") for name in reopened.library.collections())
    assert "実験追加" in reopened.library.collections()
    assert reopened.note.toPlainText() == "削除時にも保持するメモ"
    assert reopened.current_page == 1 and reopened.current_id == identity
    assert not reopened.collection.text() and not reopened.current_collection
    assert not reopened.move_history
    assert (reopened.library.folder(identity) / "original.pdf").read_bytes() == original
    # Removing the only empty child preserves its implicit parent; no prompt is needed.
    reopened.library.create_collection("空の親 / 子")
    with patch("paperdesk.gui.QMessageBox.question") as question:
        reopened.delete_folder("空の親 / 子")
        question.assert_not_called()
    assert "空の親" in reopened.library.collections()
    assert "空の親 / 子" not in reopened.library.collections()
    reopened.close()
    persisted = Library(root / "library")
    assert persisted.paper(identity)["collection_name"] == ""
    assert persisted.paper(identity)["note"] == "削除時にも保持するメモ"
    app.processEvents()

print("Usability GUI checks passed: empty folders, undo, search visibility, page jump and reading resume")
