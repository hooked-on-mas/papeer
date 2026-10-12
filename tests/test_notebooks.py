import json
from contextlib import contextmanager
import shutil

from fastapi.testclient import TestClient
import pymupdf
import pytest

from papeer.core import notebook
from papeer.core.errors import Invalid
from papeer.core.storage import Library, database_version


@pytest.fixture
def book(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    from sidecar.app import app
    with TestClient(app) as client:
        yield lib, client


@pytest.mark.parametrize("size", notebook.SIZES)
@pytest.mark.parametrize("orientation", ["portrait", "landscape"])
def test_paper_sizes_and_templates(book, size, orientation):
    lib, client = book
    for template in notebook.TEMPLATES:
        identity = client.post("/api/notebooks", json={"size": size, "orientation": orientation, "template": template, "color": "dark"}).json()["id"]
        document = notebook.read(lib, identity)
        with pymupdf.open(lib.folder(identity) / "original.pdf") as pdf:
            assert len(pdf) == 1
            assert pdf[0].rect.width == pytest.approx(document["pages"][0]["width_mm"] * 72 / 25.4, abs=.01)
        assert database_version(lib.root / "library.sqlite3") == 8
        assert not (lib.folder(identity) / "document.json").exists()
        assert lib.document(identity)["pages"][0]["text"] == ""


def test_page_edits_keep_stable_ink_and_bookmarks(book):
    lib, client = book
    identity = client.post("/api/notebooks", json={"title": "手帳"}).json()["id"]
    base = f"/api/notebooks/{identity}"
    first = client.get(base).json()
    page_id = first["pages"][0]["id"]
    lib.save_ink(identity, "original", 1, [{"id": "s", "points": [[.1, .2], [.2, .3]], "color": "#000000", "width": .003}])
    mark = lib.add_bookmark(identity, 1, "original", "", "重要", "書込")
    duplicate = client.post(base + "/pages", json={"revision": 1, "action": "duplicate", "page_id": page_id}).json()
    assert len(duplicate["pages"]) == 2
    assert lib.ink(identity, "original", 2) == lib.ink(identity, "original", 1)
    assert len(lib.bookmarks(identity)) == 2
    assert len({row["id"] for row in lib.bookmarks(identity)}) == 2
    order = [page["id"] for page in reversed(duplicate["pages"])]
    assert client.post(base + "/pages", json={"revision": 2, "action": "reorder", "order": order}).status_code == 200
    assert next(row for row in lib.bookmarks(identity) if row["id"] == mark["id"])["page"] == 2
    assert client.put(f"/api/papers/{identity}/ink-v2/original/1", json={"strokes": []}).status_code == 409
    assert client.put(base + f"/pages/{page_id}/ink", json={"strokes": []}).status_code == 200
    assert lib.ink(identity, "original", 1) and not lib.ink(identity, "original", 2)
    assert client.post(base + "/pages", json={"revision": 1, "action": "append"}).status_code == 409
    assert client.post(base + "/pages", json={"revision": 3, "action": "delete", "page_id": page_id}).status_code == 200
    assert client.put(base + f"/pages/{page_id}/ink", json={"strokes": []}).status_code == 404
    assert client.post(base + "/pages", json={"revision": 4, "action": "delete", "page_id": order[0]}).status_code == 400
    assert client.get(f"/api/papers/{identity}/reading").json()["original_mtime"] == 4
    assert lib.rename_paper(identity, "改名") == "改名"


def test_ownership_guard_and_keep_on_delete(book):
    lib, client = book
    parent = notebook.create(lib, "親", {})
    child = notebook.create(lib, "子", {}, collection="幽霊", parent_id=parent)
    assert lib.paper(child)["collection_name"] == ""
    with pytest.raises(Invalid):
        notebook.create(lib, "孫", {}, parent_id=child)
    assert client.post(f"/api/papers/{child}/attachments", json={}).status_code == 400
    with pytest.raises(ValueError):
        lib.update(child, collection_name="不可")
    assert len(client.get("/api/notebooks").json()) == 2
    assert len(client.get("/api/papers").json()) == 1
    lib.update(parent, collection_name="研究")
    assert client.delete(f"/api/papers/{parent}?keep_notebooks=true").status_code == 200
    assert lib.paper(child)["parent_id"] is None and lib.paper(child)["collection_name"] == "研究"


@pytest.mark.parametrize("target", ["notebook.json", "original.pdf"])
def test_file_failure_rolls_back_then_retries(book, monkeypatch, target):
    lib, _ = book
    identity = notebook.create(lib, "復旧", {})
    before = notebook.read(lib, identity)
    original = (lib.folder(identity) / "original.pdf").read_bytes()
    function = notebook.atomic_write_text if target.endswith("json") else notebook.atomic_write_bytes
    once = True
    def fail(path, data):
        nonlocal once
        if path.name == target and once:
            once = False
            raise OSError("simulated replacement failure")
        return function(path, data)
    monkeypatch.setattr(notebook, "atomic_write_text" if target.endswith("json") else "atomic_write_bytes", fail)
    with pytest.raises(OSError):
        notebook.change(lib, identity, 1, "append")
    assert notebook.read(lib, identity) == before
    assert (lib.folder(identity) / "original.pdf").read_bytes() == original
    assert lib.paper(identity)["pages"] == 1
    assert len(notebook.change(lib, identity, 1, "append")["pages"]) == 2


def test_interrupted_post_commit_cleanup_finishes_on_live_open(book, monkeypatch):
    lib, _ = book
    identity = notebook.create(lib, "復旧", {})
    clean = notebook._clean
    monkeypatch.setattr(notebook, "_clean", lambda folder: (_ for _ in ()).throw(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        notebook.change(lib, identity, 1, "append")
    folder = lib.folder(identity)
    journal = folder / ".notebook-change.json"
    assert journal.exists()
    assert json.loads(journal.read_text("utf-8"))["after"]["revision"] == 2
    monkeypatch.setattr(notebook, "_clean", clean)
    reopened = Library(lib.root)
    assert len(notebook.read(reopened, identity)["pages"]) == reopened.paper(identity)["pages"] == 2
    assert not journal.exists()


def test_commit_failure_restores_database_files_and_annotations(book, monkeypatch):
    lib, _ = book
    identity = notebook.create(lib, "復旧", {})
    mark = lib.add_bookmark(identity, 1, "original", "", "重要", "残す")
    original = lib.connection
    @contextmanager
    def fail_commit():
        with original() as db:
            yield db
            if db.in_transaction:
                raise OSError("simulated database commit failure")
    monkeypatch.setattr(lib, "connection", fail_commit)
    with pytest.raises(OSError):
        notebook.change(lib, identity, 1, "append")
    monkeypatch.setattr(lib, "connection", original)
    assert notebook.read(lib, identity)["revision"] == 1
    assert lib.paper(identity)["pages"] == 1
    assert lib.bookmarks(identity) == [mark]
    with pymupdf.open(lib.folder(identity) / "original.pdf") as pdf:
        assert len(pdf) == 1


def test_snapshot_comparison_never_replays_notebook_recovery(book, monkeypatch, tmp_path):
    from papeer.core.drive_sync import library_difference
    lib, _ = book
    identity = notebook.create(lib, "復旧", {})
    monkeypatch.setattr(notebook, "_clean", lambda folder: (_ for _ in ()).throw(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        notebook.change(lib, identity, 1, "append")
    snapshot = tmp_path / "snapshot"
    shutil.copytree(lib.root, snapshot)
    before = {path.relative_to(snapshot): path.read_bytes() for path in snapshot.rglob("*") if path.is_file()}
    library_difference(lib.root / "library.sqlite3", snapshot / "library.sqlite3")
    assert {path.relative_to(snapshot): path.read_bytes() for path in snapshot.rglob("*") if path.is_file()} == before


def test_stale_number_bookmark_and_capture_requests_resolve_stable_page(book):
    lib, client = book
    identity = notebook.create(lib, "安定ID", {})
    document = notebook.change(lib, identity, 1, "append")
    first, second = [page["id"] for page in document["pages"]]
    notebook.change(lib, identity, 2, "reorder", order=[second, first])
    note = {"page": 1, "page_id": first, "side": "original", "quote": "", "note": "最初のページ"}
    result = client.post(f"/api/papers/{identity}/sticky-notes", json=note)
    assert result.status_code == 200 and result.json()["page"] == 2 and result.json()["page_id"] == first
    assert client.post(f"/api/papers/{identity}/sticky-notes", json={**note, "page_id": None}).status_code == 409
    capture = {"page": 1, "page_id": first, "side": "original", "x": .1, "y": .1, "width": .2, "height": .2}
    assert client.post(f"/api/papers/{identity}/ink-capture-v2", json=capture).status_code == 200
    assert client.post(f"/api/papers/{identity}/ink-capture-v2", json={**capture, "page_id": None}).status_code == 409
    notebook.change(lib, identity, 3, "delete", page_id=first)
    assert client.post(f"/api/papers/{identity}/sticky-notes", json=note).status_code == 404
    assert client.post(f"/api/papers/{identity}/ink-capture-v2", json=capture).status_code == 404


def test_resizing_preserves_normalized_ink_and_exported_paper_color(book):
    lib, client = book
    identity = notebook.create(lib, "色", {"color": "dark", "template": "dot5"})
    document = notebook.read(lib, identity)
    stroke = {"id": "stroke", "points": [[.2,.3],[.4,.5]], "color": "#ff0000", "width": .003}
    lib.save_ink(identity, "original", 1, [stroke])
    notebook.change(lib, identity, 1, "paper", page_id=document["pages"][0]["id"], spec={"size": "16:9", "orientation": "landscape", "color": "dark", "template": "cornell"})
    assert lib.ink(identity, "original", 1) == [stroke]
    response = client.post(f"/api/papers/{identity}/ink-export", json={"side": "original"})
    assert response.status_code == 200
    with pymupdf.open(stream=response.content, filetype="pdf") as pdf:
        assert pdf[0].rect.width / pdf[0].rect.height == pytest.approx(16/9)
        pixel = pdf[0].get_pixmap().pixel(2,2)
        assert pixel[0] < 40 and pixel[1] < 45 and pixel[2] < 50
        assert any(drawing["color"] == (1,0,0) for drawing in pdf[0].get_drawings())
