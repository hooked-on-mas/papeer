import pymupdf
import pytest
from fastapi.testclient import TestClient

from papeer.core.storage import Library
from sidecar import app as runtime


@pytest.fixture
def notes_env(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    ids = []
    for name in ["Alpha", "Beta"]:
        source = tmp_path / f"{name}.pdf"
        with pymupdf.open() as pdf:
            pdf.new_page().insert_text((72, 72), name)
            pdf.save(source)
        paper, _ = lib.import_pdf(source)
        lib.update(paper, title=name)
        ids.append(paper)
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_TOKEN", "")
    return lib, ids


def test_legacy_notes_migrate_and_new_positions_survive_reopen(notes_env):
    lib, (alpha, beta) = notes_env
    old = lib.add_bookmark(alpha, 1, "original", "old quote", "疑問", "old note", .42)
    with lib.connection() as db:
        db.execute("ALTER TABLE bookmarks DROP COLUMN anchor_x")
    reopened = Library(lib.root)
    assert reopened.bookmarks(alpha)[0] == {**old, "anchor_x": 0}
    with TestClient(runtime.app) as client:
        new = client.post(f"/api/papers/{beta}/sticky-notes", json={
            "page": 1, "side": "translated", "quote": "", "label": "引用", "note": "図の比較", "anchor_y": .65, "anchor_x": .8,
        })
        assert new.status_code == 200
        items = client.get("/api/sticky-notes").json()
        assert {item["paper_title"] for item in items} == {"Alpha", "Beta"}
        assert items[0]["anchor_x"] == .8
        assert items[0]["anchor_y"] == .65
        assert client.get(f"/api/papers/{alpha}/sticky-notes").json()[0]["id"] == old["id"]
        assert client.get(f"/api/papers/{beta}/bookmarks").json()[0]["id"] == new.json()["id"]
    assert Library(lib.root).bookmarks(beta)[0]["anchor_x"] == .8


def test_note_edit_delete_restore_and_authorization(notes_env, monkeypatch):
    lib, (alpha, beta) = notes_env
    with TestClient(runtime.app) as client:
        base = f"/api/papers/{alpha}/sticky-notes"
        saved = client.post(base, json={"page": 1, "side": "original", "quote": "formula", "anchor_x": .5, "anchor_y": .2}).json()
        url = f"{base}/{saved['id']}"
        assert client.patch(f"/api/papers/{beta}/sticky-notes/{saved['id']}", json={"note": "wrong paper"}).status_code == 404
        edited = client.patch(url, json={"label": "疑問", "note": "check equation"}).json()
        assert (edited["anchor_x"], edited["anchor_y"], edited["quote"]) == (.5, .2, "formula")
        moved = client.patch(url, json={"label": edited["label"], "note": edited["note"],
                                        "anchor_x": .8, "anchor_y": .7})
        assert moved.status_code == 200
        reopened = Library(lib.root).bookmarks(alpha)[0]
        assert (reopened["anchor_x"], reopened["anchor_y"], reopened["note"], reopened["quote"]) == (.8, .7, "check equation", "formula")
        for anchor in [{"anchor_x": 1.1}, {"anchor_y": -.1}]:
            assert client.patch(url, json=anchor).status_code == 422
        assert client.patch(f"/api/papers/{beta}/sticky-notes/{saved['id']}",
                            json={"anchor_x": .1, "anchor_y": .1}).status_code == 404
        assert not client.delete(f"/api/papers/{beta}/sticky-notes/{saved['id']}").json()["deleted"]
        assert client.delete(url).json()["deleted"]
        assert client.get("/api/sticky-notes").json() == []
        restored = client.post(base, json=edited).json()
        assert (restored["note"], restored["anchor_x"], restored["quote"]) == ("check equation", .5, "formula")
        for anchor in [{"anchor_x": 1.1}, {"anchor_y": -.1}]:
            assert client.post(base, json={"page": 1, "side": "original", "quote": "", **anchor}).status_code == 422
        monkeypatch.setenv("PAPEER_TOKEN", "test-secret")
        assert client.get("/api/sticky-notes").status_code == 401
        assert client.get(base).status_code == 401
        assert client.get("/api/sticky-notes", headers={"Authorization": "Bearer test-secret"}).status_code == 200
