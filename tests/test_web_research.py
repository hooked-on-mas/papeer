"""Research keeps its evidence; PDF import and summary have independent outcomes."""
import io
import json
import shutil
import socket
import threading
import time
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pymupdf as fitz
import pytest

from papeer.core import reference_pdf, scholarly_lookup, web_research
from papeer.core.backup import create_backup, restore_backup
from papeer.core.citations import citation_graph, extract_references
from papeer.core.config import Settings
from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.providers import AnswerRejected, Cancelled, ProviderBackend, ProviderSpec
from papeer.providers.codex import CodexProvider
from papeer.providers.claude_code import ClaudeCodeProvider
from papeer.providers.antigravity import AntigravityProvider
from papeer.providers.openai_compat import OpenAICompatProvider
from sidecar import deps
from sidecar.app import app


def pdf(path, text):
    with fitz.open() as document:
        page = document.new_page()
        page.insert_textbox((40, 40, 550, 700), text, fontsize=12)
        document.save(path)
    return path


def evidence(**updates):
    return {"title": "Robust control of systems", "doi": "10.1234/abc", "arxiv_id": "",
            "first_author": "A. Smith", "publication_year": "2020", "venue": "Control Journal", "abstract": "",
            "summary": "抄録で検証条件を確認しました [Web 1]。", "basis": "abstract",
            "sources": [{"title": "Publisher", "url": "https://publisher.example/paper"}],
            "pdfs": [{"title": "Author manuscript", "url": "https://repository.example/paper.pdf",
                      "version": "著者最終稿"}], **updates}


class ResearchProvider(ProviderBackend):
    spec = ProviderSpec("test", "Test", "Test", "cli", web_search=True)

    def __init__(self, cancel=None):
        super().__init__(Settings(provider="codex"), cancel)
        self.normal = []
        self.web = []
        self.result = evidence()
        self.summary_failure = None

    def _generate(self, instruction, data, schema):
        self.normal.append((instruction, data))
        if self.summary_failure:
            if isinstance(self.summary_failure, Cancelled):
                self.cancel.set()
            raise self.summary_failure
        return "PDFの本文に基づく回答です。"

    def search_web(self, instruction, data, schema=None):
        self.web.append((instruction, json.loads(data)))
        return json.dumps(self.result, ensure_ascii=False)


@pytest.fixture(autouse=True)
def no_live_bibliographic_requests(monkeypatch):
    monkeypatch.setattr(scholarly_lookup, "_request", lambda url, cancel: {})


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setattr("papeer.core.ocr.import_reads", lambda: False)
    lib = Library(tmp_path / "library")
    source, _ = lib.import_pdf(pdf(tmp_path / "source.pdf", 'The source research\n\nReferences\n[1] A. Smith, "Robust control of systems", 2020. doi:10.1234/abc.'))
    entry = extract_references(lib.document(source))[0]
    candidate = pdf(tmp_path / "verified-reference.pdf", "Robust control of systems\nA. Smith\nOriginal text")
    monkeypatch.setattr(reference_pdf, "download_pdf", lambda url, path, cancel, progress, **kwargs: shutil.copyfile(candidate, path))
    return lib, source, entry


def test_codex_web_is_per_request_and_local_tools_stay_disabled(monkeypatch):
    commands = []
    prompts = []
    monkeypatch.setattr(CodexProvider, "command", lambda self: ["codex"])
    monkeypatch.setattr("papeer.providers.codex.no_mcp_overrides", lambda: ["-c", "mcp_servers.test.enabled=false"])

    def execute(**kwargs):
        commands.append(kwargs["command"])
        prompts.append(kwargs["prompt_bytes"].decode("utf-8"))
        return "answer", b""

    monkeypatch.setattr("papeer.providers.codex.run_cli_process", execute)
    provider = CodexProvider(Settings(provider="codex"))
    provider.generate("summarize", "document")
    provider.search_web("research", "document")
    provider.generate("summarize", "document")
    assert ['web_search="live"' in command for command in commands] == [False, True, False]
    assert ["Do not invoke tools" in prompt for prompt in prompts] == [True, False, True]
    assert "Use web search and read public web pages" in prompts[1]
    for command in commands:
        for option in ("--ephemeral", "read-only", "features.shell_tool=false", "features.unified_exec=false", "mcp_servers.test.enabled=false"):
            assert option in command


def test_claude_search_only_exposes_web_tools_and_reads_structured_result(monkeypatch):
    commands = []
    prompts = []
    monkeypatch.setattr(ClaudeCodeProvider, "command", lambda self: ["claude"])
    def execute(**kwargs):
        commands.append(kwargs["command"])
        prompts.append(kwargs["prompt_bytes"].decode("utf-8"))
        result = {"type": "result", "is_error": False, "result": "unstructured explanation",
                  "usage": {"input_tokens": 10, "output_tokens": 5}}
        if "--json-schema" in kwargs["command"]:
            result["structured_output"] = evidence()
            del result["result"]
        return json.dumps(result), ""
    monkeypatch.setattr("papeer.providers.claude_code.run_cli_process", execute)
    provider = ClaudeCodeProvider(Settings(provider="claude"))
    provider.generate("summarize", "document")
    assert json.loads(provider.search_web("research", "document", web_research._RECORD_SCHEMA)) == evidence()
    provider.generate("summarize", "document")
    assert [c[c.index("--tools") + 1] for c in commands] == ["", "WebSearch,WebFetch", ""]
    assert ["Do not invoke tools" in prompt for prompt in prompts] == [True, False, True]
    assert "Use web search and read public web pages" in prompts[1]
    search = commands[1]
    assert search[search.index("--allowedTools") + 1] == "WebSearch,WebFetch"
    assert search[search.index("--permission-mode") + 1] == "dontAsk"
    for command in commands:
        assert "--dangerously-skip-permissions" not in command
        assert "--strict-mcp-config" in command
        assert json.loads(command[command.index("--mcp-config") + 1]) == {"mcpServers": {}}
        assert "--disable-slash-commands" in command and "--no-session-persistence" in command
    assert provider.usage.output_tokens == 15


