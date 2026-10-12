"""The links between a paper and a notebook: /api/item-links and /api/papers/{id}/links."""
from __future__ import annotations

from pathlib import Path
import threading

from fastapi.testclient import TestClient
import pytest

from papeer.core import notebook
from papeer.core.storage import Library, database_version
from sidecar import deps

SAMPLE_PDF = Path(__file__).parent / "fixtures" / "sample.pdf"
MISSING = "f" * 32
LINK_COUNT = ["link_count"]


@pytest.fixture
def world(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    other_pdf = tmp_path / "another.pdf"
    other_pdf.write_bytes(SAMPLE_PDF.read_bytes() + b"\n% another paper\n")
    other, _ = lib.import_pdf(other_pdf)
    events: list[tuple[str, list[str] | None]] = []
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    from sidecar.app import app
    monkeypatch.setattr(deps, "paper_changed", lambda identity, fields=None: events.append((identity, fields)))
    with TestClient(app) as client:
        yield lib, client, paper, other, events


def new_notebook(client, title="ノート", **fields) -> str:
    return client.post("/api/notebooks", json={"title": title, **fields}).json()["id"]


def link_rows(lib: Library) -> list[tuple[str, str]]:
    with lib.connection() as db:
        return [tuple(row) for row in db.execute("SELECT a,b FROM item_links ORDER BY a,b")]


def link_events(events) -> list[tuple[str, list[str] | None]]:
    return sorted(event for event in events if event[1] == LINK_COUNT)


def test_every_route_needs_the_token(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    book = notebook.create(lib, "ノート", {})
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_TOKEN", "test-token")
    monkeypatch.delenv("PAPEER_DEV_NO_AUTH", raising=False)
    from sidecar.app import app
    base = f"/api/papers/{paper}/links"
    requests = [("get", "/api/item-links", None), ("get", base, None),
                ("post", base, {"target_id": book}), ("delete", f"{base}/{book}", None)]
    with TestClient(app) as client:
        for method, url, body in requests:
            assert getattr(client, method)(url, **({"json": body} if body else {})).status_code == 401, (method, url)
        assert link_rows(lib) == []
        headers = {"Authorization": "Bearer test-token"}
        for method, url, body in requests:
            response = getattr(client, method)(url, headers=headers, **({"json": body} if body else {}))
            assert response.status_code == 200, (method, url, response.text)
        assert link_rows(lib) == []  # The last request unlinked what the third had linked.


def test_a_link_is_one_row_whichever_way_it_is_made_and_both_ends_list_it(world):
    lib, client, paper, other, events = world
    book = new_notebook(client)
    assert client.get("/api/item-links").json() == []
    assert client.post(f"/api/papers/{paper}/links", json={"target_id": book}).json() == {"status": "linked"}
    assert link_events(events) == sorted([(paper, LINK_COUNT), (book, LINK_COUNT)])
    events.clear()
    assert client.post(f"/api/papers/{book}/links", json={"target_id": paper}).json() == {"status": "linked"}
    assert client.post(f"/api/papers/{paper}/links", json={"target_id": book}).json() == {"status": "linked"}
    assert events == []  # Nothing changed, so nothing is announced.
    a, b = sorted((paper, book))
    assert client.get("/api/item-links").json() == [{"a": a, "b": b}]
    assert database_version(lib.root / "library.sqlite3") == 8

    # Each end lists the other as a full row: the shape of the library list.
    from_paper = client.get(f"/api/papers/{paper}/links").json()
    from_book = client.get(f"/api/papers/{book}/links").json()
    assert [row["id"] for row in from_paper] == [book] and [row["id"] for row in from_book] == [paper]
    assert from_paper[0]["kind"] == "notebook" and from_book[0]["kind"] == "pdf"
    assert from_paper[0]["link_count"] == 1 and from_book[0]["link_count"] == 1
    assert from_paper[0] == next(row for row in client.get("/api/papers").json() if row["id"] == book)
    assert from_book[0] == next(row for row in client.get("/api/papers").json() if row["id"] == paper)
    assert client.get(f"/api/papers/{other}/links").json() == []
    assert client.get(f"/api/papers/{paper}").json()["link_count"] == 1


def test_unlinking_is_idempotent_in_either_direction_and_removes_nothing_else(world):
    lib, client, paper, _, events = world
    book = new_notebook(client)
    client.post(f"/api/papers/{paper}/links", json={"target_id": book})
    events.clear()
    assert client.delete(f"/api/papers/{book}/links/{paper}").json() == {"status": "unlinked"}
    assert link_events(events) == sorted([(paper, LINK_COUNT), (book, LINK_COUNT)])
    events.clear()
    assert client.delete(f"/api/papers/{paper}/links/{book}").json() == {"status": "unlinked"}
    assert events == [] and link_rows(lib) == []
    assert client.get(f"/api/papers/{paper}/links").json() == []
    assert client.get(f"/api/papers/{paper}").json()["link_count"] == 0
    # Both items are untouched.
    assert lib.paper(paper) and lib.paper(book)
    assert (lib.folder(book) / "notebook.json").is_file()


@pytest.mark.parametrize("target", ["other", "self"])
def test_two_papers_are_not_linked_nor_an_item_with_itself(world, target):
    lib, client, paper, other, events = world
    response = client.post(f"/api/papers/{paper}/links", json={"target_id": other if target == "other" else paper})
    assert response.status_code == 400
    assert link_rows(lib) == [] and link_events(events) == []


def test_two_notebooks_are_not_linked(world):
    lib, client, *_ = world
    first, second = new_notebook(client, "一"), new_notebook(client, "二")
    assert client.post(f"/api/papers/{first}/links", json={"target_id": second}).status_code == 400
    assert client.post(f"/api/papers/{first}/links", json={"target_id": first}).status_code == 400
    assert link_rows(lib) == []


def test_a_notebook_held_by_another_item_is_not_linked_either_way(world):
    lib, client, paper, other, events = world
    held = new_notebook(client, "持ち物", parent_id=paper)
    book = new_notebook(client)
    for owner, target in ((other, held), (held, other), (book, held), (held, book), (paper, held), (held, paper)):
        assert client.post(f"/api/papers/{owner}/links", json={"target_id": target}).status_code == 400, (owner, target)
    assert link_rows(lib) == [] and link_events(events) == []


def test_missing_items_are_404_in_every_position(world):
    lib, client, paper, _, events = world
    book = new_notebook(client)
    before = len(events)
    assert client.get(f"/api/papers/{MISSING}/links").status_code == 404
    assert client.get("/api/papers/not-an-id/links").status_code == 404
    assert client.post(f"/api/papers/{MISSING}/links", json={"target_id": book}).status_code == 404
    assert client.post(f"/api/papers/{paper}/links", json={"target_id": MISSING}).status_code == 404
    assert client.post(f"/api/papers/{paper}/links", json={"target_id": "../x"}).status_code == 404
    assert client.delete(f"/api/papers/{MISSING}/links/{book}").status_code == 404
    assert client.delete(f"/api/papers/{paper}/links/{MISSING}").status_code == 404
    assert client.post(f"/api/papers/{paper}/links", json={}).status_code == 422
    assert client.post(f"/api/papers/{paper}/links", json={"target_id": book, "extra": 1}).status_code == 422
    assert link_rows(lib) == [] and len(events) == before


def test_a_linked_notebook_cannot_be_put_into_an_owner_and_can_once_unlinked(world):
    lib, client, paper, other, _ = world
    book = new_notebook(client)
    client.post(f"/api/papers/{paper}/links", json={"target_id": book})
    refused = client.post(f"/api/notebooks/{book}/placement", json={"parent_id": other})
    assert refused.status_code == 400
    assert lib.paper(book)["parent_id"] is None and link_rows(lib) == [tuple(sorted((paper, book)))]
    client.delete(f"/api/papers/{paper}/links/{book}")
    assert client.post(f"/api/notebooks/{book}/placement", json={"parent_id": other}).status_code == 200
    assert client.post(f"/api/papers/{paper}/links", json={"target_id": book}).status_code == 400
    assert link_rows(lib) == []


def test_removing_an_end_removes_the_link_and_only_the_link(world):
    lib, client, paper, other, _ = world
    book = new_notebook(client)
    second = new_notebook(client, "二冊目")
    for identity, target in ((paper, book), (other, book), (paper, second)):
        client.post(f"/api/papers/{identity}/links", json={"target_id": target})
    assert len(link_rows(lib)) == 3
    assert client.delete(f"/api/papers/{book}").status_code == 200
    assert link_rows(lib) == [tuple(sorted((paper, second)))]
    assert lib.paper(paper) and lib.paper(other) and lib.paper(second)
    assert client.get(f"/api/papers/{paper}").json()["link_count"] == 1
    assert client.get(f"/api/papers/{other}").json()["link_count"] == 0
    assert client.delete(f"/api/papers/{paper}").status_code == 200
    assert link_rows(lib) == [] and lib.paper(second)
    assert client.get(f"/api/papers/{second}/links").json() == []


def test_a_link_that_is_not_a_pair_can_still_be_removed(world):
    lib, client, paper, other, _ = world
    a, b = sorted((paper, other))
    with lib.connection() as db:
        db.execute("INSERT INTO item_links(a,b) VALUES(?,?)", (a, b))
    assert client.get("/api/item-links").json() == [{"a": a, "b": b}]
    assert [row["id"] for row in client.get(f"/api/papers/{paper}/links").json()] == [other]
    assert client.delete(f"/api/papers/{other}/links/{paper}").json() == {"status": "unlinked"}
    assert link_rows(lib) == []


def test_linking_waits_for_a_placement_in_progress(world):
    lib, client, paper, _, _ = world
    book = new_notebook(client)
    done = threading.Event()
    result: list[int] = []

    def request():
        result.append(client.post(f"/api/papers/{paper}/links", json={"target_id": book}).status_code)
        done.set()

    with notebook.lock(lib.root, "placement"):
        worker = threading.Thread(target=request)
        worker.start()
        assert not done.wait(0.3)  # The lock move, create and delete take: the check and the write wait for them.
        assert link_rows(lib) == []
    assert done.wait(10)
    worker.join()
    assert result == [200] and link_rows(lib) == [tuple(sorted((paper, book)))]
