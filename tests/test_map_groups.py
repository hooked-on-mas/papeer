"""Group descriptions use the metadata model, saved evidence and a separate cancellable cache."""
from dataclasses import replace
import json
import threading

from fastapi.testclient import TestClient
import pytest

from papeer.core import discovery, map_groups
from papeer.core.config import Settings
from papeer.core.storage import Library
from papeer.providers import Cancelled
from sidecar import deps
from sidecar.app import app
from sidecar.jobs import JobManager, ConcurrencyConflict
from sidecar.schemas.discovery import MapGroupResult
from test_citations import add_paper


class Model:
    def __init__(self, settings, cancel=None):
        self.settings = settings
        self.cancel = cancel or threading.Event()
        self.calls = []
        self.fail = False
        self.unknown = False

    def generate(self, instruction, data, schema):
        self.calls.append((instruction, json.loads(data)))
        if self.fail:
            raise OSError("offline")
        return json.dumps({"groups": [{"key": item["key"], "name": "ロボットの経路計画",
            "description": "タイトルから、経路計画を扱う研究のまとまりと推測できます。",
            "evidence": ["not-a-member" if self.unknown else item["members"][0]]} for item in json.loads(data)["groups"]]})


@pytest.fixture
def papers(tmp_path):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Current paper")
    a = add_paper(lib, 2, "Robot planning")
    b = add_paper(lib, 3, "Coverage planning")
    return lib, source, [a, b]


def test_grounded_input_cache_model_identity_and_expiry(papers):
    lib, source, members = papers
    settings = Settings(provider="codex", model="translation-model", paper_metadata_provider="claude-code", paper_metadata_model="information-model")
    model = Model(settings.for_paper_metadata())
    discovery.write_cache(lib, source, source, {"nodes": [], "checked_at": "", "warnings": ["keep this"]})
    result = map_groups.describe(lib, source, source, [members], model, lambda _: None)
    MapGroupResult.model_validate(result)
    assert result["groups"][0]["provider"] == "claude-code" and result["groups"][0]["model"] == "information-model"
    assert set(model.calls[0][1]["groups"][0]["members"]) == set(members)
    assert discovery.read_cache(lib, source, source)["warnings"] == ["keep this"]
    assert discovery.build(lib, source)["references"] == []  # Descriptions never become source references.
    map_groups.describe(lib, source, source, [list(reversed(members))], model, lambda _: None)
    assert len(model.calls) == 1
    assert not map_groups.read(lib, source, source, replace(model.settings, model="different"))["groups"]
    cache = discovery.read_cache(lib, source, "groups:" + source)
    cache["groups"][0]["created_at"] = "2000-01-01T00:00:00+00:00"
    discovery.write_cache(lib, source, "groups:" + source, cache)
    assert map_groups.read(lib, source, source, model.settings)["groups"][0]["stale"]
    model.fail = True
    with pytest.raises(OSError):
        map_groups.describe(lib, source, source, [members], model, lambda _: None)
    assert map_groups.read(lib, source, source, model.settings)["groups"][0]["name"] == "ロボットの経路計画"
    lib.update(members[0], title="A different research topic")
    assert not map_groups.read(lib, source, source, model.settings)["groups"]


def test_duplicate_foreign_evidence_and_cancel_cannot_write(papers):
    lib, source, members = papers
    model = Model(Settings())
    with pytest.raises(ValueError):
        map_groups.describe(lib, source, source, [members, members], model, lambda _: None)
    with pytest.raises(ValueError):
        map_groups.describe(lib, source, source, [[source, members[0]]], model, lambda _: None)
    with pytest.raises(ValueError):
        map_groups.describe(lib, source, source, [["missing", members[0]]], model, lambda _: None)
    model.unknown = True
    with pytest.raises(ValueError, match="所属していない"):
        map_groups.describe(lib, source, source, [members], model, lambda _: None)
    assert not map_groups.read(lib, source, source, model.settings)["groups"]
    model.cancel.set()
    with pytest.raises(Cancelled):
        map_groups.describe(lib, source, source, [members], model, lambda _: None)


def test_shared_evidence_counts_unique_citations_and_excludes_origin():
    data = {"origin": "root", "nodes": [{"id": m, "title": m} for m in ["root", "a", "b", "x"]],
        "edges": [{"source": s, "target": t, "kind": "citation"} for s, t in [
            ("root", "a"), ("root", "b"), ("a", "root"), ("b", "root"),
            ("a", "x"), ("a", "x"), ("b", "x"), ("b", "x")]]}
    evidence = map_groups.group_input(data, ["a", "b"])
    assert evidence["shared_references"] == [{"id": "x", "title": "x", "count": 2}]
    assert evidence["shared_citers"] == []


def test_group_api_uses_information_settings_and_single_job(papers, monkeypatch):
    lib, source, members = papers
    settings = Settings(paper_metadata_ai_enabled=True, model="translation-model", paper_metadata_provider="claude-code", paper_metadata_model="information-model")
    manager = JobManager()
    monkeypatch.setattr(deps, "job_manager", manager)
    monkeypatch.setattr(deps, "get_library", lambda: lib)
    monkeypatch.setattr(deps, "get_settings", lambda: settings)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    used = []
    def factory(selected, cancel):
        used.append(selected)
        return Model(selected, cancel)
    monkeypatch.setattr(deps, "provider_for", factory)
    client = TestClient(app)
    try:
        path = f"/api/papers/{source}/discovery/groups"
        response = client.post(path, json={"groups": [members]})
        assert response.status_code == 200, response.text
        assert manager.wait_idle(5)
        assert used[0].provider == "claude-code" and used[0].model == "information-model"
        assert client.get(path).json()["groups"][0]["name"] == "ロボットの経路計画"
        assert client.post(path, json={"groups": [members * 31]}).status_code == 400
        settings.paper_metadata_ai_enabled = False
        assert client.post(path, json={"groups": [members]}).status_code == 400
        monkeypatch.delenv("PAPEER_DEV_NO_AUTH")
        monkeypatch.setenv("PAPEER_TOKEN", "a-secret")
        assert client.get(path).status_code == 401
        # The independent job may overlap reading/discovery, while deletion/snapshot still wait.
        gate = threading.Event()
        def held(*_):
            gate.wait(5)
            return {"origin": source, "groups": [], "connection": "codex:test"}
        manager.submit_job("paper-map-groups", held, source)
        with pytest.raises(ConcurrencyConflict):
            manager.submit_job("paper-map-groups", lambda *_: None, source)
        manager.submit_job("paper-discovery", lambda *_: discovery.build(lib, source), source)
        manager.submit_job("article", lambda *_: {"content": "summary"}, source)
        with pytest.raises(ConcurrencyConflict), manager.idle("delete", source):
            pytest.fail("deletion must wait")
        with pytest.raises(ConcurrencyConflict):
            manager.submit_job("backup", lambda *_: None)
        gate.set()
    finally:
        manager.wait_idle(5)
        manager.close()