def test_antigravity_search_profile_and_off_requests_are_isolated(monkeypatch):
    calls = []
    monkeypatch.setattr(AntigravityProvider, "command", lambda self: ["agy"])
    def execute(**kwargs):
        command = kwargs["command"]
        agent = command[command.index("--agent") + 1]
        profile = (kwargs["root"] / ".agents" / "agents" / f"{agent}.md").read_text("utf-8")
        calls.append((command, profile, kwargs["prompt_bytes"]))
        result = {"status": "SUCCESS", "response": json.dumps(evidence()) if agent == "papeer-web" else "回答の説明文",
                  "usage": {"output_tokens": 5}}
        return json.dumps({"event": "result", "result": result}), ""
    monkeypatch.setattr("papeer.providers.antigravity.run_cli_process", execute)
    provider = AntigravityProvider(Settings(provider="antigravity", model="gemini-test", reasoning_effort="high"))
    provider.generate("summarize", "document")
    assert json.loads(provider.search_web("research", "文献" * 40000, web_research._RECORD_SCHEMA)) == evidence()
    provider.generate("summarize", "document")
    assert ["--dangerously-skip-permissions" in c[0] for c in calls] == [False, True, False]
    assert all("--json-schema" not in c[0] for c in calls)
    for i, (command, profile, prompt) in enumerate(calls):
        assert ("  - search_web\n" in profile) == (i == 1)
        assert ("  - read_url_content\n" in profile) == (i == 1)
        assert "  - finish\n" in profile and "inheritMcp: false" in profile
        assert "subagent: false" in profile and "commandExecutionPolicy: off" in profile
        assert "mcpServers: []" in profile and "skills: []" in profile and "plugins: []" in profile
        assert "  - run_command" not in profile and "  - view_file" not in profile
        assert "--sandbox" in command and "--disable-slash-commands" in command
        assert command[command.index("--model") + 1] == "gemini-test"
        assert json.loads(prompt)["event"] == "user"
        assert ("Do not invoke tools" in json.loads(prompt)["message"]["content"]) == (i != 1)
        if i == 1:
            assert "Use web search and read public web pages" in json.loads(prompt)["message"]["content"]
            assert "文献" * 40000 in json.loads(prompt)["message"]["content"]
            assert "sources" in json.loads(prompt)["message"]["content"]
    assert provider.usage.output_tokens == 15


@pytest.mark.parametrize("response", [None, "", "JSONではない説明文"])
def test_antigravity_structured_answer_does_not_need_response_text(monkeypatch, response):
    monkeypatch.setattr(AntigravityProvider, "command", lambda self: ["agy"])
    def execute(**kwargs):
        return json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": response,
                          "structured_output": evidence(), "usage": {"output_tokens": 5}}}), ""
    monkeypatch.setattr("papeer.providers.antigravity.run_cli_process", execute)
    provider = AntigravityProvider(Settings(provider="antigravity"))
    assert json.loads(provider.search_web("research", "document", web_research._RECORD_SCHEMA)) == evidence()
    assert provider.usage.output_tokens == 5


@pytest.mark.parametrize("structured", [None, {}, {"sources": "wrong type"}])
def test_antigravity_invalid_structured_field_does_not_hide_valid_response(monkeypatch, structured):
    monkeypatch.setattr(AntigravityProvider, "command", lambda self: ["agy"])
    def execute(**kwargs):
        return json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": json.dumps(evidence()),
                          "structured_output": structured}}), ""
    monkeypatch.setattr("papeer.providers.antigravity.run_cli_process", execute)
    provider = AntigravityProvider(Settings(provider="antigravity"))
    assert json.loads(provider.search_web("research", "document", web_research._RECORD_SCHEMA)) == evidence()


@pytest.mark.parametrize("response", ["説明だけの回答", '{"sources": "wrong type"}'])
def test_antigravity_invalid_json_answer_is_rejected_without_resending(monkeypatch, response):
    calls = []
    monkeypatch.setattr(AntigravityProvider, "command", lambda self: ["agy"])
    def execute(**kwargs):
        calls.append(kwargs["command"])
        return json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": response,
                          "usage": {"output_tokens": 5}}}), ""
    monkeypatch.setattr("papeer.providers.antigravity.run_cli_process", execute)
    provider = AntigravityProvider(Settings(provider="antigravity"))
    with pytest.raises(AnswerRejected, match="指定した形式のJSON"):
        provider.search_web("research", "document", web_research._RECORD_SCHEMA)
    assert len(calls) == 1
    assert "--json-schema" not in calls[0]
    assert provider.usage.output_tokens == 5


@pytest.mark.parametrize("failure_path", ["exit", "result", "no-result"])
def test_antigravity_malformed_tool_call_is_answered_and_not_resent(monkeypatch, failure_path):
    from papeer.providers.common import cli_exit_failure
    detail = ("Your previous response contained an improperly formatted function call: Malformed function call: "
              "Failed to parse function call: Function call is empty - no input to parse.\n"
              "Please retry with a properly formatted function call\nRetries remaining: 3")
    calls = []
    monkeypatch.setattr(AntigravityProvider, "command", lambda self: ["agy"])
    def execute(**kwargs):
        calls.append(kwargs["command"])
        if failure_path == "exit":
            raise cli_exit_failure("Antigravity (agy)", detail, "", 3)
        if failure_path == "no-result":
            return json.dumps({"event": "error", "error": detail}), ""
        return json.dumps({"event": "result", "result": {"status": "ERROR", "error": detail,
                          "usage": {"output_tokens": 12}}}), ""
    monkeypatch.setattr("papeer.providers.antigravity.run_cli_process", execute)
    provider = AntigravityProvider(Settings(provider="antigravity"))
    with pytest.raises(AnswerRejected, match="ツール呼び出し形式が不正") as error:
        provider.generate("translate", "document")
    assert "ログイン状態・利用枠を確認" not in str(error.value).splitlines()[0]
    assert "Function call is empty" in str(error.value)
    assert len(calls) == 1
    assert provider.usage.output_tokens == (12 if failure_path == "result" else 0)


