"""HTML documents: what they hold, how they are described and the isolated viewer that shows them."""
import hashlib
from pathlib import Path
import shutil

from fastapi.testclient import TestClient
import pytest

from papeer.core.paths import PaperFiles
from papeer.core.storage import Library
from sidecar import deps, html_documents

TOKEN = "document-test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
# Japanese text, a stylesheet, a data-URI image, a script and CRLF line endings, none of which may be touched.
SOURCE = ("<!doctype html>\r\n<html><head><meta charset=\"utf-8\"><style>body{color:#123;background:url(data:image/png;base64,AAAA)}"
          "</style></head>\r\n<body><h1>図解　資料</h1><img src=\"data:image/gif;base64,R0lGODlhAQABAAAAACw=\">"
          "<script>document.title='実行';</script></body></html>\r\n")
VIEWER_HEADERS = ("content-security-policy", "referrer-policy", "cache-control", "x-content-type-options", "permissions-policy")


@pytest.fixture
def docs(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(Path(__file__).parent / "fixtures" / "sample.pdf")
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.delenv("PAPEER_DEV_NO_AUTH", raising=False)
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    monkeypatch.setattr(html_documents, "_tickets", html_documents._tickets.__class__())
    from sidecar.app import app
    with TestClient(app) as client:
        yield lib, identity, client


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def add(client, owner, content=SOURCE, title="図解.html", source="user"):
    response = client.post(f"/api/papers/{owner}/documents", headers=AUTH,
                           json={"title": title, "content": content, "source": source})
    assert response.status_code == 200, response.text
    return response.json()


def ticket(client, owner, identity, content=SOURCE, allow_scripts=False):
    response = client.post(f"/api/papers/{owner}/documents/{identity}/view", headers=AUTH,
                           json={"allow_scripts": allow_scripts, "content_hash": sha(content)})
    assert response.status_code == 200, response.text
    path = response.json()["path"]
    assert path.startswith("/html-view/")
    return path


def csp(response) -> dict[str, str]:
    """The policy's directives by name."""
    parts = [part.strip() for part in response.headers["content-security-policy"].split(";")]
    return {part.split(" ", 1)[0]: part.partition(" ")[2] for part in parts}


# --- Creating and describing ---

def test_create_document_keeps_the_exact_text_and_describes_it(docs):
    lib, owner, client = docs
    row = add(client, owner, source="imported")
    assert row["format"] == "html" and row["source"] == "imported" and row["owner_id"] == owner
    assert "content" not in row
    assert PaperFiles(lib.folder(owner)).attachment(row["id"], "html").read_bytes() == SOURCE.encode("utf-8")
    assert client.get(f"/api/papers/{owner}", headers=AUTH).json()["attachment_count"] == 1

    described = client.get(f"/api/papers/{owner}/documents/{row['id']}", headers=AUTH).json()
    assert described["content_hash"] == sha(SOURCE)
    assert {key: described[key] for key in row} == row
    assert "content" not in described
    # The generic content route stays for memos: a document's text is not read through it.
    assert client.get(f"/api/papers/{owner}/attachments/{row['id']}", headers=AUTH).status_code == 404
    assert [item["id"] for item in client.get(f"/api/papers/{owner}/attachments", headers=AUTH).json()] == [row["id"]]


def test_document_routes_validate_and_isolate_owners(docs):
    lib, owner, client = docs
    base = f"/api/papers/{owner}/documents"
    assert client.post(base, headers=AUTH, json={"title": "   ", "content": "<p>x</p>"}).status_code == 400
    assert client.post(base, headers=AUTH, json={"title": "", "content": "<p>x</p>"}).status_code == 422
    assert client.post(base, headers=AUTH, json={"title": "a.html", "content": "x", "source": "summary"}).status_code == 422
    assert client.post(base, headers=AUTH, json={"title": "a.html", "content": "x", "format": "md"}).status_code == 422
    assert client.post(f"/api/papers/{'b' * 32}/documents", headers=AUTH,
                       json={"title": "a.html", "content": "x"}).status_code == 404
    assert lib.attachments(owner) == []

    memo = client.post(f"/api/papers/{owner}/attachments", headers=AUTH, json={"title": "メモ.md", "content": "m"}).json()
    row = add(client, owner)
    # A memo is not a document, and a document is not another owner's.
    assert client.get(f"{base}/{memo['id']}", headers=AUTH).status_code == 404
    assert client.post(f"{base}/{memo['id']}/view", headers=AUTH,
                       json={"content_hash": sha("m")}).status_code == 404
    other = "a" * 32
    with lib.connection() as db:
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages) VALUES(?,?,?,?,1)", (other, "different", "other", "other.pdf"))
    assert client.get(f"/api/papers/{other}/documents/{row['id']}", headers=AUTH).status_code == 404
    assert client.post(f"/api/papers/{other}/documents/{row['id']}/view", headers=AUTH,
                       json={"content_hash": sha(SOURCE)}).status_code == 404


