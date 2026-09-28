import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from papeer.core.glossary_io import export_glossary, import_glossary
from papeer.core.terminology import global_glossary, save_global_glossary
from papeer.core.storage import Library


def test_export_import_roundtrip_and_existing_wins(tmp_path):
    terms = [{"source": "control", "target": "制御"}, {"source": "tracking error", "target": "追従誤差"}]
    path = tmp_path / "辞書.json"
    assert export_glossary(path, terms, tmp_path / "library") == 2
    assert import_glossary(path, [])["terms"] == terms
    existing = [{"source": "CONTROL", "target": "既存訳"}]
    result = import_glossary(path, existing)
    assert result["terms"] == existing + [terms[1]]
    assert result["added"] == [terms[1]]
    assert result["skipped"] == 1
    assert result["conflicts"] == [{"source": "control", "existing": "既存訳", "imported": "制御"}]
    assert existing == [{"source": "CONTROL", "target": "既存訳"}]


@pytest.mark.parametrize("value", [None, {}, {"format": "papeer-glossary", "version": 99, "terms": []},
    [{"source": 1, "target": "訳"}], [{"source": "a", "target": ""}],
    [{"source": "a", "target": "訳"}, {"source": "A", "target": "訳"}]])
def test_invalid_import_is_rejected(tmp_path, value):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(ValueError):
        import_glossary(path, [])


def test_legacy_bom_and_empty_dictionary(tmp_path):
    path = tmp_path / "legacy.json"
    terms = [{"source": " term ", "target": " 訳 "}]
    path.write_text(json.dumps(terms), encoding="utf-8-sig")
    assert import_glossary(path, [])["terms"] == [{"source": "term", "target": "訳"}]
    export_glossary(path, [], tmp_path / "library")
    assert import_glossary(path, [])["terms"] == []


def test_failed_export_preserves_destination_and_large_import_rejected(tmp_path, monkeypatch):
    from papeer.core import glossary_io
    path = tmp_path / "dictionary.json"
    path.write_text("original", encoding="utf-8")
    with pytest.raises(ValueError):
        export_glossary(path, [{"source": "", "target": ""}], tmp_path / "library")
    assert path.read_text("utf-8") == "original"
    monkeypatch.setattr(glossary_io, "MAX_FILE_BYTES", 4)
    with pytest.raises(ValueError, match="10MB"):
        import_glossary(path, [])
    with pytest.raises(ValueError, match="10MB"):
        export_glossary(path, [], tmp_path / "library")
    assert path.read_text("utf-8") == "original"


def test_api_stages_import_without_changing_global_dictionary(tmp_path, monkeypatch):
    from sidecar import app as runtime
    lib = Library(tmp_path / "library")
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    existing = [{"source": "a", "target": "既存"}]
    incoming = [{"source": "b", "target": "追加"}]
    save_global_glossary(lib.root, existing)
    path = tmp_path / "glossary.json"
    with TestClient(runtime.app) as client:
        assert client.post("/api/glossary/export", json={"path": str(path), "terms": incoming}).json() == {"count": 1}
        # Never inside the library, where it could replace library files and would be synced.
        long_form = "\\\\?\\" + str(lib.root.resolve())
        for inside in (lib.root / "glossary.json", Path(long_form) / "glossary.json"):
            refused = client.post("/api/glossary/export", json={"path": str(inside), "terms": incoming})
            assert refused.status_code == 400 and refused.json()["detail"] == "辞書はライブラリの外に保存してください。"
        assert not (lib.root / "glossary.json").exists()
        response = client.post("/api/glossary/import", json={"path": str(path), "terms": existing})
        assert response.status_code == 200
        assert response.json()["terms"] == existing + incoming
        assert global_glossary(lib.root) == existing
        path.write_text("broken JSON", encoding="utf-8")
        assert client.post("/api/glossary/import", json={"path": str(path), "terms": existing}).status_code == 400
        assert global_glossary(lib.root) == existing
    monkeypatch.setenv("PAPEER_TOKEN", "secret")
    with TestClient(runtime.app) as client:
        for action in ("import", "export"):
            assert client.post(f"/api/glossary/{action}", json={"path": str(path), "terms": []}).status_code == 401


def test_a_file_that_cannot_be_read_or_written_is_the_users_to_fix(tmp_path):
    from papeer.core.errors import Invalid

    terms = [{"source": "control", "target": "制御"}]
    with pytest.raises(Invalid):
        import_glossary(tmp_path / "missing.json", [])
    (tmp_path / "file").write_text("not a folder")
    with pytest.raises(Invalid):
        export_glossary(tmp_path / "file" / "glossary.json", terms, tmp_path / "library")
