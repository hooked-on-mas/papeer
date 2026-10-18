"""Browser operations applied to a real desktop library, retaining PC edits and PDF bytes."""
import hashlib
import json
import threading
import uuid

import pymupdf
import pytest

from papeer.core.cloud_annotations import import_operations
from papeer.core.cloud_drive import snapshot
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library


class Remote:
    def __init__(self, operations):
        self.operations = operations

    def list(self, _):
        return [{"id": str(i), "size": len(json.dumps(op))} for i, op in enumerate(self.operations)]

    def json(self, url):
        return self.operations[int(url.split("/")[-1].split("?")[0])]


@pytest.fixture
def setup(tmp_path):
    source = tmp_path / "source.pdf"
    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((40, 40), "Original")
        pdf.save(source)
    lib = Library(tmp_path / "library")
    paper, _ = lib.import_pdf(source)
    files = PaperFiles(lib.folder(paper))
    files.translated_pdf.write_bytes(source.read_bytes())
    lib.save_ink(paper, "translated", 1, [{"id": "pc", "color": "#0000ff", "width": .003, "points": [[.1, .1]]}])
    def op(action="add", target=None, **changes):
        identity = str(uuid.uuid4())
        value = {"version": 1, "id": identity, "library_id": "library", "paper_id": paper, "side": "translated",
                 "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "page": 1, "action": action}
        if action == "add":
            value["stroke"] = {"id": "web-" + identity, "kind": "pen", "color": "#ff0000", "width": .003, "points": [[.2, .2], [.4, .4]]}
        else:
            value["target"] = target
        return value | changes
    return lib, paper, files, op


def apply(lib, *ops):
    return import_operations(lib, Remote(ops), "library", threading.Event())


def test_add_replay_and_pc_deletion_are_idempotent(setup, tmp_path):
    lib, paper, files, op = setup
    before = files.translated_pdf.read_bytes()
    added = op()
    assert apply(lib, added, added) == 1
    strokes = lib.ink(paper, "translated", 1)
    assert [s["id"] for s in strokes] == ["pc", added["stroke"]["id"]]
    assert files.translated_pdf.read_bytes() == before
    lib.save_ink(paper, "translated", 1, strokes[:1])
    assert apply(lib, added) == 0
    assert lib.ink(paper, "translated", 1) == strokes[:1]
    target = tmp_path / "snapshot"; target.mkdir()
    snapshot(lib, target, threading.Event())
    exported = json.loads((target / "web-annotations.json").read_text("utf-8"))
    assert exported["applied"] == [added["id"]]
    assert exported["pages"][f"{paper}/translated/1"]["strokes"] == strokes[:1]


@pytest.mark.parametrize("order", ["remove-first", "add-first", "separate"])
def test_remove_is_order_independent_and_preserves_pc_ink(setup, order):
    lib, paper, _, op = setup
    added = op(); removed = op("remove", added["stroke"]["id"])
    if order == "separate":
        apply(lib, removed); apply(lib, added, removed)
    else:
        apply(lib, *([removed, added] if order == "remove-first" else [added, removed]))
    assert [s["id"] for s in lib.ink(paper, "translated", 1)] == ["pc"]


def test_other_pdf_version_or_page_does_not_receive_ink(setup):
    lib, paper, _, op = setup
    assert apply(lib, op(source_sha256="f" * 64), op(page=2)) == 0
    assert [s["id"] for s in lib.ink(paper, "translated", 1)] == ["pc"]


def test_invalid_operations_do_not_partially_apply_or_delete_pc_ink(setup):
    lib, paper, _, op = setup
    with pytest.raises(ValueError):
        apply(lib, op(), op("remove", "pc"))
    assert [s["id"] for s in lib.ink(paper, "translated", 1)] == ["pc"]
    with lib.connection() as db:
        assert db.execute("SELECT count(*) FROM web_annotation_ops").fetchone()[0] == 0


def test_two_devices_and_separate_sides_merge(setup):
    lib, paper, _, op = setup
    first, second, original = op(), op(), op(side="original")
    apply(lib, first); apply(lib, second, original, first)
    assert len(lib.ink(paper, "translated", 1)) == 3
    assert len(lib.ink(paper, "original", 1)) == 1