def test_document_routes_need_the_token(docs):
    _, owner, client = docs
    row = add(client, owner)
    base = f"/api/papers/{owner}/documents"
    assert client.post(base, json={"title": "a.html", "content": "x"}).status_code == 401
    assert client.get(f"{base}/{row['id']}").status_code == 401
    assert client.post(f"{base}/{row['id']}/view", json={"content_hash": sha(SOURCE)}).status_code == 401
    assert client.post(f"{base}/{row['id']}/view", headers={"Authorization": "Bearer wrong"},
                       json={"content_hash": sha(SOURCE)}).status_code == 401
    assert html_documents._tickets == {}


# --- The viewer ---

def test_viewer_serves_the_exact_source_without_the_token(docs):
    _, owner, client = docs
    row = add(client, owner)
    path = ticket(client, owner, row["id"])
    # No Authorization header, no token parameter: the ticket is the only credential, and it can be used again.
    for _ in range(2):
        response = client.get(path)
        assert response.status_code == 200
        assert response.content == SOURCE.encode("utf-8")
        assert response.headers["content-type"] == "text/html; charset=utf-8"
    # The page that is shown is never given the token, and the token does not stand in for a ticket.
    assert TOKEN.encode() not in response.content
    assert client.get(f"/html-view/{TOKEN}", headers=AUTH).status_code == 404
    assert client.get(f"/html-view/{TOKEN}", params={"token": TOKEN}).status_code == 404


def test_viewer_headers_sandbox_and_close_everything_but_inline_style_and_data(docs):
    _, owner, client = docs
    row = add(client, owner)
    for allow_scripts in (False, True):
        response = client.get(ticket(client, owner, row["id"], allow_scripts=allow_scripts))
        policy = csp(response)
        assert policy["sandbox"] == ("allow-scripts" if allow_scripts else "")
        assert "allow-same-origin" not in response.headers["content-security-policy"]
        assert policy["script-src"] == ("'unsafe-inline'" if allow_scripts else "'none'")
        assert policy["default-src"] == "'none'"
        assert policy["style-src"] == "'unsafe-inline'"
        assert policy["img-src"] == policy["font-src"] == "data:"
        for directive in ("connect-src", "object-src", "frame-src", "worker-src", "base-uri", "form-action"):
            assert policy[directive] == "'none'"
        ancestors = policy["frame-ancestors"].split()
        assert "tauri://localhost" in ancestors and "http://tauri.localhost" in ancestors
        assert "*" not in ancestors and "'self'" not in ancestors and "'none'" not in ancestors
        assert response.headers["referrer-policy"] == "no-referrer"
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        for feature in ("camera=()", "microphone=()", "geolocation=()"):
            assert feature in response.headers["permissions-policy"]