def test_api_local_model_remains_unsupported():
    provider = OpenAICompatProvider(Settings(provider="api"))
    assert not provider.spec.web_search
    with pytest.raises(ValueError, match="対応していません"):
        provider.search_web("research", "data")


def test_reference_research_is_persisted_and_refresh_keeps_imported_pdf(library, tmp_path):
    lib, source, entry = library
    provider = ResearchProvider()
    record = web_research.research_reference(lib, source, f"{source}:0", provider)
    assert record["basis"] == "abstract"
    assert "[Web 1](https://publisher.example/paper)" in record["summary"]
    assert provider.web[0][1]["raw"] == entry["raw"]
    target, _ = lib.import_pdf(pdf(tmp_path / "target.pdf", "A different PDF with original text."))
    record.update(paper_id=target, version="著者最終稿")
    web_research.save_record(lib, source, record)
    provider.result = evidence(summary="再確認 [Web 1]。", pdfs=[])
    refreshed = web_research.research_saved(lib, source, record["key"], provider)
    assert refreshed["paper_id"] == target and refreshed["version"] == "著者最終稿"
    assert refreshed["pdfs"] == []
    assert citation_graph(lib)["references"][0]["target"] == target
    lib.delete_paper(target)
    assert web_research.get_record(lib, source, record["key"])["paper_id"] is None


@pytest.mark.parametrize("value,error", [
    (evidence(doi="10.1234/other"), "別の文献"),
    (evidence(summary="出典 [Web 2]"), "出典番号"),
    (evidence(sources=[{"title": "Bad", "url": "file:///secret"}]), "出典"),
])
def test_research_rejects_wrong_identity_and_invalid_numbering(library, value, error):
    lib, source, _ = library
    provider = ResearchProvider()
    provider.result = value
    with pytest.raises(ValueError, match=error):
        web_research.research_reference(lib, source, f"{source}:0", provider)
    if value["doi"] != "10.1234/abc":
        record = web_research.records(lib, source)[0]
        assert record["doi"] == "10.1234/abc" and record["last_failure"]["returned_doi"] == value["doi"]
        assert not record["summary"] and not record["sources"] and not record["pdfs"]
    else:
        assert web_research.records(lib, source) == []
    provider.result = evidence(basis="unresolved", summary="文献を特定できません。", sources=[])
    record = web_research.research_reference(lib, source, f"{source}:0", provider)
    assert record["pdfs"] == [] and record["last_failure"] is None


@pytest.mark.parametrize("field,expected,returned", [
    ("doi", "10.1234/abc", "10.1234/other"),
    ("arxiv_id", "2308.11478", "2401.12345"),
])
def test_identity_failure_retains_original_identity_and_survives_reopening(library, monkeypatch, field, expected, returned):
    lib, source, entry = library
    entry = {**entry, field: expected}
    provider = ResearchProvider()
    provider.result = evidence(**{field: returned}, title="An unrelated result", abstract="Wrong abstract")
    monkeypatch.setattr(web_research, "_check_pdf_candidates", lambda *args: pytest.fail("Rejected PDFs must not be downloaded"))
    key = web_research.reference_key(entry["raw"])
    with pytest.raises(web_research.ResearchIdentityMismatch) as caught:
        web_research._research(lib, source, entry, key, provider)
    assert entry["title"] in str(caught.value) and expected in str(caught.value) and returned in str(caught.value)
    record = web_research.get_record(Library(lib.root), source, key)
    assert record[field] == expected and record["title"] == entry["title"]
    assert not record["sources"] and not record["pdfs"] and not record["summary"] and not record["abstract"]
    failure = record["last_failure"]
    assert failure[f"expected_{field}"] == expected and failure[f"returned_{field}"] == returned
    assert failure["returned_title"] == "An unrelated result" and failure["checked_at"]
    assert failure["sources"] == evidence()["sources"]


def test_failed_retry_preserves_confirmed_record_and_success_clears_failure(library, tmp_path):
    lib, source, _ = library
    provider = ResearchProvider()
    record = web_research.research_reference(lib, source, f"{source}:0", provider)
    target, _ = lib.import_pdf(pdf(tmp_path / "target.pdf", "A different registered PDF."))
    record.update(paper_id=target, version="著者最終稿")
    web_research.save_record(lib, source, record)
    provider.result = evidence(doi="10.1234/other", title="Wrong result")
    with pytest.raises(web_research.ResearchIdentityMismatch):
        web_research.research_saved(lib, source, record["key"], provider)
    saved = web_research.get_record(lib, source, record["key"])
    assert saved["last_failure"]["returned_doi"] == "10.1234/other"
    assert {k: v for k, v in saved.items() if k != "last_failure"} == {k: v for k, v in record.items() if k != "last_failure"}
    provider.result = evidence(summary="再確認 [Web 1]。")
    refreshed = web_research.research_saved(lib, source, record["key"], provider)
    assert refreshed["last_failure"] is None and refreshed["paper_id"] == target
    assert refreshed["version"] == "著者最終稿" and "再確認" in refreshed["summary"]


