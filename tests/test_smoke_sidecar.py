"""tools/smoke_sidecar.py (`just smoke-sidecar`): its checks, the stand-in AI server, and cleanup on failure.

The packaged exe itself is not needed: the end-to-end test runs the script against `python -m sidecar`.
"""
import io
import json
from pathlib import Path
import sys

import pymupdf
import pytest

from papeer.core import prompts
from papeer.core.config import Settings
from papeer.layout.math_layout import MATH_TOKEN
from papeer.providers.openai_compat import OpenAICompatProvider
from papeer.translation.translation import TRANSLATION_SCHEMA, _assemble_parts, _source_parts, validate_translations
from tools import smoke_sidecar
from tools.smoke_sidecar import (STUB_TEXT, SmokeFailure, StubAI, check_health, check_translated_pdf, expected_prompts,
                                 is_semver, job_outcome, main, mei_folders, run_smoke, sidecar_environment, stub_answer)

CODE = "code-sha256-" + "0" * 64
UNITS = [{"id": "p1-b1", "page": 1, "text": "We study an adaptive controller [[PD_MATH_1]] where the error is bounded."},
         {"id": "p1-b2", "page": 1, "text": "Method"}]


def test_math_token_is_the_one_the_translation_checks():
    assert smoke_sidecar.MATH_TOKEN.pattern == MATH_TOKEN.pattern


@pytest.mark.parametrize("value, ok", [("0.2.0", True), ("10.0.255", True), ("0.2", False), ("0.2.0-beta", False),
                                       ("01.2.0", False), ("code-sha256-abc", False), (None, False)])
def test_version_must_be_major_minor_patch(value, ok):
    assert is_semver(value) is ok


def test_environment_isolates_the_sidecar(tmp_path):
    base = {"PATH": "C:\\bin", "PAPEER_TOKEN": "old", "PAPERDESK_DATA_DIR": "C:\\real", "papeer_dev_no_auth": "1",
            "OPENAI_API_KEY": "sk-real", "LOCALAPPDATA": "C:\\Users\\me\\AppData\\Local", "TEMP": "C:\\Temp"}
    env = sidecar_environment(base, data_dir=tmp_path / "data", local_appdata=tmp_path / "local",
                              temp_dir=tmp_path / "temp", token="t0ken", port=5123)
    assert env["PATH"] == "C:\\bin"
    assert env["PAPEER_TOKEN"] == "t0ken" and env["PAPEER_PORT"] == "5123"
    assert env["PAPEER_DATA_DIR"] == str(tmp_path / "data")
    assert env["LOCALAPPDATA"] == str(tmp_path / "local")
    assert env["TEMP"] == env["TMP"] == str(tmp_path / "temp")
    assert "127.0.0.1" in env["NO_PROXY"]
    for name in ("PAPERDESK_DATA_DIR", "papeer_dev_no_auth", "OPENAI_API_KEY"):
        assert name not in env


def test_mei_folders_lists_only_extraction_folders(tmp_path):
    (tmp_path / "_MEI12345").mkdir()
    (tmp_path / "_MEI99999").write_text("a file, not a folder")
    (tmp_path / "other").mkdir()
    assert [path.name for path in mei_folders(tmp_path)] == ["_MEI12345"]
    assert mei_folders(tmp_path / "missing") == []


def test_health_check():
    check_health({"status": "ok", "version": "0.2.0", "code_version": CODE}, "0.2.0", CODE)
    with pytest.raises(SmokeFailure, match="MAJOR.MINOR.PATCH"):
        check_health({"status": "ok", "version": CODE, "code_version": CODE}, "0.2.0", CODE)
    with pytest.raises(SmokeFailure, match="ソースの版"):
        check_health({"status": "ok", "version": "0.1.0", "code_version": CODE}, "0.2.0", CODE)
    with pytest.raises(SmokeFailure, match="just build-sidecar"):
        check_health({"status": "ok", "version": "0.2.0", "code_version": "code-sha256-" + "1" * 64}, "0.2.0", CODE)
    with pytest.raises(SmokeFailure, match="応答が不正"):
        check_health({"version": "0.2.0"}, "0.2.0", CODE)


def test_job_outcome():
    running = {"job_id": "a", "kind": "import", "running": True, "status": "running"}
    assert job_outcome([running], "a") is None
    done = {**running, "running": False, "status": "succeeded", "result": {"paper_ids": ["x"]}}
    assert job_outcome([{"job_id": "b"}, done], "a") == done
    with pytest.raises(SmokeFailure, match="failed で終わりました: 壊れたPDF"):
        job_outcome([{**running, "running": False, "status": "failed", "error": "壊れたPDF"}], "a")
    with pytest.raises(SmokeFailure, match="ジョブ一覧にありません"):
        job_outcome([], "a")
    with pytest.raises(SmokeFailure, match="ジョブ一覧にありません"):
        job_outcome({"detail": "unexpected"}, "a")


def test_stub_answers_pass_the_translation_checks():
    instruction = "translate\n" + smoke_sidecar.SCHEMA_MARKER + ": {}"
    assert validate_translations(stub_answer(instruction, json.dumps(UNITS)), UNITS)["p1-b1"].endswith("[[PD_MATH_1]]")
    # The first request of a batch sends {"paper", "glossary", "blocks": [...]}.
    blocks = {"paper": {"title": "A paper"}, "glossary": [], "blocks": [{"id": u["id"], "text": u["text"]} for u in UNITS]}
    assert set(validate_translations(stub_answer(instruction, json.dumps(blocks)), UNITS)) == {"p1-b1", "p1-b2"}
    # The fallback request sends {"texts": [...]} with context around them.
    texts = [{"id": "text0", "text": "an adaptive controller"}]
    assert validate_translations(stub_answer(instruction, json.dumps({"context_parts": [], "texts": texts})), texts)
    # Formula-marker recovery sends the prose and math parts separately.
    parts, tokens = _source_parts(UNITS[0])
    answer = stub_answer(instruction, json.dumps({"source_parts": parts, "required_math_indices": [0]}))
    assert "[[PD_MATH_1]]" in _assemble_parts(answer, tokens)
    # Plain requests (summary, keywords) get plain text.
    assert stub_answer("summarize", "data") == STUB_TEXT