def test_packaged_sidecar_frames_only_the_release_windows(docs, monkeypatch):
    import sys
    _, owner, client = docs
    row = add(client, owner)
    path = ticket(client, owner, row["id"])
    assert "http://localhost:1420" in csp(client.get(path))["frame-ancestors"].split()
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    ancestors = csp(client.get(path))["frame-ancestors"].split()
    assert "http://localhost:1420" not in ancestors and "tauri://localhost" in ancestors


def test_ticket_is_random_and_scoped_to_its_document_and_content(docs):
    _, owner, client = docs
    first, second = add(client, owner), add(client, owner, "<p>別</p>", title="別.html")
    a = ticket(client, owner, first["id"])
    b = ticket(client, owner, second["id"], "<p>別</p>")
    assert a != b and len(a.removeprefix("/html-view/")) >= 43
    assert client.get(a).content == SOURCE.encode("utf-8")
    assert client.get(b).content == "<p>別</p>".encode("utf-8")
    # The hash is of the saved bytes of this document: another document's hash is not accepted for it.
    refused = client.post(f"/api/papers/{owner}/documents/{first['id']}/view", headers=AUTH,
                          json={"content_hash": sha("<p>別</p>")})
    assert refused.status_code == 409 and refused.json()["code"] == html_documents.DOCUMENT_CHANGED
    # A tampered or foreign ticket is no document.
    token = a.removeprefix("/html-view/")
    for bad in (token[:-1] + ("A" if token[-1] != "A" else "B"), token.upper() if token.upper() != token else token.lower(),
                token + "x", "x" * 43, "0"):
        assert client.get(f"/html-view/{bad}").status_code == 404


def test_ticket_is_refused_once_the_document_changed_or_went(docs, monkeypatch):
    lib, owner, client = docs
    row = add(client, owner)
    path = ticket(client, owner, row["id"])
    PaperFiles(lib.folder(owner)).attachment(row["id"], "html").write_bytes(b"<p>edited outside</p>")
    changed = client.get(path)
    assert changed.status_code == 409 and changed.json()["code"] == html_documents.DOCUMENT_CHANGED
    assert b"edited outside" not in changed.content
    # Even if the old text comes back, the ticket was given up.
    PaperFiles(lib.folder(owner)).attachment(row["id"], "html").write_bytes(SOURCE.encode("utf-8"))
    assert client.get(path).status_code == 404

    path = ticket(client, owner, row["id"])
    assert client.delete(f"/api/papers/{owner}/attachments/{row['id']}", headers=AUTH).status_code == 200
    assert client.get(path).status_code == 404

    row = add(client, owner)
    path = ticket(client, owner, row["id"])
    lib.delete_paper(owner)
    assert client.get(path).status_code == 404


def test_ticket_expires(docs, monkeypatch):
    _, owner, client = docs
    row = add(client, owner)
    now = [1000.0]
    monkeypatch.setattr(html_documents, "clock", lambda: now[0])
    path = ticket(client, owner, row["id"])
    now[0] += html_documents.TICKET_TTL - 1
    assert client.get(path).status_code == 200
    now[0] += 1
    assert client.get(path).status_code == 404
    assert html_documents._tickets == {}


def test_tickets_are_bounded(docs, monkeypatch):
    _, owner, client = docs
    row = add(client, owner)
    monkeypatch.setattr(html_documents, "MAX_TICKETS", 3)
    paths = [ticket(client, owner, row["id"]) for _ in range(5)]
    assert len(html_documents._tickets) == 3
    assert [client.get(path).status_code for path in paths] == [404, 404, 200, 200, 200]


def test_ticket_does_not_work_for_another_library(docs, tmp_path, monkeypatch):
    lib, owner, client = docs
    row = add(client, owner)
    path = ticket(client, owner, row["id"])
    # The same document, the same bytes: only the library differs.
    copy = tmp_path / "other-library"
    shutil.copytree(lib.root, copy)
    monkeypatch.setenv("PAPEER_DATA_DIR", str(copy))
    assert client.get(path).status_code == 404
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    assert client.get(path).status_code == 200