def test_retry_uses_previous_verified_identifier_when_reference_lacks_one(library):
    lib, source, entry = library
    provider = ResearchProvider()
    record = web_research.research_reference(lib, source, f"{source}:0", provider)
    provider.result = evidence(doi="10.1234/other")
    with pytest.raises(web_research.ResearchIdentityMismatch):
        web_research._research(lib, source, {**entry, "doi": ""}, record["key"], provider)
    assert provider.web[-1][1]["doi"] == record["doi"]
    assert web_research.get_record(lib, source, record["key"])["doi"] == record["doi"]


def test_complete_databases_do_not_use_llm_and_save_metadata(library, monkeypatch):
    lib, source, _ = library
    found = {**evidence(), "abstract": "A verified abstract.", "warnings": []}
    monkeypatch.setattr(scholarly_lookup, "lookup", lambda entry, cancel: found)
    provider = ResearchProvider()
    record = web_research.research_reference(lib, source, f"{source}:0", provider)
    assert not provider.web and not provider.normal
    assert record["first_author"] == "A. Smith" and record["publication_year"] == "2020"
    assert record["abstract"] == "A verified abstract." and record["pdfs"]


def test_existing_retrieval_logs_are_separated_from_paper_content(library):
    lib, source, _ = library
    record = web_research.normalized_record(evidence(), "Reference", "legacy")
    record["summary"] = ("書誌情報を確認しました。 [Web 1](https://publisher.example/paper)\n\n"
        "PDF候補は確認できませんでした：HTTP 403\n[確認できなかったPDF候補のURL](https://repository.example/paper.pdf)\n\n"
        "LLMで補完した情報：\n\n目的はロバスト入力整形器の設計です。 [Web 2](https://author.example/paper.pdf)\n\n"
        "Semantic Scholarの情報を取得できませんでした：利用制限中")
    # Simulate a record saved by the previous version, bypassing the new writer.
    with lib.connection() as db:
        db.execute("INSERT INTO reference_research(source,key,data) VALUES(?,?,?)",
                   (source, "legacy", json.dumps(record, ensure_ascii=False)))
    result = web_research.get_record(lib, source, "legacy")
    assert result["summary"] == "目的はロバスト入力整形器の設計です。 [Web 2](https://author.example/paper.pdf)"
    assert len(result["diagnostics"]) == 2
    assert "https://repository.example/paper.pdf" in result["diagnostics"][0]
    assert web_research.presentation_record(result) == result


def test_retrieval_warning_never_becomes_a_paper_summary(library, monkeypatch):
    lib, source, _ = library
    found = {**evidence(), "abstract": "Database abstract", "warnings": ["Semantic Scholarの情報を取得できませんでした：429"]}
    monkeypatch.setattr(scholarly_lookup, "lookup", lambda entry, cancel: found)
    result = web_research.research_reference(lib, source, f"{source}:0", ResearchProvider())
    assert result["summary"] == ""
    assert result["abstract"] == "Database abstract"
    assert result["diagnostics"] == found["warnings"]


def test_llm_only_supplements_missing_fields_and_keeps_database_values(library, monkeypatch):
    lib, source, _ = library
    found = {**evidence(), "abstract": "Database abstract", "venue": "", "pdfs": [], "warnings": []}
    monkeypatch.setattr(scholarly_lookup, "lookup", lambda entry, cancel: found)
    provider = ResearchProvider()
    provider.result = evidence(first_author="Different author", abstract="LLM abstract")
    record = web_research.research_reference(lib, source, f"{source}:0", provider)
    assert provider.web[0][1]["missing_fields"] == ["venue", "pdfs"]
    assert record["abstract"] == "Database abstract" and record["first_author"] == "A. Smith"
    assert record["venue"] == "Control Journal" and record["pdfs"]
    assert "LLMで補完" not in record["summary"]
    assert "[Web 2](https://publisher.example/paper)" in record["summary"]


def test_database_evidence_survives_llm_failure_or_conflicting_doi(library, monkeypatch):
    lib, source, _ = library
    found = {**evidence(), "abstract": "Database abstract", "pdfs": [], "warnings": []}
    monkeypatch.setattr(scholarly_lookup, "lookup", lambda entry, cancel: found)
    provider = ResearchProvider()
    provider.result = evidence(doi="10.1234/other")
    record = web_research.research_reference(lib, source, f"{source}:0", provider)
    assert record["doi"] == "10.1234/abc" and record["sources"] == found["sources"]
    assert record["pdfs"] == [] and "補完は完了できませんでした" in "\n".join(record["diagnostics"])
    assert record["last_failure"]["expected_doi"] == "10.1234/abc"
    assert record["last_failure"]["returned_doi"] == "10.1234/other" and not record["summary"]


def test_database_title_mismatch_is_recorded_without_adopting_supplement(library, monkeypatch):
    lib, source, _ = library
    found = {**evidence(), "abstract": "Database abstract", "pdfs": [], "warnings": []}
    monkeypatch.setattr(scholarly_lookup, "lookup", lambda entry, cancel: found)
    provider = ResearchProvider()
    provider.result = evidence(title="An unrelated result")
    record = web_research.research_reference(lib, source, f"{source}:0", provider)
    assert record["title"] == found["title"] and record["abstract"] == found["abstract"]
    assert record["last_failure"]["returned_title"] == "An unrelated result"
    assert "タイトル" in record["last_failure"]["message"] and not record["pdfs"] and not record["summary"]


def test_rejected_supplement_keeps_previous_confirmed_content(library, monkeypatch):
    lib, source, _ = library
    provider = ResearchProvider()
    previous = web_research.research_reference(lib, source, f"{source}:0", provider)
    previous["abstract"] = "Previously checked abstract"
    web_research.save_record(lib, source, previous)
    found = {**evidence(), "sources": [{"title": "Semantic Scholar", "url": "https://semanticscholar.org/paper/checked"}],
             "abstract": "", "venue": "", "pdfs": [], "warnings": []}
    monkeypatch.setattr(scholarly_lookup, "lookup", lambda entry, cancel: found)
    provider.result = evidence(doi="10.1234/other", abstract="Unrelated abstract")
    record = web_research.research_saved(lib, source, previous["key"], provider)
    for field in ("abstract", "summary", "pdfs", "basis", "venue"):
        assert record[field] == previous[field]
    assert record["sources"] == [*previous["sources"], *found["sources"]]
    assert record["last_failure"]["returned_doi"] == "10.1234/other"


