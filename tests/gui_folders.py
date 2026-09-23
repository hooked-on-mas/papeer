"""Folder menu and drag/drop integration checks with an isolated library."""
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import Mock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PySide6.QtCore import QMimeData, QPointF, Qt, QUrl
from PySide6.QtGui import QDragEnterEvent, QDropEvent
from PySide6.QtWidgets import QApplication, QMenu

from paperdesk.gui.gui import COLLECTION_ROLE, ITEM_KIND_ROLE, STYLE, Window
from paperdesk.core.storage import Library


app = QApplication.instance() or QApplication([])
app.setStyleSheet(STYLE)
fixture = Path(__file__).parent / "fixtures/sample.pdf"


def folder(tree, path):
    pending = [tree.topLevelItem(index) for index in range(tree.topLevelItemCount())]
    while pending:
        item = pending.pop()
        if item.data(0, ITEM_KIND_ROLE) == "folder" and item.data(0, COLLECTION_ROLE) == path:
            return item
        pending.extend(item.child(index) for index in range(item.childCount()))
    raise AssertionError(f"Folder not found: {path}")


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    window = Window(root / "library")
    first, _ = window.library.import_pdf(fixture, "制御 / 読書会")
    other_pdf = root / "other.pdf"
    other_pdf.write_bytes(fixture.read_bytes() + b"\n% another PDF")
    second, _ = window.library.import_pdf(other_pdf, "資料")
    window.library.update(first, title="First paper")
    window.library.update(second, title="Second paper")
    window.refresh_list()
    window.show()
    window.select_paper(first, 1)
    app.processEvents()
    tree = window.paper_list
    window.note.setPlainText("移動前の未保存メモ")
    window.edit_title.setText("未保存タイトル")
    original = window.library.folder(first) / "original.pdf"
    original_bytes = original.read_bytes()

    # Menu destinations include folders hidden by search, plus implicit parents.
    window.search.setText("First paper")
    def choose_existing(menu, _position):
        actions = menu.actions()[0].menu().actions()
        assert {"未分類", "制御", "制御 / 読書会", "資料"} <= {action.text() for action in actions}
        next(action for action in actions if action.text() == "資料").trigger()
    class ChoosingMenu(QMenu):
        def exec(self, position):
            choose_existing(self, position)
    with patch("paperdesk.gui.gui.QMenu", ChoosingMenu):
        window.show_library_menu(tree.visualItemRect(window._paper_tree_item(first)).center())
    assert window.library.paper(first)["collection_name"] == "資料"
    assert window.collection.text() == "資料"
    assert window.current_page == 1
    assert window.edit_title.text() == "未保存タイトル"
    assert window.note.toPlainText() == "移動前の未保存メモ"
    window.search.clear()

    # New folder input and cancellation go through the same saved move operation.
    with patch("paperdesk.gui.gui.QInputDialog.getText", return_value=(r"研究\2026", True)):
        window.choose_new_collection(first, "資料")
    with patch("paperdesk.gui.gui.QInputDialog.getText", return_value=("キャンセル", False)):
        window.choose_new_collection(first, "研究 / 2026")
    assert window.library.paper(first)["collection_name"] == "研究 / 2026"

    # Internal drag payload is produced only for a PDF; Qt must not delete its row.
    tree.setCurrentItem(window._paper_tree_item(first))
    with patch("paperdesk.gui.gui.QDrag.exec", return_value=Qt.DropAction.MoveAction) as dragged:
        tree.startDrag(Qt.DropAction.MoveAction)
        dragged.assert_called_once()
        tree.setCurrentItem(folder(tree, "資料"))
        tree.startDrag(Qt.DropAction.MoveAction)
        assert dragged.call_count == 1
    mime = QMimeData()
    mime.setData(tree.paper_mime, first.encode("ascii"))
    target = folder(tree, "資料")
    event = Mock()
    event.source.return_value = tree
    event.mimeData.return_value = mime
    event.position.return_value = QPointF(tree.visualItemRect(target).center())
    tree.dragMoveEvent(event)
    assert tree.drop_target is target
    tree.expand_drop_target()
    assert target.isExpanded()
    tree.dropEvent(event)
    assert tree.drop_target is None
    assert window.library.paper(first)["collection_name"] == "資料"
    assert window._paper_tree_item(first).parent().data(0, COLLECTION_ROLE) == "資料"

    # A PDF row is not a drop destination, and foreign internal payloads are rejected.
    event.reset_mock()
    event.position.return_value = QPointF(tree.visualItemRect(window._paper_tree_item(second)).center())
    tree.dropEvent(event)
    event.ignore.assert_called_once()
    event.source.return_value = None
    assert not tree.accepts_drag(event)

    # "Unfiled" remains available even when every PDF already belongs to a folder.
    event.source.return_value = tree
    event.position.return_value = QPointF(tree.visualItemRect(folder(tree, "")).center())
    tree.dropEvent(event)
    assert window.library.paper(first)["collection_name"] == ""

    # Real Qt URL drag/drop events are delivered to the viewport. The target overrides
    # the selected folder, while external files are copied, never moved or deleted.
    incoming = root / "incoming.pdf"
    incoming.write_bytes(fixture.read_bytes() + b"\n% external drop")
    urls = QMimeData()
    urls.setUrls([QUrl.fromLocalFile(str(incoming))])
    app.processEvents()
    target_pos = tree.visualItemRect(folder(tree, "資料")).center()
    tree.imports_enabled = False
    enter = QDragEnterEvent(target_pos, Qt.DropAction.CopyAction, urls,
                           Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
    app.sendEvent(tree.viewport(), enter)
    assert not enter.isAccepted()
    tree.imports_enabled = True
    enter = QDragEnterEvent(target_pos, Qt.DropAction.CopyAction, urls,
                           Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
    app.sendEvent(tree.viewport(), enter)
    assert enter.isAccepted()
    drop = QDropEvent(QPointF(target_pos), Qt.DropAction.CopyAction, urls,
                      Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
    app.sendEvent(tree.viewport(), drop)
    assert drop.isAccepted()
    deadline = time.monotonic() + 15
    while window.job.isRunning() and time.monotonic() < deadline:
        app.processEvents()
        time.sleep(.01)
    app.processEvents()
    assert not window.job.isRunning()
    imported = next(paper for paper in window.library.papers() if paper["original_name"] == "incoming.pdf")
    assert imported["collection_name"] == "資料"
    assert incoming.exists()
    assert original.read_bytes() == original_bytes
    window.close()
    app.processEvents()
    reopened = Library(root / "library")
    assert reopened.paper(first)["collection_name"] == ""
    assert reopened.paper(first)["note"] == "移動前の未保存メモ"
    assert reopened.paper(imported["id"])["collection_name"] == "資料"

print("Folder GUI checks passed: context menu, new classification, internal move, URL drop, persistence and notes")