def test_viewer_admits_itself_and_is_refused_while_a_snapshot_runs(docs, monkeypatch):
    _, owner, client = docs
    row = add(client, owner)
    path = ticket(client, owner, row["id"])
    admissions, ended = [], []
    begin, end = deps.begin_library_request, deps.end_library_request
    monkeypatch.setattr(deps, "begin_library_request", lambda read_only=False: admissions.append(read_only) or begin(read_only))
    monkeypatch.setattr(deps, "end_library_request", lambda kind="request": ended.append(kind) or end(kind))
    assert client.get(path).status_code == 200
    assert admissions == [True] and ended == [deps.SIDE_READ]
    # An unknown ticket is not counted at all.
    assert client.get("/html-view/unknown").status_code == 404
    assert admissions == [True]

    monkeypatch.setattr(deps, "snapshot_running", lambda: True)
    busy = client.get(path)
    assert busy.status_code == 409 and busy.json()["code"] == deps.LIBRARY_BUSY
    assert SOURCE.encode("utf-8") not in busy.content
    assert admissions == [True, True] and ended == [deps.SIDE_READ]
    # The ticket survives the refusal.
    monkeypatch.setattr(deps, "snapshot_running", lambda: False)
    assert client.get(path).status_code == 200


def test_request_is_ended_when_the_document_cannot_be_read(docs, monkeypatch):
    lib, owner, client = docs
    row = add(client, owner)
    path = ticket(client, owner, row["id"])
    PaperFiles(lib.folder(owner)).attachment(row["id"], "html").unlink()
    ended = []
    end = deps.end_library_request
    monkeypatch.setattr(deps, "end_library_request", lambda kind="request": ended.append(kind) or end(kind))
    assert client.get(path).status_code == 404
    assert ended == [deps.SIDE_READ]
    assert deps.wait_for_library_requests(0.1)


# --- What memos and documents share ---

def test_import_takes_md_and_html_together(docs, tmp_path):
    lib, owner, client = docs
    base = f"/api/papers/{owner}/attachments/import"
    memo, page = tmp_path / "持込.md", tmp_path / "資料.HTML"
    memo.write_text("見出し\n本文", "utf-8-sig")
    page.write_bytes(b"\xef\xbb\xbf" + SOURCE.encode("utf-8"))
    rows = client.post(base, headers=AUTH, json={"paths": [str(memo), str(page)]}).json()
    assert [(row["title"], row["format"], row["source"]) for row in rows] == [
        ("持込.md", "md", "imported"), ("資料.HTML", "html", "imported")]
    assert lib.attachment_bytes(rows[1]["id"]) == SOURCE.encode("utf-8")
    described = client.get(f"/api/papers/{owner}/documents/{rows[1]['id']}", headers=AUTH).json()
    assert described["content_hash"] == sha(SOURCE) and described["source"] == "imported"


def test_import_prevalidates_every_file(docs, tmp_path):
    lib, owner, client = docs
    base = f"/api/papers/{owner}/attachments/import"
    good, text, broken = tmp_path / "ok.html", tmp_path / "x.txt", tmp_path / "bad.html"
    good.write_text("<p>ok</p>", "utf-8")
    text.write_text("plain", "utf-8")
    broken.write_bytes(b"<p>\xff</p>")
    for other in (text, broken, tmp_path / "missing.html", tmp_path / "x.htm"):
        assert client.post(base, headers=AUTH, json={"paths": [str(good), str(other)]}).status_code == 400
    assert lib.attachments(owner) == []