def test_unresolved_llm_values_do_not_fill_missing_database_information(library, monkeypatch):
    lib, source, _ = library
    found = {**evidence(), "abstract": "", "venue": "", "pdfs": [], "warnings": []}
    monkeypatch.setattr(scholarly_lookup, "lookup", lambda entry, cancel: found)
    provider = ResearchProvider()
    provider.result = evidence(basis="unresolved", abstract="Unsupported abstract", venue="Unverified venue", sources=[])
    record = web_research.research_reference(lib, source, f"{source}:0", provider)
    assert not record["abstract"] and not record["venue"]
    assert record["sources"] == found["sources"]


@pytest.mark.parametrize("failure", ["404", "wrong-paper"])
def test_research_filters_unavailable_or_wrong_pdf_and_keeps_sources_and_url(library, tmp_path, monkeypatch, failure):
    lib, source, _ = library
    unrelated = pdf(tmp_path / "unrelated.pdf", "A different technical report\nOther authors\nUnrelated text")

    def download(url, path, cancel, progress, **kwargs):
        assert kwargs == {"max_bytes": 15 * 1024 * 1024, "timeout_seconds": 30}
        if failure == "404":
            raise ValueError("HTTP 404")
        shutil.copyfile(unrelated, path)

    monkeypatch.setattr(reference_pdf, "download_pdf", download)
    record = web_research.research_reference(lib, source, f"{source}:0", ResearchProvider())
    assert record["pdfs"] == [] and record["sources"] == evidence()["sources"]
    assert record["basis"] == "abstract" and "PDF候補は確認できませんでした" in "\n".join(record["diagnostics"])
    assert "https://repository.example/paper.pdf" in "\n".join(record["diagnostics"])


def test_chat_history_keeps_web_state_and_off_uses_only_attached_evidence(library):
    lib, source, _ = library
    provider = ResearchProvider()
    provider.result = {"answer": "外部の検証では [Web 1]。", "sources": evidence()["sources"], "papers": [evidence()]}
    service = PaperService(lib, provider, provider.cancel)
    answer = service.ask(source, "関連文献は？", web_search=True)
    assert "[Web 1](https://publisher.example/paper)" in answer
    key = web_research.records(lib, source)[0]["key"]
    service.ask(source, "添付した抄録との関係は？", research_keys=[key])
    service.ask(source, "本文の説明を続けて")
    history = lib.messages(source, with_usage=True)
    assert [history[i].get("research", {}).get("web_search", False) for i in (1, 3, 5)] == [True, False, False]
    assert history[3]["research"]["attached_keys"] == [key]
    assert "research" not in history[5]
    assert len(provider.web) == 1
    assert json.loads(provider.normal[0][1])["attached_research"][0]["basis"] == "abstract"
    assert lib.messages(source)[0] == {"role": "user", "content": "関連文献は？"}


def test_missing_web_evidence_does_not_save_a_successful_exchange(library):
    lib, source, _ = library
    provider = ResearchProvider()
    provider.result = {"answer": "未確認の答え", "sources": [], "papers": []}
    with pytest.raises(ValueError, match="出典"):
        PaperService(lib, provider, provider.cancel).ask(source, "Webで調べて", web_search=True)
    assert lib.messages(source) == []


def test_backup_restore_keeps_research_and_chat_evidence(library, tmp_path):
    lib, source, _ = library
    provider = ResearchProvider()
    record = web_research.research_reference(lib, source, f"{source}:0", provider)
    provider.result = {"answer": "参照しました [Web 1]。", "sources": record["sources"], "papers": []}
    PaperService(lib, provider, provider.cancel).ask(source, "調べて", web_search=True)
    archive = tmp_path / "backup.zip"
    create_backup(lib, archive)
    restored = Library(tmp_path / "restored")
    restore_backup(restored, archive, import_settings=False)
    restored = Library(restored.root)
    assert web_research.records(restored, source) == web_research.records(lib, source)
    assert restored.messages(source, with_usage=True) == lib.messages(source, with_usage=True)
    restored.delete_paper(source)
    with restored.connection() as db:
        assert db.execute("SELECT count(*) FROM reference_research").fetchone()[0] == 0


@pytest.mark.parametrize("addresses", [["127.0.0.1"], ["192.168.1.1"], ["169.254.169.254"], ["::1"], ["1.1.1.1", "10.0.0.1"]])
def test_pdf_dns_rejects_non_public_addresses(monkeypatch, addresses):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in addresses])
    with pytest.raises(ValueError, match="公開インターネット"):
        reference_pdf.public_addresses("test", 443)


