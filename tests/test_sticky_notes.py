import pymupdf
import pytest
from fastapi.testclient import TestClient

from _legacy_library import mark_unversioned
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
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    return lib, ids


def test_legacy_notes_migrate_and_new_positions_survive_reopen(notes_env):
    lib, (alpha, beta) = notes_env
    old = lib.add_bookmark(alpha, 1, "original", "old quote", "疑問", "old note", .42)
    with lib.connection() as db:
        db.execute("ALTER TABLE bookmarks DROP COLUMN anchor_x")
        mark_unversioned(db)  # as saved by a version before schema versioning
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


def test_highlights_are_saved_listed_recoloured_and_restored_with_their_rectangles(notes_env):
    lib, (alpha, beta) = notes_env
    rects = [[.1, .2, .5, .02], [.1, .225, .3, .02]]
    with TestClient(runtime.app) as client:
        base = f"/api/papers/{alpha}/sticky-notes"
        saved = client.post(base, json={"page": 1, "side": "original", "quote": "Alpha passage", "label": "",
                                        "kind": "highlight", "color": "yellow", "rects": rects,
                                        "anchor_x": .1, "anchor_y": .2})
        assert saved.status_code == 200
        item = saved.json()
        assert (item["kind"], item["color"], item["rects"], item["label"]) == ("highlight", "yellow", rects, "")
        listed = client.get("/api/sticky-notes").json()
        assert listed[0]["rects"] == rects and listed[0]["paper_title"] == "Alpha"
        # Recoloured and given a memo, it keeps having no label (a note falls back to 重要).
        edited = client.patch(f"{base}/{item['id']}", json={"label": "", "note": "要確認", "color": "blue"}).json()
        assert (edited["color"], edited["note"], edited["label"], edited["rects"]) == ("blue", "要確認", "", rects)
        assert client.patch(f"{base}/{item['id']}", json={"color": "red"}).status_code == 422
        # The colour alone: the label and memo stay (a note's too, which never takes a colour).
        labelled = client.patch(f"{base}/{item['id']}", json={"label": "疑問", "note": "要確認"}).json()
        recoloured = client.patch(f"{base}/{item['id']}", json={"color": "pink"}).json()
        assert (recoloured["color"], recoloured["label"], recoloured["note"]) == ("pink", "疑問", "要確認")
        assert labelled["label"] == "疑問"
        edited = client.patch(f"{base}/{item['id']}", json={"label": "", "note": "要確認", "color": "blue"}).json()
        # A sticky note never takes a colour or rectangles.
        note = client.post(base, json={"page": 1, "side": "original", "quote": "q", "color": "pink", "rects": rects}).json()
        assert (note["kind"], note["color"], note["rects"]) == ("note", "", [])
        assert client.patch(f"{base}/{note['id']}", json={"label": "", "color": "green"}).json()["label"] == "重要"
        assert client.patch(f"{base}/{note['id']}", json={"label": "", "color": "green"}).json()["color"] == ""
        moved = client.patch(f"{base}/{note['id']}", json={"label": "引用", "note": "n"}).json()
        assert client.patch(f"{base}/{note['id']}", json={"anchor_x": .3}).json()["label"] == moved["label"] == "引用"
        # Deleted and restored from the list's undo, which posts the item back as it was.
        assert client.delete(f"{base}/{item['id']}").json()["deleted"]
        restored = client.post(base, json=edited).json()
        assert (restored["kind"], restored["color"], restored["rects"], restored["note"]) == ("highlight", "blue", rects, "要確認")
        assert lib.highlights_by_page(alpha, "original") == {1: [{"color": "#60a5fa", "rects": rects}]}
        assert lib.highlights_by_page(alpha, "translated") == {} and lib.highlights_by_page(beta, "original") == {}
    # A rectangle ending at the page's edge by a rounding error is kept, rounded onto the page.
    edge = lib.add_bookmark(beta, 1, "original", "Beta", "", kind="highlight", color="pink", rects=[[0.123456789, .5, 0.87655, .01]])
    [[x, _, width, _]] = edge["rects"]
    assert (x, width) == (0.12346, 0.87654) and x + width <= 1 + 1e-9


@pytest.mark.parametrize("change", [
    {"rects": []},                                   # nothing to highlight
    {"color": ""},                                   # no colour
    {"color": "red"},                                # not one of the colours
    {"quote": "  "},                                 # no text: it could not be found or quoted
    {"rects": [[.8, .2, .3, .02]]},                  # past the page's right edge
    {"rects": [[.1, .2, 0, .02]]},                   # empty
    {"rects": [[.1, .2, .3]]},                       # not a rectangle
    {"rects": [[.1, .2, .3, .02]] * 401},            # too many
    {"kind": "ink"},
])
def test_invalid_highlights_are_refused(notes_env, change):
    _, (alpha, _) = notes_env
    body = {"page": 1, "side": "original", "quote": "Alpha", "kind": "highlight", "color": "yellow",
            "rects": [[.1, .2, .3, .02]], **change}
    with TestClient(runtime.app) as client:
        response = client.post(f"/api/papers/{alpha}/sticky-notes", json=body)
        assert response.status_code in (400, 422)
        assert client.get("/api/sticky-notes").json() == []


def test_highlight_colours_match_the_request_schema():
    from typing import get_args
    from papeer.core.storage import HIGHLIGHT_COLORS
    from sidecar.schemas import HighlightColor
    assert set(get_args(HighlightColor)) == set(HIGHLIGHT_COLORS)