def test_order_rename_and_delete_work_on_both_formats(docs):
    lib, owner, client = docs
    base = f"/api/papers/{owner}/attachments"
    memo = client.post(base, headers=AUTH, json={"title": "メモ.md", "content": "本文"}).json()
    page = add(client, owner)
    ids = [memo["id"], page["id"]]
    assert [row["id"] for row in client.get(base, headers=AUTH).json()] == ids

    assert client.put(f"{base}/order", headers=AUTH, json={"ids": ids[::-1]}).status_code == 200
    assert [row["id"] for row in client.get(base, headers=AUTH).json()] == ids[::-1]
    # All of them, exactly: a list of only one format is stale.
    assert client.put(f"{base}/order", headers=AUTH, json={"ids": [memo["id"]]}).status_code == 400
    assert client.put(f"{base}/order", headers=AUTH, json={"ids": [page["id"]]}).status_code == 400
    assert client.put(f"{base}/order", headers=AUTH, json={"ids": [*ids, "f" * 32]}).status_code == 400
    assert client.put(f"{base}/order", headers=AUTH, json={"ids": [page["id"], page["id"]]}).status_code == 400
    assert [row["id"] for row in client.get(base, headers=AUTH).json()] == ids[::-1]

    renamed = client.patch(f"{base}/{page['id']}", headers=AUTH, json={"title": "新しい名前.html"})
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "新しい名前.html" and renamed.json()["format"] == "html"
    assert "content" not in renamed.json()
    assert renamed.json()["updated_at"] != page["updated_at"]
    # Renaming never touches the text, so the hash a ticket was made for stays valid.
    assert client.get(f"/api/papers/{owner}/documents/{page['id']}", headers=AUTH).json()["content_hash"] == sha(SOURCE)
    edited_memo = client.patch(f"{base}/{memo['id']}", headers=AUTH, json={"content": "更新"}).json()
    assert edited_memo["content"] == "更新" and edited_memo["format"] == "md"


def test_a_documents_text_is_read_only(docs):
    lib, owner, client = docs
    base = f"/api/papers/{owner}/attachments"
    page = add(client, owner)
    before = lib.attachments(owner)
    for body in ({"content": "<p>x</p>"}, {"title": "改名.html", "content": ""}):
        assert client.patch(f"{base}/{page['id']}", headers=AUTH, json=body).status_code == 400
    assert lib.attachments(owner) == before
    assert lib.attachment_bytes(page["id"]) == SOURCE.encode("utf-8")
    assert client.patch(f"{base}/{page['id']}", headers=AUTH, json={"title": " "}).status_code == 400


def test_delete_removes_the_document_and_respects_the_owner(docs):
    lib, owner, client = docs
    page = add(client, owner)
    other = "a" * 32
    with lib.connection() as db:
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages) VALUES(?,?,?,?,1)", (other, "different", "other", "other.pdf"))
    foreign = f"/api/papers/{other}/attachments/{page['id']}"
    assert client.patch(foreign, headers=AUTH, json={"title": "奪う.html"}).status_code == 404
    assert client.delete(foreign, headers=AUTH).status_code == 404
    assert len(lib.attachments(owner)) == 1
    assert client.delete(f"/api/papers/{owner}/attachments/{page['id']}", headers=AUTH).status_code == 200
    assert not PaperFiles(lib.folder(owner)).attachment(page["id"], "html").exists()
    assert client.get(f"/api/papers/{owner}", headers=AUTH).json()["attachment_count"] == 0
    assert client.delete(f"/api/papers/{owner}/attachments/{page['id']}", headers=AUTH).status_code == 404


def test_a_notebook_held_by_another_item_holds_no_documents(docs):
    lib, owner, client = docs
    held = "c" * 32
    lib.folder(held).mkdir()
    with lib.connection() as db:
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,kind,parent_id) VALUES(?,?,?,?,1,'notebook',?)",
                   (held, "notebook:" + held, "手書き", "notebook.pdf", owner))
    response = client.post(f"/api/papers/{held}/documents", headers=AUTH, json={"title": "a.html", "content": "x"})
    assert response.status_code == 400
    assert lib.attachments(held) == []
