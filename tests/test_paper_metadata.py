"""Background metadata work requires a saved opt-in; all AI and network calls are stand-ins."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time

from fastapi.testclient import TestClient
import pymupdf as fitz
import pytest

from papeer.core import paper_metadata as metadata
from papeer.core.config import Settings
from papeer.core.storage import Library
from papeer.providers import Cancelled
from sidecar import deps
from sidecar.app import app


TITLE = "Learning to Control Automated Systems"


def source_pdf(path):
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((72, 72), TITLE, fontsize=20)
        page.insert_text((72, 110), "Jane Smith and John Doe\n2024", fontsize=10)
        page.insert_textbox(fitz.Rect(72, 160, 520, 650), "Body text about the controller. " * 50, fontsize=10)
        pdf.save(path)
    return path


class Provider:
    def __init__(self, after=None):
        self.cancel = threading.Event()
        self.calls = 0
        self.after = after

    def generate(self, instruction, data, schema):
        self.calls += 1
        result = {field: {"value": "", "evidence": ""} for field in metadata.FIELDS}
        result["first_author"] = {"value": "Jane Smith", "evidence": "Jane Smith and John Doe"}
        result["publication_year"] = {"value": "2024", "evidence": "2024"}
        if self.after:
            self.after()
        return json.dumps(result)


def crossref(title=TITLE, doi="10.1000/control"):
    return {"title": [title], "DOI": doi, "author": [{"given": "Jane", "family": "Smith"}],
            "published": {"date-parts": [[2024, 5, 3]]}, "container-title": ["Journal of Control"]}


@pytest.fixture
def lib(tmp_path):
    library = Library(tmp_path / "library")
    identity, _ = library.import_pdf(source_pdf(tmp_path / "filename.pdf"))
    return library, identity


def test_defaults_and_old_or_malformed_saved_preferences_are_off(tmp_path):
    assert Settings().paper_metadata_ai_enabled is False
    for saved in ({}, {"paper_metadata_ai_enabled": "true"}, {"paper_metadata_ai_enabled": 1},
                  {"paper_metadata_ai_enabled": None}):
        (tmp_path / "settings.json").write_text(json.dumps(saved), "utf-8")
        assert Settings.load(tmp_path).paper_metadata_ai_enabled is False
    Settings(paper_metadata_ai_enabled=True).save(tmp_path)
    assert Settings.load(tmp_path).paper_metadata_ai_enabled is True
    Settings.load(tmp_path).updated({"model": "another-model"}).save(tmp_path)
    assert Settings.load(tmp_path).paper_metadata_ai_enabled is True
    Settings.load(tmp_path).updated({"paper_metadata_ai_enabled": False}).save(tmp_path)
    assert Settings.load(tmp_path).paper_metadata_ai_enabled is False


def test_information_lookup_has_its_own_model_and_keeps_the_regular_settings():
    settings = Settings(model="translation-model", reasoning_effort="high", paper_metadata_model=" lookup-model ",
                        provider_options={"codex": {"cli_path": "C:/codex.exe"}})
    lookup = settings.for_paper_metadata()
    assert (lookup.provider, lookup.model, lookup.reasoning_effort) == ("codex", "lookup-model", "")
    assert lookup.options() == settings.options()
    assert (settings.model, settings.reasoning_effort, settings.paper_metadata_ai_enabled) == ("translation-model", "high", False)
    default = Settings(model="translation-model", reasoning_effort="high").for_paper_metadata()
    assert (default.model, default.reasoning_effort) == ("translation-model", "high")


def test_information_model_round_trips_and_is_preserved_by_partial_updates(tmp_path):
    settings = Settings(model="translation-model", paper_metadata_model="lookup-model",
                        provider_options={"codex": {"paper_metadata_model": "lookup-model"},
                                          "api": {"paper_metadata_model": "local-model"}})
    settings.save(tmp_path)
    loaded = Settings.load(tmp_path)
    assert loaded.paper_metadata_model == "lookup-model"
    assert loaded.options("api")["paper_metadata_model"] == "local-model"
    loaded.updated({"translation_concurrency": 2}).save(tmp_path)
    assert Settings.load(tmp_path).paper_metadata_model == "lookup-model"
    loaded.updated({"paper_metadata_model": ""}).save(tmp_path)
    assert Settings.load(tmp_path).for_paper_metadata().model == "translation-model"


def test_information_lookup_uses_the_selected_connection_and_its_model(tmp_path):
    settings = Settings(provider="codex", model="translation-model", reasoning_effort="high",
                        paper_metadata_provider="api", paper_metadata_model="qwen3:8b",
                        provider_options={"api": {"base_url": "http://localhost:11434/v1", "model": "local-default"}})
    settings.save(tmp_path)
    loaded = Settings.load(tmp_path).updated({"translation_concurrency": 2})
    lookup = loaded.for_paper_metadata()
    assert (lookup.provider, lookup.model, lookup.reasoning_effort) == ("api", "qwen3:8b", "")
    assert lookup.base_url == "http://localhost:11434/v1"
    assert (loaded.provider, loaded.model, loaded.reasoning_effort) == ("codex", "translation-model", "high")
    assert loaded.updated({"paper_metadata_model": ""}).for_paper_metadata().model == "local-default"
    assert loaded.updated({"paper_metadata_provider": "", "paper_metadata_model": ""}).for_paper_metadata().model == "translation-model"


def test_import_uses_local_openai_compatible_api_only_for_opted_in_metadata(tmp_path, monkeypatch):
    """Use the real registry/HTTP backend, with an Ollama-shaped server and no external AI calls."""
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "_runtime_api_key", "")
    for key in ("PAPEER_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(metadata, "lookup_records", lambda known: [])
    requests = []

    class LocalAPI(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, payload, self.headers.get("Authorization")))
            content = Provider().generate("", "", {})
            body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), LocalAPI)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with TestClient(app) as client:
            assert client.put("/api/settings", json={"provider": "codex", "model": "translation-model",
                "paper_metadata_provider": "api", "paper_metadata_model": "qwen3:8b", "api_key": "",
                "provider_options": {"api": {"base_url": f"http://127.0.0.1:{server.server_port}/v1"}}}).status_code == 200
            first = wait_import(client, source_pdf(tmp_path / "off.pdf"))
            assert first.status == "succeeded" and requests == []
            assert client.put("/api/settings", json={"paper_metadata_ai_enabled": True}).status_code == 200
            job = wait_import(client, source_pdf(tmp_path / "on.pdf"))
            assert job.status == "succeeded" and not job.result.metadata_failures
            [(path, payload, authorization)] = requests
            assert path == "/v1/chat/completions" and payload["model"] == "qwen3:8b" and authorization is None
            assert "reasoning_effort" not in payload
            assert set(payload["response_format"]["json_schema"]["schema"]["properties"]) == set(metadata.FIELDS)
            paper = client.get(f"/api/papers/{job.result.paper_ids[0]}").json()
            assert (paper["first_author"], paper["publication_year"]) == ("Jane Smith", "2024")
            saved = client.get("/api/settings").json()
            assert (saved["provider"], saved["model"], saved["paper_metadata_provider"]) == ("codex", "translation-model", "api")
            assert client.put("/api/settings", json={"paper_metadata_provider": "unknown"}).status_code == 400
            assert client.get("/api/settings").json()["paper_metadata_provider"] == "api"
    finally:
        server.shutdown()
        worker.join(timeout=2)
        server.server_close()


@pytest.mark.parametrize("model", ["--config=x", "-c", "two models", "bad\nmodel", None])
def test_invalid_information_models_are_rejected(model):
    with pytest.raises(ValueError, match="モデル名"):
        Settings(paper_metadata_model=model)
    with pytest.raises(ValueError, match="モデル名"):
        Settings(provider_options={"codex": {"paper_metadata_model": model}})


def test_invalid_saved_information_model_falls_back_without_affecting_translation(tmp_path):
    (tmp_path / "settings.json").write_text(json.dumps({
        "model": "translation-model", "paper_metadata_model": "--config=x",
        "provider_options": {"codex": {"model": "translation-model", "paper_metadata_model": "-c"}}}), "utf-8")
    loaded = Settings.load(tmp_path)
    assert loaded.paper_metadata_model == ""
    assert loaded.for_paper_metadata().model == "translation-model"
    assert "paper_metadata_model" not in loaded.options()


@pytest.mark.parametrize("value", ["true", "false", 1, 0, None])
def test_preference_is_a_real_boolean(value):
    with pytest.raises(ValueError):
        Settings(paper_metadata_ai_enabled=value)


def test_off_never_creates_an_ai_connection_reads_layout_or_searches(lib, monkeypatch):
    library, identity = lib
    def forbidden(*args, **kwargs):
        pytest.fail("OFF started metadata work")
    monkeypatch.setattr(library, "document", forbidden)
    monkeypatch.setattr(metadata, "lookup_records", forbidden)
    assert metadata.complete_metadata(library, identity, Settings(), forbidden) == []


def test_completion_fills_only_missing_fields_from_evidence_and_a_matching_record(lib, monkeypatch):
    library, identity = lib
    provider = Provider()
    monkeypatch.setattr(metadata, "_download", lambda url: json.dumps({"message": {"items": [crossref()]}}).encode())
    changed = metadata.complete_metadata(library, identity, Settings(paper_metadata_ai_enabled=True), lambda: provider)
    paper = library.paper(identity)
    assert set(changed) == {"first_author", "publication_year", "venue", "doi"}
    assert (paper["title"], paper["first_author"], paper["publication_year"], paper["venue"], paper["doi"]) == (
        TITLE, "Jane Smith", "2024", "Journal of Control", "10.1000/control")
    assert provider.calls == 1


def test_manual_edits_during_lookup_are_not_overwritten(lib, monkeypatch):
    library, identity = lib
    def records(known):
        library.update(identity, first_author="My author", venue="My journal")
        return [metadata._crossref_record(crossref())]
    monkeypatch.setattr(metadata, "lookup_records", records)
    metadata.complete_metadata(library, identity, Settings(paper_metadata_ai_enabled=True), Provider)
    paper = library.paper(identity)
    assert (paper["first_author"], paper["venue"]) == ("My author", "My journal")


def test_turning_off_after_the_ai_call_stops_searching_and_saving(lib, monkeypatch):
    library, identity = lib
    enabled = [True]
    provider = Provider(after=lambda: enabled.__setitem__(0, False))
    monkeypatch.setattr(metadata, "lookup_records", lambda known: pytest.fail("Search after OFF"))
    changed = metadata.complete_metadata(library, identity, Settings(paper_metadata_ai_enabled=True), lambda: provider,
                                         enabled_now=lambda: enabled[0])
    assert changed == []
    assert library.paper(identity)["first_author"] == ""


def test_turning_off_during_lookup_does_not_commit_results(lib, monkeypatch):
    library, identity = lib
    enabled = [True]
    def records(known):
        enabled[0] = False
        return [metadata._crossref_record(crossref())]
    monkeypatch.setattr(metadata, "lookup_records", records)
    assert metadata.complete_metadata(library, identity, Settings(paper_metadata_ai_enabled=True), Provider,
                                      enabled_now=lambda: enabled[0]) == []
    assert library.paper(identity)["doi"] == ""


def test_unsupported_ai_guesses_are_discarded():
    class Guessing(Provider):
        def generate(self, *args):
            return json.dumps({"first_author": {"value": "Invented Person", "evidence": "Jane Smith"},
                               "doi": {"value": "10.1000/fake", "evidence": "doi:10.1000/fake"}})
    assert metadata._pdf_values(Guessing(), {}, "Jane Smith") == {}


@pytest.mark.parametrize("items", [[crossref("A Completely Different Paper")],
                                   [crossref(), crossref(doi="10.1000/other")]])
def test_wrong_or_ambiguous_search_results_are_not_adopted(monkeypatch, items):
    monkeypatch.setattr(metadata, "_download", lambda url: json.dumps({"message": {"items": items}}).encode())
    assert metadata.lookup_records({"title": TITLE}) == []


def test_arxiv_record_is_matched_by_id_and_title(monkeypatch):
    feed = f'''<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
    <entry><id>http://arxiv.org/abs/2401.00001v2</id><title>{TITLE}</title><published>2024-01-01</published>
    <author><name>Jane Smith</name></author><arxiv:doi>10.1000/control</arxiv:doi>
    <arxiv:journal_ref>Journal of Control</arxiv:journal_ref></entry></feed>'''
    monkeypatch.setattr(metadata, "_download", lambda url: feed.encode())
    [record] = metadata.lookup_records({"title": TITLE, "arxiv_id": "2401.00001"})
    assert (record["first_author"], record["doi"], record["arxiv_id"]) == ("Jane Smith", "10.1000/control", "2401.00001")


def test_search_failure_still_keeps_pdf_supported_values(lib, monkeypatch):
    library, identity = lib
    monkeypatch.setattr(metadata, "lookup_records", lambda known: (_ for _ in ()).throw(OSError("offline")))
    warnings = []
    assert set(metadata.complete_metadata(library, identity, Settings(paper_metadata_ai_enabled=True), Provider,
                                         on_warning=warnings.append)) == {"first_author", "publication_year"}
    assert len(warnings) == 1


def test_cancellation_does_not_save_or_search(lib, monkeypatch):
    library, identity = lib
    provider = Provider()
    provider.after = provider.cancel.set
    monkeypatch.setattr(metadata, "lookup_records", lambda known: pytest.fail("Search after cancel"))
    with pytest.raises(Cancelled):
        metadata.complete_metadata(library, identity, Settings(paper_metadata_ai_enabled=True), lambda: provider)
    assert library.paper(identity)["first_author"] == ""


def wait_import(client, path):
    identity = client.post("/api/papers/import", json={"paths": [str(path)]}).json()["job_id"]
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        job = deps.job_manager.get_job(identity)
        if job is not None and not job.running:
            return job
        time.sleep(.02)
    pytest.fail("Import did not finish")


def test_api_opt_in_gates_import_and_duplicate_imports_do_not_call_ai(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    provider = Provider()
    calls = []
    def factory(settings, *args, **kwargs):
        calls.append(settings.model)
        return provider
    monkeypatch.setattr(deps, "provider_for", factory)
    monkeypatch.setattr(metadata, "lookup_records", lambda known: [metadata._crossref_record(crossref())])
    with TestClient(app) as client:
        assert client.get("/api/settings").json()["paper_metadata_ai_enabled"] is False
        first = wait_import(client, source_pdf(tmp_path / "first.pdf"))
        assert first.status == "succeeded" and not calls
        assert client.put("/api/settings", json={"paper_metadata_ai_enabled": "true"}).status_code == 422
        assert client.put("/api/settings", json={"paper_metadata_ai_enabled": True,
                                                "model": "translation-model", "paper_metadata_model": "lookup-model"}).status_code == 200
        assert client.put("/api/settings", json={"translation_concurrency": 2}).status_code == 200
        assert client.get("/api/settings").json()["paper_metadata_ai_enabled"] is True
        assert client.get("/api/settings").json()["paper_metadata_model"] == "lookup-model"
        second = wait_import(client, source_pdf(tmp_path / "second.pdf"))
        assert second.status == "succeeded" and len(calls) == 1
        assert calls == ["lookup-model"]
        assert client.get("/api/settings").json()["model"] == "translation-model"
        paper = client.get(f"/api/papers/{second.result.paper_ids[0]}").json()
        assert paper["first_author"] == "Jane Smith" and paper["doi"] == "10.1000/control"
        duplicate = wait_import(client, tmp_path / "second.pdf")
        assert duplicate.status == "succeeded" and duplicate.result.added == 0 and len(calls) == 1
        assert client.put("/api/settings", json={"paper_metadata_ai_enabled": False}).status_code == 200
        third = wait_import(client, source_pdf(tmp_path / "third.pdf"))
        assert third.status == "succeeded" and len(calls) == 1


def test_information_model_api_rejects_unsafe_names_and_clears_the_override(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    with TestClient(app) as client:
        assert client.put("/api/settings", json={"model": "translation-model", "paper_metadata_model": "lookup-model"}).status_code == 200
        assert client.put("/api/settings", json={"paper_metadata_model": "--config=x"}).status_code == 400
        assert client.put("/api/settings", json={"provider_options": {"codex": {"paper_metadata_model": "-c"}}}).status_code == 400
        assert client.get("/api/settings").json()["paper_metadata_model"] == "lookup-model"
        assert client.put("/api/settings", json={"paper_metadata_model": ""}).status_code == 200
        saved = client.get("/api/settings").json()
        assert saved["paper_metadata_model"] == "" and saved["model"] == "translation-model"
        assert saved["paper_metadata_ai_enabled"] is False


def test_failed_ai_metadata_lookup_does_not_fail_pdf_import(tmp_path, monkeypatch):
    root = tmp_path / "data"
    monkeypatch.setenv("PAPEER_DATA_DIR", str(root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    Settings(paper_metadata_ai_enabled=True).save(root)
    monkeypatch.setattr(deps, "provider_for", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("AI offline")))
    with TestClient(app) as client:
        job = wait_import(client, source_pdf(tmp_path / "source.pdf"))
        assert job.status == "succeeded" and job.result.added == 1
        assert len(job.result.metadata_failures) == 1
        assert client.get(f"/api/papers/{job.result.paper_ids[0]}").status_code == 200
