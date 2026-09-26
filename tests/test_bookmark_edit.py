from fastapi.testclient import TestClient

from paperdesk.core.storage import Library
from sidecar import app as runtime


def test_bookmark_edit_is_scoped_and_persistent(tmp_path, monkeypatch):
    import pymupdf

    lib = Library(tmp_path / "library")
    source = tmp_path / "source.pdf"
    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((72, 72), "Bookmark test document")
        pdf.save(source)
    paper, _ = lib.import_pdf(source)
    source.write_bytes(source.read_bytes() + b"\n% other")
    other, _ = lib.import_pdf(source)
    monkeypatch.setenv("PAPERDESK_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPERDESK_TOKEN", "")
    with TestClient(runtime.app) as client:
        base = f"/api/papers/{paper}/bookmarks"
        saved = client.post(base, json={"page": 1, "side": "original", "quote": "読書位置", "anchor_y": .6}).json()
        url = f"{base}/{saved['id']}"
        label_only = client.post(base, json={"page": 1, "side": "original", "quote": "", "label": "重要", "anchor_y": .2})
        assert label_only.status_code == 200
        assert label_only.json()["quote"] == ""
        assert label_only.json()["anchor_y"] == .2
        response = client.patch(url, json={"label": "疑問", "note": "式の意味を確認"})
        assert response.status_code == 200
        assert response.json()["anchor_y"] == .6
        assert client.patch(f"/api/papers/{other}/bookmarks/{saved['id']}", json={"label": "引用"}).status_code == 404
        assert client.patch(url, json={"note": "x" * 1001}).status_code == 422
        reopened = Library(lib.root).bookmarks(paper)[0]
        assert (reopened["label"], reopened["note"], reopened["quote"]) == ("疑問", "式の意味を確認", "読書位置")
        monkeypatch.setenv("PAPERDESK_TOKEN", "private-token")
        assert client.patch(url, json={"label": "重要"}).status_code == 401