def test_pdf_download_checks_redirects_actual_content_size_and_cancel(tmp_path, monkeypatch):
    content = pdf(tmp_path / "valid.pdf", "A publicly available paper.").read_bytes()
    response = io.BytesIO(content)
    response.status = 200
    response.getheader = lambda key: None
    calls = []

    class Connection:
        def __init__(self, host, address, port):
            calls.append((host, address, port))
        def request(self, *args, **kwargs): pass
        def getresponse(self): return response
        def close(self): pass

    def addresses(host, port):
        if host == "localhost":
            raise ValueError("公開インターネット")
        return ["1.1.1.1"]

    monkeypatch.setattr(reference_pdf, "_PinnedHTTPS", Connection)
    monkeypatch.setattr(reference_pdf, "public_addresses", addresses)
    target = tmp_path / "downloaded.pdf"
    url = "https://publisher.example/paper.pdf"
    assert reference_pdf.download_pdf(url, target, threading.Event(), lambda _: None) == url
    assert target.read_bytes() == content
    assert calls == [("publisher.example", "1.1.1.1", 443)]
    response.status = 302
    response.getheader = lambda key: "https://localhost/secret" if key == "Location" else None
    with pytest.raises(ValueError, match="公開インターネット"):
        reference_pdf.download_pdf(url, target, threading.Event(), lambda _: None)
    response = io.BytesIO(b"<html>login required</html>")
    response.status = 200
    response.getheader = lambda _: None
    with pytest.raises(ValueError, match="PDFではありません"):
        reference_pdf.download_pdf(url, target, threading.Event(), lambda _: None)
    response.getheader = lambda _: str(reference_pdf.MAX_PDF_BYTES + 1)
    with pytest.raises(ValueError, match="100MB"):
        reference_pdf.download_pdf(url, target, threading.Event(), lambda _: None)
    cancel = threading.Event(); cancel.set()
    with pytest.raises(Cancelled):
        reference_pdf.download_pdf(url, target, cancel, lambda _: None)


def wait(job_id):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        job = deps.job_manager.get_job(job_id)
        if job and not job.running:
            return SimpleNamespace(status=job.status, error=job.error, result=job.result.model_dump() if job.result else None)
        time.sleep(0.02)
    raise AssertionError("job did not finish")


@pytest.fixture
def api_env(library, tmp_path, monkeypatch):
    lib, source, entry = library
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setenv("PAPEER_TOKEN", "")
    monkeypatch.setattr(deps, "get_library", lambda: lib)
    monkeypatch.setattr(deps, "get_settings", lambda: Settings(provider="codex", paper_metadata_ai_enabled=True))
    provider = ResearchProvider()
    def provider_for(settings, cancel):
        provider.cancel = cancel
        return provider
    monkeypatch.setattr(deps, "provider_for", provider_for)
    candidate = pdf(tmp_path / "candidate.pdf", "Robust control of systems\nA. Smith\nDetailed original full text, results and limitations.")
    monkeypatch.setattr("sidecar.routes.research.download_pdf", lambda url, path, cancel, progress: shutil.copyfile(candidate, path))
    return TestClient(app), lib, source, entry, provider, candidate


def research(client, source):
    response = client.post(f"/api/papers/{source}/reference-research", json={"reference_id": f"{source}:0"})
    assert response.status_code == 200, response.text
    job = wait(response.json()["job_id"])
    assert job.status == "succeeded", job.error
    return job.result["key"]


def test_failed_job_exposes_reference_identity_and_persisted_diagnostic(api_env):
    client, lib, source, entry, provider, _ = api_env
    provider.result = evidence(doi="10.1234/other", title="Unrelated paper")
    response = client.post(f"/api/papers/{source}/reference-research", json={"reference_id": f"{source}:0"})
    assert response.status_code == 200
    job = wait(response.json()["job_id"])
    assert job.status == "failed" and job.result is None
    assert entry["title"] in job.error and "10.1234/abc" in job.error and "10.1234/other" in job.error
    response = client.get(f"/api/papers/{source}/reference-research")
    assert response.status_code == 200
    record = response.json()[0]
    assert record["last_failure"]["message"] == job.error
    assert record["doi"] == entry["doi"] and record["title"] == entry["title"]
    assert not record["pdfs"] and not record["sources"] and not record["summary"]
    assert web_research.get_record(Library(lib.root), source, record["key"])["last_failure"] == record["last_failure"]
    provider.result = evidence()
    assert research(client, source) == record["key"]
    assert client.get(f"/api/papers/{source}/reference-research").json()[0]["last_failure"] is None


def test_cancelled_identity_failure_does_not_persist_a_rejection(library, monkeypatch):
    lib, source, _ = library
    provider = ResearchProvider()
    def rejected(*args):
        provider.cancel.set()
        raise web_research.ResearchIdentityMismatch({"title": "Reference", "doi": "10.1234/abc"}, evidence(doi="10.1234/other"))
    monkeypatch.setattr(web_research, "_research_verified", rejected)
    with pytest.raises(Cancelled):
        web_research.research_reference(lib, source, f"{source}:0", provider)
    assert not web_research.records(lib, source)


def test_lookup_does_not_block_summary_chat_or_translation_dictionary_saves(api_env, monkeypatch):
    client, lib, source, _, _, _ = api_env
    entered, release = threading.Event(), threading.Event()

    def lookup(*_):
        entered.set()
        assert release.wait(15)
        return {"title": "", "doi": "", "arxiv_id": "", "first_author": "", "publication_year": "",
                "venue": "", "abstract": "", "sources": [], "pdfs": [], "warnings": []}

    monkeypatch.setattr(scholarly_lookup, "lookup", lookup)
    monkeypatch.setattr(deps, "provider_for", lambda settings, cancel: ResearchProvider(cancel))
    response = client.post(f"/api/papers/{source}/reference-research", json={"reference_id": f"{source}:0"})
    assert response.status_code == 200, response.text
    lookup_id = response.json()["job_id"]
    try:
        assert entered.wait(2)
        # Translation saves both dictionaries before submitting its AI work.
        shared = client.get("/api/glossary").json()
        saved = client.put("/api/glossary", json={"terms": shared, "expected_terms": shared})
        assert saved.status_code == 200, saved.text
        local = client.get(f"/api/papers/{source}/glossary").json()
        saved = client.put(f"/api/papers/{source}/glossary", json={**local, "expected": local})
        assert saved.status_code == 200, saved.text
        for endpoint, body in (("article", None), ("ask", {"question": "Explain the method"})):
            started = client.post(f"/api/papers/{source}/{endpoint}", json=body)
            assert started.status_code == 200, started.text
            result = wait(started.json()["job_id"])
            assert result.status == "succeeded", result.error
            assert deps.job_manager.get_job(lookup_id).running
        assert "PDFの本文に基づく回答" in (lib.paper_folder(source) / "article.md").read_text("utf-8")
        assert len(lib.messages(source)) == 2
        assert client.delete(f"/api/papers/{source}").status_code == 409
    finally:
        release.set()
        assert wait(lookup_id).status == "succeeded"