def test_stub_server_speaks_the_openai_compatible_protocol():
    with StubAI() as stub:
        settings = Settings(provider="api", model="papeer-smoke-stub",
                            provider_options={"api": {"base_url": stub.base_url}})
        answer = OpenAICompatProvider(settings).generate("translate", json.dumps(UNITS), TRANSLATION_SCHEMA)
        assert set(validate_translations(answer, UNITS)) == {"p1-b1", "p1-b2"}
        assert stub.requests == 1


def test_expected_prompts_are_the_built_in_ones():
    assert expected_prompts() == prompts.defaults()
    assert expected_prompts()  # the folder is found at all


def test_shared_marker_matches_the_prompts_marker():
    assert smoke_sidecar.SHARED_MARKER.search(prompts.builtin("translation"))
    assert not smoke_sidecar.SHARED_MARKER.search(prompts.expand(prompts.builtin("translation")))


def test_translated_pdf_without_the_bundled_font_fails():
    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((72, 72), "translated text in Helvetica")
        data = pdf.tobytes()
    with pytest.raises(SmokeFailure, match="PapeerSerif"):
        check_translated_pdf(data)
    with pytest.raises(SmokeFailure, match="PDF ではありません"):
        check_translated_pdf(b"<html>")


@pytest.fixture
def smoke_root(tmp_path, monkeypatch):
    """The temporary folder run_smoke creates, so a test can see that it is removed."""
    root = tmp_path / "smoke"

    def mkdtemp(prefix=""):
        root.mkdir()
        return str(root)

    monkeypatch.setattr(smoke_sidecar.tempfile, "mkdtemp", mkdtemp)
    return root


def test_a_sidecar_that_exits_fails_with_its_log(smoke_root):
    out = io.StringIO()
    command = [sys.executable, "-c", "print('boom: missing module'); raise SystemExit(3)"]
    assert run_smoke(command, cwd=None, frozen=True, out=out) == 1
    text = out.getvalue()
    assert "スモークテスト失敗: 起動と /health: sidecar が終了しました（終了コード 3）" in text
    assert "boom: missing module" in text
    assert not smoke_root.exists()


def test_a_sidecar_that_never_answers_is_stopped(smoke_root, monkeypatch):
    monkeypatch.setattr(smoke_sidecar, "HEALTH_TIMEOUT", 1.0)
    processes = []
    original_stop = smoke_sidecar.Smoke.stop

    def stop(self):
        processes.append(self.process)
        original_stop(self)

    monkeypatch.setattr(smoke_sidecar.Smoke, "stop", stop)
    out = io.StringIO()
    assert run_smoke([sys.executable, "-c", "import time; time.sleep(120)"], cwd=None, frozen=True, out=out) == 1
    assert "/health が応答しません" in out.getvalue()
    assert "強制終了しました" in out.getvalue()
    assert processes and all(process.poll() is not None for process in processes)
    assert not smoke_root.exists()


def test_a_failure_while_preparing_still_removes_the_folder(smoke_root, monkeypatch):
    def broken_init(self, *args, **kwargs):
        raise OSError("no space left")

    monkeypatch.setattr(smoke_sidecar.Smoke, "__init__", broken_init)
    with pytest.raises(OSError, match="no space left"):
        run_smoke([sys.executable, "-c", "pass"], cwd=None, frozen=True, out=io.StringIO())
    assert not smoke_root.exists()


def test_a_folder_that_cannot_be_removed_is_reported(smoke_root, monkeypatch):
    monkeypatch.setattr(smoke_sidecar, "remove_tree", lambda path: False)
    out = io.StringIO()
    assert run_smoke([sys.executable, "-c", "raise SystemExit(3)"], cwd=None, frozen=True, out=out) == 1
    assert f"一時フォルダーを消せませんでした: {smoke_root}" in out.getvalue()


def test_remove_tree_reports_whether_the_folder_is_gone(tmp_path, monkeypatch):
    folder = tmp_path / "gone"
    (folder / "nested").mkdir(parents=True)
    assert smoke_sidecar.remove_tree(folder) is True and not folder.exists()
    stuck = tmp_path / "stuck"
    stuck.mkdir()
    monkeypatch.setattr(smoke_sidecar.shutil, "rmtree", lambda path, ignore_errors=False: None)
    monkeypatch.setattr(smoke_sidecar.time, "sleep", lambda seconds: None)
    assert smoke_sidecar.remove_tree(stuck) is False


def test_missing_exe_says_how_to_build_it(tmp_path):
    out = io.StringIO()
    assert main(["--exe", str(tmp_path / "missing.exe")], out=out) == 1
    assert "just build-sidecar" in out.getvalue()


def test_every_check_passes_against_the_source_sidecar(smoke_root):
    # The same run as `just smoke-sidecar`, with `python -m sidecar` in place of the exe (a few seconds).
    out = io.StringIO()
    assert main(["--source"], out=out) == 0, out.getvalue()
    assert out.getvalue().count("OK  ") == 7
    assert not smoke_root.exists()
    assert Path(smoke_sidecar.SAMPLE_PDF).is_file()