def import_reference(client, source, key, **body):
    response = client.post(f"/api/papers/{source}/reference-import/{key}", json=body)
    assert response.status_code == 200, response.text
    return wait(response.json()["job_id"])


def test_public_pdf_import_summary_duplicate_and_history_link(api_env):
    client, lib, source, entry, provider, _ = api_env
    key = research(client, source)
    job = import_reference(client, source, key, pdf_index=0, collection="輪講 / 文献", create_summary=True)
    assert job.status == "succeeded", job.error
    record = job.result["record"]
    target = record["paper_id"]
    assert record["has_summary"] and record["version"] == "著者最終稿"
    assert lib.paper(target)["collection_name"] == "輪講 / 文献"
    files = PaperFiles(lib.paper_folder(target))
    original_summary = files.article_md.read_bytes()
    calls = len(provider.normal)
    again = import_reference(client, source, key, create_summary=True)
    assert again.status == "succeeded" and not again.result["added"]
    assert files.article_md.read_bytes() == original_summary and len(provider.normal) == calls
    assert len(lib.papers()) == 2
    refs = citation_graph(lib)["references"]
    assert refs[0]["target"] == target and refs[0]["research_key"] == web_research.reference_key(entry["raw"])


@pytest.mark.parametrize("failure", [RuntimeError("provider failed"), Cancelled("summary stopped")])
def test_summary_failure_or_cancel_keeps_the_imported_pdf(api_env, failure):
    client, lib, source, _, provider, _ = api_env
    key = research(client, source)
    provider.summary_failure = failure
    job = import_reference(client, source, key, pdf_index=0, create_summary=True)
    assert job.status == ("cancelled" if isinstance(failure, Cancelled) else "succeeded"), job.error
    record = web_research.get_record(lib, source, key)
    assert record["paper_id"] and not record["has_summary"]
    assert PaperFiles(lib.paper_folder(record["paper_id"])).original_pdf.is_file()
    if not isinstance(failure, Cancelled):
        assert "PDFは取り込み済み" in record["summary_error"]
    provider.summary_failure = None
    retry = import_reference(client, source, key, create_summary=True)
    assert retry.status == "succeeded" and retry.result["record"]["has_summary"]


def test_manual_pdf_import_needs_no_search_or_translation(api_env):
    client, lib, source, entry, provider, candidate = api_env
    key = web_research.reference_key(entry["raw"])
    job = import_reference(client, source, key, local_path=str(candidate), create_summary=True)
    assert job.status == "succeeded", job.error
    target = job.result["record"]["paper_id"]
    assert job.result["record"]["has_summary"]
    assert provider.web == []
    assert not PaperFiles(lib.paper_folder(target)).translated_pdf.is_file()
    assert client.get(f"/api/papers/{source}/reference-research").json()[0]["paper_id"] == target


def test_already_registered_reference_gets_a_summary_without_downloading(api_env, monkeypatch):
    client, lib, source, _, _, candidate = api_env
    target, _ = lib.import_pdf(candidate)
    lib.update(target, doi="10.1234/abc")
    key = research(client, source)
    def never_download(*args):
        raise AssertionError("an existing reference must not be downloaded again")
    monkeypatch.setattr("sidecar.routes.research.download_pdf", never_download)
    job = import_reference(client, source, key, create_summary=True)
    assert job.status == "succeeded", job.error
    assert job.result["record"]["paper_id"] == target and job.result["record"]["has_summary"]
    assert not job.result["added"] and len(lib.papers()) == 2


def test_scan_pdf_is_kept_with_an_ocr_explanation(api_env, tmp_path):
    client, lib, source, entry, provider, candidate = api_env
    scan = tmp_path / "scan.pdf"
    with fitz.open(candidate) as original, fitz.open() as document:
        page = document.new_page()
        page.insert_image(page.rect, stream=original[0].get_pixmap().tobytes("png"))
        document.save(scan)
    job = import_reference(client, source, web_research.reference_key(entry["raw"]),
                           local_path=str(scan), create_summary=True)
    assert job.status == "succeeded", job.error
    assert job.result["record"]["needs_ocr"] and "OCR" in job.result["record"]["summary_error"]
    assert not job.result["record"]["has_summary"] and not provider.normal
    assert len(lib.papers()) == 2


def test_api_allows_database_lookup_without_llm_web_and_rejects_wrong_reference(api_env, monkeypatch):
    client, _, source, _, provider, _ = api_env
    monkeypatch.setattr(deps, "get_settings", lambda: Settings(provider="api", paper_metadata_ai_enabled=True))
    monkeypatch.setattr(provider, "spec", ProviderSpec("api", "API", "API", "http"))
    assert client.get("/api/research-capabilities").json() == {
        "paper_discovery_enabled": True, "web_search": False, "reference_research_enabled": True, "reference_lookup": True, "reference_web_search": False}
    response = client.post(f"/api/papers/{source}/reference-research", json={"reference_id": f"{source}:0"})
    assert response.status_code == 200 and wait(response.json()["job_id"]).status == "succeeded"
    assert not provider.web
    assert client.post(f"/api/papers/{source}/ask", json={"question": "Search", "web_search": True}).status_code == 400
    assert client.post(f"/api/papers/{source}/reference-research", json={"reference_id": "other:0"}).status_code == 400


def test_reference_lookup_uses_shared_opt_in_and_information_connection(api_env, monkeypatch):
    client, _, source, _, provider, _ = api_env
    settings = Settings(provider="api", model="translation-model", paper_metadata_provider="codex",
                        paper_metadata_model="lookup-model")
    monkeypatch.setattr(deps, "get_settings", lambda: settings)
    calls = []

    def factory(selected, cancel):
        calls.append((selected.provider, selected.model))
        provider.cancel = cancel
        return provider

    monkeypatch.setattr(deps, "provider_for", factory)
    assert client.get("/api/research-capabilities").json() == {
        "paper_discovery_enabled": True, "web_search": False, "reference_research_enabled": False, "reference_lookup": True, "reference_web_search": True}
    response = client.post(f"/api/papers/{source}/reference-research", json={"reference_id": f"{source}:0"})
    assert response.status_code == 400 and "論文情報の取得にAIを使う" in response.text
    assert not calls
    settings.paper_metadata_ai_enabled = True
    research(client, source)
    assert calls == [("codex", "lookup-model")]
    # An information connection without web tools still permits bibliographic databases.
    settings.provider, settings.paper_metadata_provider = "codex", "api"
    monkeypatch.setattr(provider, "spec", ProviderSpec("api", "API", "API", "http"))
    response = client.post(f"/api/papers/{source}/reference-research", json={"reference_id": f"{source}:0"})
    assert response.status_code == 200 and wait(response.json()["job_id"]).status == "succeeded"
    assert len(calls) == 2


def test_saving_information_off_cancels_reference_lookup_without_a_frontend(api_env, tmp_path, monkeypatch):
    client, lib, source, _, provider, _ = api_env
    Settings(provider="codex", paper_metadata_ai_enabled=True).save(tmp_path)
    monkeypatch.setattr(deps, "get_settings", lambda: Settings.load(tmp_path))
    monkeypatch.setattr(deps, "get_settings_with_unknown_keys", lambda: (Settings.load(tmp_path), []))
    started = threading.Event()

    def search(*args):
        started.set()
        assert provider.cancel.wait(5), "settings OFF did not cancel the running lookup"
        raise Cancelled("Stopped")

    monkeypatch.setattr(provider, "search_web", search)
    response = client.post(f"/api/papers/{source}/reference-research", json={"reference_id": f"{source}:0"})
    assert response.status_code == 200 and started.wait(5)
    try:
        saved = client.put("/api/settings", json={"paper_metadata_ai_enabled": False})
        assert saved.status_code == 200, saved.text
        assert wait(response.json()["job_id"]).status == "cancelled"
        assert not web_research.records(lib, source)
        assert client.get("/api/research-capabilities").json()["reference_research_enabled"] is False
        assert client.post(f"/api/papers/{source}/reference-research", json={"reference_id": f"{source}:0"}).status_code == 400
    finally:
        deps.job_manager.cancel_job(response.json()["job_id"])


@pytest.mark.parametrize("cls,provider_id,module", [
    (ClaudeCodeProvider, "claude", "papeer.providers.claude_code"),
    (AntigravityProvider, "antigravity", "papeer.providers.antigravity"),
])
def test_cli_research_chat_and_pdf_import_share_the_same_api(api_env, monkeypatch, cls, provider_id, module):
    client, lib, source, _, _, _ = api_env
    monkeypatch.setattr(deps, "get_settings", lambda: Settings(provider=provider_id, model="", paper_metadata_ai_enabled=True))
    monkeypatch.setattr(cls, "command", lambda self: [provider_id])
    monkeypatch.setattr(deps, "provider_for", lambda settings, cancel: cls(settings, cancel))

    def execute(**kwargs):
        prompt = kwargs["prompt_bytes"].decode("utf-8")
        command = kwargs["command"]
        searching = ((command[command.index("--tools") + 1] != "") if provider_id == "claude"
                     else command[command.index("--agent") + 1] == "papeer-web")
        if not searching:
            assert "--dangerously-skip-permissions" not in command
            if provider_id == "claude":
                return json.dumps({"type": "result", "is_error": False, "result": "本文から作成したサマリー。"}), ""
            return json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": "本文から作成したサマリー。"}}), ""
        result = ({"answer": "外部情報を確認しました [Web 1]。", "sources": evidence()["sources"], "papers": [evidence()]}
                  if "Answer the question in Japanese" in prompt else evidence())
        if provider_id == "claude":
            return json.dumps({"type": "result", "is_error": False, "result": "", "structured_output": result}), ""
        return json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": json.dumps(result)}}), ""

    monkeypatch.setattr(f"{module}.run_cli_process", execute)
    assert client.get("/api/research-capabilities").json() == {
        "paper_discovery_enabled": True, "web_search": True, "reference_research_enabled": True, "reference_lookup": True, "reference_web_search": True}
    key = research(client, source)
    record = client.get(f"/api/papers/{source}/reference-research").json()[0]
    assert record["sources"] == evidence()["sources"]
    assert "[Web 1](https://publisher.example/paper)" in record["summary"]
    response = client.post(f"/api/papers/{source}/ask", json={"question": "背景を調べて", "web_search": True})
    assert response.status_code == 200, response.text
    job = wait(response.json()["job_id"])
    assert job.status == "succeeded", job.error
    history = lib.messages(source, with_usage=True)
    assert history[-1]["research"]["web_search"] and history[-1]["research"]["sources"] == evidence()["sources"]
    imported = import_reference(client, source, key, pdf_index=0, create_summary=True)
    assert imported.status == "succeeded", imported.error
    assert imported.result["record"]["paper_id"] != source and imported.result["added"]
    assert imported.result["record"]["has_summary"]
    assert len(lib.papers()) == 2
