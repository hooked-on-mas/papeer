"""The command line client (papeer/cli): its commands against the real sidecar app in process, the job loop
(progress, Ctrl+C, reconnecting), finding and starting a sidecar (with a fake process), and what it imports.

Real processes are in tests/test_cli_spawn.py.
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

from fastapi.testclient import TestClient
import pytest

from papeer.cli import jobs
from papeer.cli.client import CliError, ConnectionLost, Reply, Session, Target
from papeer.cli.connect import Connector, Options
from papeer.cli.jobs import Interrupted, run_job
from papeer.cli.main import main
from papeer.cli.output import Output, display_width, page_ranges, table
from papeer.core import instance as discovery
from papeer.core.storage import Library
from sidecar.jobs import JobManager

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PDF = Path(__file__).parent / "fixtures/sample.pdf"
TOKEN = "cli-test-token"


# --- Helpers ---

def ok(data: Any) -> Reply:
    return Reply(200, json.dumps(data).encode())


def fail(status: int, detail: str, code: str | None = None) -> Reply:
    return Reply(status, json.dumps({"detail": detail, **({"code": code} if code else {})}).encode())


def job_state(status: str = "running", message: str = "", done: int | None = None, total: int | None = None,
              result: Any = None, error: str | None = None, job_id: str = "j1", kind: str = "import") -> dict:
    return {"job_id": job_id, "paper_id": None, "kind": kind, "message": message, "done": done, "total": total,
            "status": status, "running": status == "running", "cancelled": status == "cancelled",
            "result": result, "error": error}


class Seq(list):
    """Answers taken in turn by a FakeTransport route (the last one stays); a plain list is one answer."""


class FakeTransport:
    """Answers by (method, path): a value, a Reply, an exception, a Seq of those or a callable(body, query)
    returning one. Records every request."""

    def __init__(self, routes: dict[tuple[str, str], Any] | None = None) -> None:
        self.routes = routes or {}
        self.calls: list[dict[str, Any]] = []

    def request(self, method, path, *, body=None, query=None, timeout=30.0):
        self.calls.append({"method": method, "path": path, "body": body, "query": dict(query) if query else None})
        route = self.routes.get((method, path), fail(404, f"no route {method} {path}"))
        if isinstance(route, Seq):
            route = route.pop(0) if len(route) > 1 else route[0]
        if callable(route):
            route = route(body, query)
        if isinstance(route, BaseException):
            raise route
        return route if isinstance(route, Reply) else ok(route)

    def paths(self, method: str | None = None) -> list[str]:
        return [call["path"] for call in self.calls if method is None or call["method"] == method]

    def bodies(self, method: str, path: str) -> list[Any]:
        return [call["body"] for call in self.calls if (call["method"], call["path"]) == (method, path)]


class AppTransport:
    """The sidecar app itself, called in process."""

    def __init__(self, client: TestClient) -> None:
        self.client = client

    def request(self, method, path, *, body=None, query=None, timeout=30.0):
        response = self.client.request(method, path, json=body, params=query,
                                       headers={"Authorization": f"Bearer {TOKEN}"})
        return Reply(response.status_code, response.content)


def run(argv, transport=None, *, tty: bool = False, stdin: str = "", interactive: bool | None = None,
        connector=None) -> tuple[int, str, str]:
    out = Output(io.StringIO(), io.StringIO(), io.StringIO(stdin), progress_tty=tty, interactive=interactive)
    code = main(argv, transport=transport, out=out, connector=connector)
    return code, out.stdout.getvalue(), out.stderr.getvalue()  # type: ignore[attr-defined]


def add_paper(lib: Library, identity: str, title: str, collection: str = "", text: str = "") -> str:
    with lib.connection() as db:
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,status,collection_name,first_author,"
                   "publication_year,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                   (identity, "sha" + identity, title, title + ".pdf", 1, "not_translated", collection, "", "",
                    "2026-01-01 00:00:00"))
        db.execute("INSERT INTO pages(paper_id,number,text) VALUES(?,1,?)", (identity, text))
    return identity


RL = "a1b2c3d4" + "0" * 24
RL2 = "a1b2c3d5" + "0" * 24  # Shares "a1b2c3d" with RL.
VISION = "ffeedd00" + "0" * 24
CONTROL = "00112233" + "0" * 24


@pytest.fixture
def api(tmp_path, monkeypatch):
    """The sidecar app over a library of four papers; (transport, library, ids)."""
    lib = Library(tmp_path / "data")
    add_paper(lib, RL, "Deep Q-learning", "", "We train a policy with Q-learning.")
    add_paper(lib, RL2, "Double Q-learning", "強化学習", "Another Q-learning paper.")
    add_paper(lib, VISION, "ResNet", "", "Image recognition with residual networks.")
    add_paper(lib, CONTROL, "Adaptive control", "制御 / 適応", "A controller.")
    lib.create_collection("制御")
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    monkeypatch.setattr("sidecar.deps.job_manager", JobManager())
    monkeypatch.setattr("sidecar.deps.library_changed", lambda: None)
    monkeypatch.setattr(jobs, "POLL_INTERVAL", 0.01)
    from sidecar import app as runtime
    with TestClient(runtime.app) as client:
        yield AppTransport(client), lib, client


def folders_of(lib: Library) -> dict[str, str]:
    with lib.connection() as db:
        return {row["id"]: row["collection_name"] for row in db.execute("SELECT id,collection_name FROM papers")}


# --- add ---

def import_routes(paths_seen: list, result: dict | None = None) -> dict:
    return {
        ("GET", "/api/collections"): ["別"],
        ("POST", "/api/collections"): {"status": "created", "name": "試験"},
        ("POST", "/api/papers/import"): lambda body, query: (paths_seen.append(body), {"job_id": "j1"})[1],
        ("GET", "/api/jobs/j1"): job_state("succeeded", result=result or {
            "paper_ids": ["p1", "p2"], "added": 1, "added_ids": ["p1"], "needs_ocr": [], "metadata_failures": []}),
        ("GET", "/api/papers"): [{"id": "p1", "title": "One"}, {"id": "p2", "title": "Two"}],
    }


def test_add_expands_globs_sends_absolute_paths_and_creates_the_folder(tmp_path, monkeypatch):
    (tmp_path / "sub").mkdir()
    for name in ("a.pdf", "sub/b.pdf", "sub/c.txt"):
        (tmp_path / name).write_bytes(b"%PDF")
    monkeypatch.chdir(tmp_path)
    seen: list = []
    transport = FakeTransport(import_routes(seen))
    code, stdout, stderr = run(["add", "a.pdf", "sub/*.pdf", "a.pdf", "--folder", "試験"], transport)
    assert code == 0, stderr
    # Absolute, sorted as the pattern gave them, a repeated file once; the folder did not exist and is made first.
    assert seen == [{"paths": [str(tmp_path / "a.pdf"), str(tmp_path / "sub" / "b.pdf")], "collection": "試験"}]
    assert transport.paths("POST")[0] == "/api/collections"
    assert transport.bodies("POST", "/api/collections") == [{"name": "試験"}]
    assert "追加" in stdout and "重複" in stdout and "One" in stdout and "Two" in stdout
    assert "1 件を追加しました（1 件はライブラリにありました）" in stdout


def test_add_takes_a_file_whose_name_has_glob_characters_as_it_is(tmp_path, monkeypatch):
    (tmp_path / "Smith [2020] 論文.pdf").write_bytes(b"%PDF")
    (tmp_path / "other.pdf").write_bytes(b"%PDF")
    monkeypatch.chdir(tmp_path)
    seen: list = []
    code, _, stderr = run(["add", "Smith [2020] 論文.pdf"], FakeTransport(import_routes(seen)))
    assert code == 0, stderr
    assert seen == [{"paths": [str(tmp_path / "Smith [2020] 論文.pdf")]}]
    # What is not there is still a pattern: [ot]* matches other.pdf only.
    seen.clear()
    assert run(["add", "[o]ther.pdf", "Smith [2020] 論文.pdf"], FakeTransport(import_routes(seen)))[0] == 0
    assert seen == [{"paths": [str(tmp_path / "other.pdf"), str(tmp_path / "Smith [2020] 論文.pdf")]}]


def test_add_does_not_create_a_folder_that_exists(tmp_path, monkeypatch):
    (tmp_path / "a.pdf").write_bytes(b"%PDF")
    monkeypatch.chdir(tmp_path)
    transport = FakeTransport(import_routes([]))
    assert run(["add", "a.pdf", "-f", "別"], transport)[0] == 0
    assert ("POST", "/api/collections") not in [(c["method"], c["path"]) for c in transport.calls]


def test_add_directories_need_r_and_only_pdfs_are_taken(tmp_path, monkeypatch):
    (tmp_path / "docs" / "deep").mkdir(parents=True)
    for name in ("docs/x.pdf", "docs/deep/y.PDF", "docs/note.txt"):
        (tmp_path / name).write_bytes(b"%PDF")
    monkeypatch.chdir(tmp_path)
    transport = FakeTransport(import_routes([]))
    code, _, stderr = run(["add", "docs"], transport)
    assert code == 2 and "-r" in stderr and transport.calls == []
    seen: list = []
    transport = FakeTransport(import_routes(seen))
    assert run(["add", "docs", "-r"], transport)[0] == 0
    assert [Path(p).name for p in seen[0]["paths"]] == ["y.PDF", "x.pdf"] or \
        sorted(Path(p).name for p in seen[0]["paths"]) == ["x.pdf", "y.PDF"]
    # A pattern that matches nothing, a missing file and a file that is not a PDF are usage errors: nothing is sent.
    transport = FakeTransport(import_routes([]))
    code, _, stderr = run(["add", "none*.pdf", "missing.pdf", "docs/note.txt"], transport)
    assert code == 2 and stderr.count("エラー") == 3 and transport.calls == []


def test_add_no_wait_prints_the_job_and_does_not_poll(tmp_path, monkeypatch):
    (tmp_path / "a.pdf").write_bytes(b"%PDF")
    monkeypatch.chdir(tmp_path)
    transport = FakeTransport(import_routes([]))
    code, stdout, _ = run(["add", "a.pdf", "--no-wait", "--json"], transport)
    assert code == 0 and json.loads(stdout)["job_id"] == "j1"
    assert "/api/jobs/j1" not in transport.paths()


def test_add_a_real_pdf_then_the_same_again_is_a_duplicate(api, tmp_path):
    transport, lib, _ = api
    code, stdout, stderr = run(["add", str(FIXTURE_PDF), "--folder", "試験", "--json"], transport)
    assert code == 0, stderr
    data = json.loads(stdout)
    assert data["added"] == 1 and data["papers"][0]["status"] == "added" and data["folder"] == "試験"
    assert "試験" in lib.collections()
    assert folders_of(lib)[data["papers"][0]["paper_id"]] == "試験"
    code, stdout, _ = run(["add", str(FIXTURE_PDF), "--folder", "試験", "--json"], transport)
    assert code == 0 and json.loads(stdout)["papers"][0]["status"] == "duplicate"


# --- ls and folder ---

def test_ls_json_lists_rows_and_filters_by_folder(api):
    transport, _, _ = api
    code, stdout, _ = run(["ls", "--json"], transport)
    assert code == 0 and {row["id"] for row in json.loads(stdout)} == {RL, RL2, VISION, CONTROL}
    code, stdout, _ = run(["ls", "制御", "--json"], transport)
    assert json.loads(stdout) == []  # Only papers directly in 制御: none (the paper is in its subfolder).
    code, stdout, _ = run(["ls", "制御", "--all", "--json"], transport)
    assert [row["id"] for row in json.loads(stdout)] == [CONTROL]
    code, stdout, _ = run(["ls", "", "--json"], transport)
    assert {row["id"] for row in json.loads(stdout)} == {RL, VISION}  # Unfiled.
    code, stdout, _ = run(["ls", "-q", "ResNet", "--json"], transport)
    assert [row["id"] for row in json.loads(stdout)] == [VISION]


def test_ls_prints_a_table(api):
    transport, _, _ = api
    code, stdout, stderr = run(["ls", "強化学習"], transport)
    assert code == 0
    assert "a1b2c3d5" in stdout and "Double Q-learning" in stdout and "未翻訳" in stdout
    assert "1 件" in stderr


def test_folder_create_rename_delete_and_restore(api):
    transport, lib, _ = api
    assert run(["folder", "create", "新規"], transport)[0] == 0
    assert "新規" in lib.collections()
    code, _, stderr = run(["folder", "create", "新規"], transport)
    assert code == 1 and "既に" in stderr
    assert run(["folder", "rename", "新規", "改名"], transport)[0] == 0
    assert "改名" in lib.collections() and "新規" not in lib.collections()
    code, stdout, _ = run(["folder", "list", "--json"], transport)
    listing = json.loads(stdout)
    assert {"name": "強化学習", "papers": 1} in listing["folders"] and listing["unfiled"] == 2
    # Deleting asks unless --yes; without a terminal it refuses.
    code, _, stderr = run(["folder", "delete", "強化学習"], transport)
    assert code == 1 and "--yes" in stderr and "強化学習" in lib.collections()
    code, stdout, _ = run(["folder", "delete", "強化学習", "--yes", "--json"], transport)
    assert code == 0
    deleted = json.loads(stdout)
    assert deleted["moved"] == [RL2] and deleted["restore_command"] == f"papeer-cli folder restore {deleted['undo_token']}"
    assert folders_of(lib)[RL2] == "" and "強化学習" not in lib.collections()
    code, stdout, _ = run(["folder", "restore", deleted["undo_token"]], transport)
    assert code == 0 and folders_of(lib)[RL2] == "強化学習"
    code, _, stderr = run(["folder", "restore", "unknown"], transport)
    assert code == 1 and "復元できる" in stderr


def test_folder_delete_asks_on_a_terminal(api):
    transport, lib, _ = api
    code, _, stderr = run(["folder", "delete", "制御"], transport, interactive=True, stdin="n\n")
    assert code == 1 and "制御" in lib.collections() and "[y/N]" in stderr
    code, stdout, _ = run(["folder", "delete", "制御"], transport, interactive=True, stdin="y\n")
    assert code == 0 and "folder restore" in stdout
    assert folders_of(lib)[CONTROL] == ""


# --- mv ---

def test_mv_resolves_prefixes_and_moves_all_papers_in_one_operation(api):
    transport, lib, _ = api
    code, stdout, stderr = run(["mv", "a1b2c3d4", "ffeedd", "--to", "整理 / 新", "--json"], transport)
    assert code == 0, stderr
    data = json.loads(stdout)
    assert data["moved"] == 2 and data["created"] == ["整理", "整理 / 新"]
    assert folders_of(lib)[RL] == "整理 / 新" and folders_of(lib)[VISION] == "整理 / 新"
    # Back to unfiled with --to "".
    assert run(["mv", RL, "--to", ""], transport)[0] == 0
    assert folders_of(lib)[RL] == ""
    # Already there: nothing to move, success.
    code, stdout, _ = run(["mv", RL, "--to", ""], transport)
    assert code == 0 and "移動する論文はありません" in stdout


def test_mv_ambiguous_short_and_unknown_ids(api):
    transport, lib, _ = api
    code, _, stderr = run(["mv", "a1b2c3d", "--to", "x"], transport)
    assert code == 1 and "複数" in stderr and RL[:12] in stderr and "Double Q-learning" in stderr
    code, _, stderr = run(["mv", "a1b2", "--to", "x"], transport)
    assert code == 2 and "6 文字以上" in stderr
    code, _, stderr = run(["mv", "999999", "--to", "x"], transport)
    assert code == 1 and "見つかりません" in stderr
    assert folders_of(lib)[RL] == ""  # Nothing moved by any of them.


def test_mv_tells_a_changed_classification_in_japanese():
    transport = FakeTransport({
        ("GET", "/api/papers"): [{"id": RL, "title": "T", "collection_name": ""}],
        ("POST", "/api/collections/apply-moves"): fail(409, "論文のフォルダーが案を作った後に変更されたため、適用できません。", "collection_changed"),
    })
    code, _, stderr = run(["mv", RL, "--to", "x"], transport)
    assert code == 1 and "分類が変わりました。もう一度実行してください。" in stderr
    assert transport.bodies("POST", "/api/collections/apply-moves") == [
        {"moves": [{"paper_id": RL, "to": "x"}], "expected": {RL: ""}}]


# --- organize ---

class OrganizeProvider:
    sent: list = []

    def __init__(self, settings=None, cancel=None, api_key=None):
        pass

    def generate(self, instruction, data, schema=None):
        OrganizeProvider.sent.append(json.loads(data))
        return json.dumps({"folders": [{"name": "新分野", "reason": "RL の論文"}],
                           "moves": [{"key": "P1", "folder": "新分野"}], "message": "案です。"})


@pytest.fixture
def organizing(api, monkeypatch):
    OrganizeProvider.sent = []
    monkeypatch.setattr("sidecar.deps.create_provider", OrganizeProvider)
    return api


def test_organize_dry_run_prints_the_proposal_and_moves_nothing(organizing):
    transport, lib, _ = organizing
    before = folders_of(lib)
    code, stdout, stderr = run(["organize", "--instruction", "分野別", "--dry-run"], transport)
    assert code == 0, stderr
    assert "移動元 → 移動先" in stdout and "未分類 → 新分野" in stdout and "[新規] 新分野" in stdout
    assert "AI のコメント: 案です。" in stdout
    assert OrganizeProvider.sent[0]["instruction"] == "分野別"
    assert {paper["current_folder"] for paper in OrganizeProvider.sent[0]["papers"]} == {""}  # Unfiled by default.
    assert folders_of(lib) == before


def test_organize_without_a_terminal_and_without_yes_prints_and_exits_1(organizing):
    transport, lib, _ = organizing
    before = folders_of(lib)
    code, stdout, stderr = run(["organize"], transport)
    assert code == 1 and "移動元 → 移動先" in stdout and "--yes" in stderr
    assert folders_of(lib) == before


def test_organize_yes_applies_and_save_writes_the_proposal(organizing, tmp_path):
    transport, lib, _ = organizing
    saved = tmp_path / "proposal.json"
    code, stdout, stderr = run(["organize", "--yes", "--save", str(saved), "--json"], transport)
    assert code == 0, stderr
    data = json.loads(stdout)
    assert data["applied"] == {"moved": 1, "created": ["新分野"]}
    moved = data["proposal"]["moves"][0]["paper_id"]
    assert folders_of(lib)[moved] == "新分野"
    assert json.loads(saved.read_text("utf-8"))["moves"][0]["paper_id"] == moved
    # The saved proposal goes back as `previous` with a feedback (revising).
    code, _, stderr = run(["organize", "--dry-run", "--previous", str(saved), "--feedback", "もっと粗く"], transport)
    assert code == 0, stderr
    assert OrganizeProvider.sent[-1]["feedback"] == "もっと粗く" and "previous_proposal" in OrganizeProvider.sent[-1]


def test_organize_asks_on_a_terminal(organizing):
    transport, lib, _ = organizing
    before = folders_of(lib)
    code, stdout, stderr = run(["organize"], transport, interactive=True, stdin="n\n")
    assert code == 1 and "この内容で適用しますか? [y/N]" in stderr and "未分類 → 新分野" in stdout
    assert folders_of(lib) == before
    code, stdout, _ = run(["organize"], transport, interactive=True, stdin="y\n")
    assert code == 0 and "1 件を移動しました。" in stdout
    assert "新分野" in folders_of(lib).values()


def test_organize_papers_and_folder_reach_the_request(organizing):
    transport, lib, _ = organizing
    code, _, stderr = run(["organize", "強化学習", "--papers", "a1b2c3d5", "ffeedd00", "--dry-run"], transport)
    assert code == 0, stderr
    assert {paper["current_folder"] for paper in OrganizeProvider.sent[0]["papers"]} == {"強化学習", ""}
    assert OrganizeProvider.sent[0]["base_folder"] == "強化学習"


def test_organize_apply_conflict_is_reported():
    proposal = {"source": "", "instruction": "", "folders": [], "message": "",
                "moves": [{"paper_id": RL, "title": "T", "from": "", "to": "x"}], "expected": {RL: ""}}
    transport = FakeTransport({
        ("POST", "/api/collections/organize"): {"job_id": "j1"},
        ("GET", "/api/jobs/j1"): job_state("succeeded", result=proposal, kind="library-organize"),
        ("POST", "/api/collections/apply-moves"): fail(409, "変更されました", "collection_changed"),
    })
    code, _, stderr = run(["organize", "--yes"], transport)
    assert code == 1 and "分類が変わりました" in stderr
    assert transport.bodies("POST", "/api/collections/apply-moves") == [
        {"moves": [{"paper_id": RL, "to": "x"}], "expected": {RL: ""}}]


# --- translate ---

def translate_routes(extra: dict | None = None) -> dict:
    result = {"pages": 5, "translated_pages": [1, 2, 3, 5], "skipped_pages": [4], "page_errors": {"4": "失敗"},
              "model": "m1", "usage": {"input_tokens": 100, "output_tokens": 50, "cost_usd": 0.01}}
    return {
        ("GET", "/api/papers"): [{"id": RL, "title": "Deep Q-learning", "collection_name": ""}],
        ("POST", f"/api/papers/{RL}/translate"): {"job_id": "j1"},
        ("GET", "/api/jobs/j1"): job_state("succeeded", result=result, kind="translate"),
        **(extra or {}),
    }


def test_translate_sends_the_request_and_prints_the_outcome():
    transport = FakeTransport(translate_routes())
    code, stdout, stderr = run(["translate", "a1b2c3", "--pages", "1-3,5", "--model", "m1", "--effort", "low"], transport)
    assert code == 0, stderr
    assert transport.bodies("POST", f"/api/papers/{RL}/translate") == [{"pages": "1-3,5", "model": "m1", "effort": "low"}]
    assert "1-3,5（4 ページ）" in stdout and "元のままのページ: 4" in stdout and "p.4: 失敗" in stdout
    assert "入力 100" in stdout


def test_translate_without_options_sends_an_empty_body_and_no_wait_stops_early():
    transport = FakeTransport(translate_routes())
    code, stdout, _ = run(["translate", RL, "--no-wait", "--json"], transport)
    assert code == 0 and json.loads(stdout) == {"job_id": "j1", "paper_id": RL}
    assert transport.bodies("POST", f"/api/papers/{RL}/translate") == [{}]
    assert "/api/jobs/j1" not in transport.paths()


def test_translate_plan_only_reads_the_plan():
    plan = {"model": "m1", "selected_pages": [1, 2, 3], "reusable_pages": [1], "pending_pages": [2, 3],
            "retranslated_pages": [], "previous_models": ["old"], "needs_ai": True}
    transport = FakeTransport(translate_routes({("GET", f"/api/papers/{RL}/translation-plan"): plan}))
    code, stdout, _ = run(["translate", RL, "--plan", "--pages", "1-3", "--model", "m1"], transport)
    assert code == 0
    assert transport.calls[-1]["query"] == {"pages": "1-3", "model": "m1"}
    assert "AI に送る: 2-3" in stdout and "AI を使います。" in stdout
    assert not any(c["method"] == "POST" for c in transport.calls)


def test_translate_shows_the_apis_text_when_ai_settings_are_missing():
    message = "AIの接続が設定されていません。設定でプロバイダーを選んでください。"
    transport = FakeTransport(translate_routes({("POST", f"/api/papers/{RL}/translate"): fail(400, message)}))
    code, stdout, stderr = run(["translate", RL], transport)
    assert code == 1 and stdout == "" and message in stderr


def test_a_failed_job_is_exit_1_with_its_error():
    transport = FakeTransport(translate_routes({
        ("GET", "/api/jobs/j1"): job_state("failed", error="Codex接続に失敗しました。", kind="translate")}))
    code, _, stderr = run(["translate", RL], transport)
    assert code == 1 and "Codex接続に失敗しました。" in stderr


# --- job and status ---

def test_job_list_show_and_cancel():
    running = job_state("running", "翻訳中 3/10", 3, 10, kind="translate")
    transport = FakeTransport({
        ("GET", "/api/jobs"): [running],
        ("GET", "/api/jobs/j1"): running,
        ("POST", "/api/jobs/j1/cancel"): {"status": "cancelling"},
    })
    code, stdout, _ = run(["job", "list"], transport)
    assert code == 0 and "translate" in stdout and "3/10" in stdout
    code, stdout, _ = run(["job", "show", "j1", "--json"], transport)
    assert code == 0 and json.loads(stdout)["job_id"] == "j1"
    assert run(["job", "cancel", "j1"], transport)[0] == 0
    assert transport.bodies("POST", "/api/jobs/j1/cancel") == [{}]


def test_job_show_wait_follows_the_job_and_exits_1_when_it_failed():
    transport = FakeTransport({
        ("GET", "/api/jobs/j1"): Seq([job_state("running", "x", 1, 2), job_state("running", "x", 1, 2),
                                      job_state("failed", error="だめでした")]),
    })
    code, stdout, _ = run(["job", "show", "j1", "--wait"], transport)
    assert code == 1 and "だめでした" in stdout


def test_job_show_wait_exits_1_unless_the_job_succeeded_even_when_it_had_ended_already():
    for status, error, expected in (("failed", "だめでした", 1), ("cancelled", "中止しました。", 1), ("succeeded", None, 0)):
        transport = FakeTransport({("GET", "/api/jobs/j1"): job_state(status, error=error)})
        assert run(["job", "show", "j1", "--wait"], transport)[0] == expected, status
        # Without --wait the exit code only says the question was answered.
        assert run(["job", "show", "j1"], transport)[0] == 0


def test_ctrl_c_while_waiting_for_somebody_elses_job_does_not_cancel_it():
    # The first request (find_job) finds it running; the next one (the first poll) is interrupted.
    transport = FakeTransport({
        ("GET", "/api/jobs/j1"): Seq([job_state("running", "処理中", 1, 5), KeyboardInterrupt()]),
        ("POST", "/api/jobs/j1/cancel"): {"status": "cancelling"},
    })
    code, _, stderr = run(["job", "show", "j1", "--wait"], transport)
    assert code == 130 and "ジョブはそのまま続きます" in stderr
    assert transport.bodies("POST", "/api/jobs/j1/cancel") == []


def test_run_job_without_cancel_on_interrupt_only_stops_waiting():
    transport = FakeTransport({("GET", "/api/jobs/j1"): job_state("running", "処理中"),
                               ("POST", "/api/jobs/j1/cancel"): {"status": "cancelling"}})

    def interrupt(_seconds):
        raise KeyboardInterrupt

    with pytest.raises(Interrupted) as raised:
        run_job(make_session(transport), lambda session: "j1", out=Output(io.StringIO(), io.StringIO()),
                sleep=interrupt, cancel_on_interrupt=False)
    assert raised.value.exit_code == 130 and transport.bodies("POST", "/api/jobs/j1/cancel") == []


@pytest.mark.parametrize("command", [["job", "list"], ["job", "show", "j1"], ["job", "cancel", "j1"]])
def test_job_commands_do_not_start_a_sidecar(tmp_path, monkeypatch, command):
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "empty"))

    def boom(*args, **kwargs):
        raise AssertionError("a sidecar was started")

    code, _, stderr = run(command, connector=Connector(Options(), popen=boom))
    assert code == 3 and "Papeer が起動していません。" in stderr


def test_status_reports_the_connection_and_jobs():
    transport = FakeTransport({
        ("GET", "/api/instance"): {"pid": 42, "launcher": "cli", "data_dir": "D:/lib", "port": 5000,
                                   "version": "0.2.0", "idle_exit": 10.0},
        ("GET", "/api/jobs"): [],
    })
    code, stdout, _ = run(["status"], transport)
    assert code == 0 and "ヘッドレス" in stdout and "5000" in stdout and "pid 42" in stdout and "なし" in stdout


def test_status_does_not_start_a_sidecar(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "empty"))

    def boom(*args, **kwargs):
        raise AssertionError("a sidecar was started")

    code, stdout, _ = run(["status", "--json"], connector=Connector(Options(), popen=boom))
    assert code == 3 and json.loads(stdout) == {"running": False}


# --- run_job ---

def make_session(transport) -> Session:
    return Session(transport, Target(base_url="x", pid=1))


def submit_j1(session: Session) -> str:
    return session.post("/api/x")["job_id"]


def test_progress_is_one_redrawn_line_on_a_terminal():
    states = Seq([job_state("running", "処理中", 5, 10), job_state("running", "処理中", 10, 10), job_state("succeeded")])
    transport = FakeTransport({("POST", "/api/x"): {"job_id": "j1"}, ("GET", "/api/jobs/j1"): states})
    out = Output(io.StringIO(), io.StringIO(), progress_tty=True)
    done = run_job(make_session(transport), submit_j1, out=out, sleep=lambda _s: None)
    assert done.succeeded
    stderr = out.stderr.getvalue()  # type: ignore[attr-defined]
    assert "[#####-----] 5/10 処理中" in stderr and "[##########] 10/10 処理中" in stderr
    assert stderr.count("\n") == 0 and stderr.endswith("\r")  # Redrawn in place, cleared at the end.
    assert out.stdout.getvalue() == ""  # type: ignore[attr-defined]


def test_progress_without_a_terminal_is_a_line_per_change_on_stderr():
    states = Seq([job_state("running", "a"), job_state("running", "a"), job_state("running", "b"), job_state("succeeded")])
    transport = FakeTransport({("POST", "/api/x"): {"job_id": "j1"}, ("GET", "/api/jobs/j1"): states})
    out = Output(io.StringIO(), io.StringIO())
    run_job(make_session(transport), submit_j1, out=out, sleep=lambda _s: None)
    assert out.stderr.getvalue() == "a\nb\n"  # type: ignore[attr-defined]


def test_json_output_is_only_the_document_and_quiet_silences_progress(tmp_path, monkeypatch):
    (tmp_path / "a.pdf").write_bytes(b"%PDF")
    monkeypatch.chdir(tmp_path)
    routes = import_routes([])
    routes[("GET", "/api/jobs/j1")] = Seq([job_state("running", "PDFを追加 1/1: a.pdf", 1, 1), routes[("GET", "/api/jobs/j1")]])
    monkeypatch.setattr(jobs, "POLL_INTERVAL", 0.001)
    code, stdout, stderr = run(["add", "a.pdf", "--json"], FakeTransport(routes))
    assert code == 0
    assert json.loads(stdout)["added"] == 1  # The whole of stdout is one JSON document.
    assert "PDFを追加 1/1: a.pdf" in stderr
    routes = import_routes([])
    routes[("GET", "/api/jobs/j1")] = Seq([job_state("running", "PDFを追加 1/1: a.pdf", 1, 1), routes[("GET", "/api/jobs/j1")]])
    code, stdout, stderr = run(["add", "a.pdf", "--json", "--quiet"], FakeTransport(routes))
    assert code == 0 and json.loads(stdout)["added"] == 1 and stderr == ""


def test_ctrl_c_cancels_the_job_and_exits_130():
    transport = FakeTransport({
        ("POST", "/api/x"): {"job_id": "j1"},
        ("GET", "/api/jobs/j1"): Seq([job_state("running", "処理中", 1, 5), job_state("running", "止めています"),
                                      job_state("cancelled", error="中止しました。")]),
        ("POST", "/api/jobs/j1/cancel"): {"status": "cancelling"},
    })
    interrupts = iter([True])

    def sleep(_seconds):
        if next(interrupts, False):
            raise KeyboardInterrupt

    out = Output(io.StringIO(), io.StringIO())
    with pytest.raises(Interrupted) as raised:
        run_job(make_session(transport), submit_j1, out=out, sleep=sleep)
    assert raised.value.exit_code == 130
    assert transport.bodies("POST", "/api/jobs/j1/cancel") == [{}]
    assert "中止しています…（もう一度 Ctrl+C で強制終了）" in out.stderr.getvalue()  # type: ignore[attr-defined]


def test_a_second_ctrl_c_exits_at_once_through_main():
    def interrupted(body, query):
        return KeyboardInterrupt()

    transport = FakeTransport({
        ("GET", "/api/papers"): [{"id": RL, "title": "T", "collection_name": ""}],
        ("POST", f"/api/papers/{RL}/translate"): {"job_id": "j1"},
        ("GET", "/api/jobs/j1"): interrupted,
        ("POST", "/api/jobs/j1/cancel"): {"status": "cancelling"},
    })
    code, _, stderr = run(["translate", RL], transport)
    assert code == 130 and "強制終了" in stderr
    assert len(transport.bodies("POST", "/api/jobs/j1/cancel")) == 1


def test_ctrl_c_gives_up_waiting_for_a_job_that_will_not_stop():
    transport = FakeTransport({
        ("POST", "/api/x"): {"job_id": "j1"},
        ("GET", "/api/jobs/j1"): job_state("running", "止まりません"),
        ("POST", "/api/jobs/j1/cancel"): {"status": "cancelling"},
    })
    clock = [0.0]
    raised_once = [False]

    def sleep(seconds):
        clock[0] += seconds
        if not raised_once[0]:
            raised_once[0] = True
            raise KeyboardInterrupt

    with pytest.raises(Interrupted) as raised:
        run_job(make_session(transport), submit_j1, out=Output(io.StringIO(), io.StringIO()), sleep=sleep,
                clock=lambda: clock[0], poll_interval=1.0, cancel_wait=30.0)
    assert "まだ止まっていません" in raised.value.message and raised.value.exit_code == 130
    assert 30 <= clock[0] <= 40


class FakeConnector:
    """connect() hands out the given transports in turn; a session is alive while its pid is `alive_pid`."""

    def __init__(self, *transports) -> None:
        self.transports = list(transports)
        self.connects = 0
        self.alive_pid = 1
        self.patience: list[float] = []

    def connect(self, patience: float = 0.0, spawn: bool = True) -> Session:
        self.patience.append(patience)
        transport = self.transports.pop(0)
        self.connects += 1
        return Session(transport, Target(base_url="x", pid=self.connects, launcher="cli"), self)

    def alive(self, target: Target) -> bool:
        return target.pid == self.alive_pid


def gone(connector: FakeConnector, error: Any):
    """A route that, when asked, makes the first sidecar a dead one (the second is the one serving) and fails."""
    def route(body, query):
        connector.alive_pid = 2
        return error
    return route


def import_ok(job_id: str) -> dict:
    return {("GET", "/api/papers"): [], ("POST", "/api/papers/import"): {"job_id": job_id},
            ("GET", f"/api/jobs/{job_id}"): job_state("succeeded", job_id=job_id, result={
                "paper_ids": [], "added": 0, "added_ids": [], "needs_ocr": [], "metadata_failures": []})}


@pytest.fixture
def a_pdf(tmp_path, monkeypatch):
    (tmp_path / "a.pdf").write_bytes(b"%PDF")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(jobs, "POLL_INTERVAL", 0.001)
    monkeypatch.setattr(jobs, "GONE_GRACE", 0.01)


def test_a_dropped_connection_to_a_gone_sidecar_starts_the_work_again_on_the_next(a_pdf):
    connector = FakeConnector(None, None)
    first = FakeTransport({
        ("POST", "/api/papers/import"): {"job_id": "old"},
        ("GET", "/api/jobs/old"): gone(connector, ConnectionLost("reset")),
    })
    second = FakeTransport(import_ok("new"))
    connector.transports = [first, second]
    code, stdout, stderr = run(["add", "a.pdf", "--json"], connector=connector)
    assert code == 0, stderr
    assert connector.connects == 2
    assert first.bodies("POST", "/api/papers/import") and second.bodies("POST", "/api/papers/import")
    assert "接続し直して同じ処理をやり直します" in stderr


def test_a_job_cancelled_by_a_handover_is_started_again_but_a_cancel_in_the_window_is_not(a_pdf):
    connector = FakeConnector()
    first = FakeTransport({
        ("POST", "/api/papers/import"): {"job_id": "old"},
        ("GET", "/api/jobs/old"): gone(connector, job_state("cancelled", job_id="old", error="追加を中止しました。")),
    })
    connector.transports = [first, FakeTransport(import_ok("new"))]
    code, _, stderr = run(["add", "a.pdf"], connector=connector)
    assert code == 0, stderr
    # The sidecar is still there: somebody cancelled in the window. Exit 1, no second request.
    connector = FakeConnector()
    only = FakeTransport({
        ("POST", "/api/papers/import"): {"job_id": "old"},
        ("GET", "/api/jobs/old"): job_state("cancelled", job_id="old", error="追加を中止しました。"),
    })
    connector.transports = [only]
    code, _, stderr = run(["add", "a.pdf"], connector=connector)
    assert code == 1 and "追加を中止しました。" in stderr and connector.connects == 1


def test_no_resume_reports_the_loss_and_reconnects_are_bounded(a_pdf):
    connector = FakeConnector()
    first = FakeTransport({
        ("POST", "/api/papers/import"): {"job_id": "old"},
        ("GET", "/api/jobs/old"): gone(connector, ConnectionLost("reset")),
    })
    connector.transports = [first]
    code, _, stderr = run(["add", "a.pdf", "--no-resume"], connector=connector)
    assert code == 1 and "sidecar が終了しました" in stderr and connector.connects == 1
    # Every sidecar dies under the job: after two more starts the CLI gives up.
    connector = FakeConnector()

    def dying(pid):
        def route(body, query):
            connector.alive_pid = pid + 1
            return ConnectionLost("reset")
        return FakeTransport({("POST", "/api/papers/import"): {"job_id": f"j{pid}"},
                              ("GET", f"/api/jobs/j{pid}"): route})

    connector.transports = [dying(1), dying(2), dying(3), dying(4)]
    code, _, stderr = run(["add", "a.pdf"], connector=connector)
    assert code == 1 and connector.connects == 3 and "2回まで" in stderr


def test_a_connection_that_fails_while_the_sidecar_is_alive_is_an_error_after_a_while(a_pdf):
    connector = FakeConnector()
    transport = FakeTransport({
        ("POST", "/api/papers/import"): {"job_id": "j1"},
        ("GET", "/api/jobs/j1"): ConnectionLost("timed out"),
    })
    connector.transports = [transport]
    code, _, stderr = run(["add", "a.pdf"], connector=connector)
    assert code == 1 and "timed out" in stderr and connector.connects == 1
    assert len(transport.paths("GET")) == jobs.MAX_SILENT_POLLS  # Polls only, each one a try.


def test_a_request_is_sent_again_on_the_new_sidecar_once_the_old_is_gone_or_closing():
    connector = FakeConnector()
    old = FakeTransport({("GET", "/api/jobs"): gone(connector, ConnectionLost("refused"))})
    new = FakeTransport({("GET", "/api/jobs"): []})
    connector.transports = [old, new]
    session = connector.connect()
    assert session.get("/api/jobs") == [] and connector.connects == 2
    # 503 sidecar_closing is reconnected whether or not discovery has caught up.
    connector = FakeConnector()
    closing = FakeTransport({("GET", "/api/jobs"): fail(503, "終了処理に入っています", "sidecar_closing")})
    connector.transports = [closing, FakeTransport({("GET", "/api/jobs"): []})]
    assert connector.connect().get("/api/jobs") == [] and connector.connects == 2
    # A sidecar that is alive but did not answer is not replaced.
    connector = FakeConnector()
    connector.transports = [FakeTransport({("GET", "/api/jobs"): ConnectionLost("timed out")})]
    with pytest.raises(ConnectionLost):
        connector.connect().get("/api/jobs")
    assert connector.connects == 1


# --- Exit codes and messages ---

@pytest.mark.parametrize("value", ["nan", "inf", "-inf", "0", "-1"])
def test_idle_must_be_a_finite_positive_number(capsys, value):
    assert main(["--idle", value, "ls"]) == 2
    assert "--idle" in capsys.readouterr().err


def test_usage_errors_exit_2(capsys):
    assert main(["mv", RL]) == 2
    assert "--to" in capsys.readouterr().err
    assert main(["nosuchcommand"]) == 2
    assert main([]) == 2
    assert main(["--help"]) == 0


def test_no_sidecar_with_no_spawn_is_exit_3(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "empty"))
    code, stdout, stderr = run(["--no-spawn", "ls"], connector=Connector(Options(no_spawn=True)))
    assert (code, stdout) == (3, "") and "Papeer が起動していません。" in stderr


def test_api_errors_print_one_line_with_the_code():
    transport = FakeTransport({("GET", "/api/papers"): fail(409, "同期・バックアップ・復元が終わるまでお待ちください。", "library_busy")})
    code, stdout, stderr = run(["ls"], transport)
    assert code == 1 and stdout == ""
    assert stderr == "エラー: 同期・バックアップ・復元が終わるまでお待ちください。（code: library_busy）\n"


def test_a_422_is_described():
    body = json.dumps({"detail": [{"loc": ["body", "moves"], "msg": "List should have at least 1 item", "type": "x"}]})
    transport = FakeTransport({("GET", "/api/papers"): Reply(422, body.encode())})
    code, _, stderr = run(["ls"], transport)
    assert code == 1 and "moves: List should have at least 1 item" in stderr


def test_global_options_work_before_and_after_the_command():
    transport = FakeTransport({("GET", "/api/papers"): []})
    assert run(["--json", "ls"], transport)[1].strip() == "[]"
    assert run(["ls", "--json"], transport)[1].strip() == "[]"


# --- Connector ---

def lib_root(tmp_path: Path) -> Path:
    return (tmp_path / "lib").resolve()


def write_file(root: Path, *, token: str = "tok", port: int = 4242, launcher: str = "app", pid: int | None = None) -> None:
    discovery.write_instance(root, discovery.InstanceInfo(
        pid=os.getpid() if pid is None else pid, port=port, token=token, launcher=launcher, data_dir=str(root),
        version="0.2.0", started_at=0.0))


def factory_for(answers: dict[int, Any]):
    """transport_factory whose sidecars answer GET /api/instance by port: a dict, a Reply, or nothing (refused)."""
    def make(base_url: str, token: str | None):
        port = int(base_url.rsplit(":", 1)[1])

        class Transport:
            def request(self, method, path, *, body=None, query=None, timeout=30.0):
                answer = answers.get(port)
                if answer is None:
                    raise ConnectionLost("refused")
                return answer if isinstance(answer, Reply) else ok(answer)

        return Transport()
    return make


def instance_answer(root: Path, **changes) -> dict:
    return {"pid": os.getpid(), "launcher": "app", "data_dir": str(root), "port": 4242, "version": "0.2.0",
            "idle_exit": None, **changes}


def test_discovery_accepts_only_a_file_the_sidecar_bears_out(tmp_path):
    root = lib_root(tmp_path)
    options = Options(data_dir=str(root), no_spawn=True)
    assert Connector(options).find() is None  # No file.
    write_file(root)
    cases = [
        (None, False),  # Nobody listens (a killed sidecar's file).
        (instance_answer(root, pid=os.getpid() + 1), False),  # Another program on that port.
        (instance_answer(root, data_dir=str(tmp_path / "other")), False),  # Another library.
        (fail(401, "認証が必要です"), False),  # Another token.
        (fail(503, "終了処理に入っています", "sidecar_closing"), False),
        (instance_answer(root), True),
    ]
    for answer, usable in cases:
        found = Connector(options, transport_factory=factory_for({4242: answer})).find()
        assert (found is not None) is usable, answer
    found = Connector(options, transport_factory=factory_for({4242: instance_answer(root)})).find()
    assert found is not None
    assert (found.pid, found.port, found.launcher, found.token, found.version) == (os.getpid(), 4242, "app", "tok", "0.2.0")
    # A file naming a pid that is certainly gone is not even asked.
    write_file(root, pid=2**31 - 2)
    asked = []

    def spy(base_url, token):
        asked.append(base_url)
        return factory_for({4242: instance_answer(root)})(base_url, token)

    assert Connector(options, transport_factory=spy).find() is None and asked == []


def test_explicit_url_and_token_are_used_as_given(tmp_path, monkeypatch):
    seen = []

    def make(base_url, token):
        seen.append((base_url, token))
        return FakeTransport({("GET", "/api/instance"): {"pid": 9, "launcher": "dev", "data_dir": "d", "port": 8000,
                                                         "version": "v", "idle_exit": None}})

    monkeypatch.setenv("PAPEER_TOKEN", "from-env")
    session = Connector(Options(url="http://127.0.0.1:8000/", data_dir=str(tmp_path)), transport_factory=make).connect()
    assert seen == [("http://127.0.0.1:8000", "from-env")] and session.target.launcher == "dev"
    session = Connector(Options(url="http://h:1", token="given"), transport_factory=make).connect()
    assert seen[-1] == ("http://h:1", "given")
    monkeypatch.setenv("PAPEER_CLI_URL", "http://env:2")
    Connector(Options(), transport_factory=make).connect()
    assert seen[-1] == ("http://env:2", "from-env")

    def refused(base_url, token):
        return FakeTransport({("GET", "/api/instance"): ConnectionLost("refused")})

    with pytest.raises(CliError) as raised:
        Connector(Options(url="http://127.0.0.1:1"), transport_factory=refused).connect()
    assert raised.value.exit_code == 3


class FakeProcess:
    def __init__(self, codes: list[int | None]) -> None:
        self.codes = list(codes)
        self.killed = False

    def poll(self):
        return self.codes.pop(0) if len(self.codes) > 1 else self.codes[0]

    def kill(self) -> None:
        self.killed = True


class Spawner:
    """A popen that records what it was given and plays the sidecar: writes the discovery file with the token it got."""

    def __init__(self, root: Path, *, behave: str = "listen", codes: list[int | None] | None = None) -> None:
        self.root = root
        self.behave = behave
        self.calls: list[dict[str, Any]] = []
        self.process = FakeProcess(codes if codes is not None else [None])

    def __call__(self, command, **kwargs):
        self.calls.append({"command": command, **kwargs})
        if self.behave == "listen":
            write_file(self.root, token=kwargs["env"]["PAPEER_TOKEN"], launcher="cli")
        return self.process


def test_a_headless_sidecar_is_started_with_its_token_and_found_by_it(tmp_path, monkeypatch):
    root = lib_root(tmp_path)
    monkeypatch.setenv("PAPEER_WATCH_STDIN", "1")
    monkeypatch.setenv("PAPEER_PORT", "9999")
    spawner = Spawner(root)
    notes: list[str] = []
    connector = Connector(Options(data_dir=str(root), idle=7), transport_factory=factory_for({4242: instance_answer(root, launcher="cli")}),
                          popen=spawner, sleep=lambda _s: None, notify=notes.append)
    session = connector.connect()
    assert session.target.spawned and session.target.launcher == "cli" and session.target.port == 4242
    (call,) = spawner.calls
    env = call["env"]
    assert call["command"][-2:] == ["-m", "sidecar"] and call["cwd"] == str(ROOT)
    assert (env["PAPEER_PORT"], env["PAPEER_LAUNCHER"], env["PAPEER_IDLE_EXIT"], env["PAPEER_DATA_DIR"]) == ("0", "cli", "7", str(root))
    assert len(env["PAPEER_TOKEN"]) == 64 and "PAPEER_WATCH_STDIN" not in env
    assert (call["stdin"], call["stdout"], call["stderr"]) == (subprocess.DEVNULL,) * 3
    assert ("creationflags" in call) is (os.name == "nt") and ("start_new_session" in call) is (os.name != "nt")
    assert notes == ["ヘッドレスの Papeer を起動しています…"]


def test_a_file_with_another_token_is_not_taken_for_the_started_sidecar(tmp_path):
    # A stale file of a dead sidecar, and a spawn that never listens: the wait ends in the timeout.
    root = lib_root(tmp_path)
    clock = [0.0]

    def sleep(seconds):
        clock[0] += seconds

    spawner = Spawner(root, behave="silent")
    write_file(root, token="someone-else")
    connector = Connector(Options(data_dir=str(root)), transport_factory=factory_for({4242: None}), popen=spawner,
                          clock=lambda: clock[0], sleep=sleep)
    with pytest.raises(CliError) as raised:
        connector.connect()
    assert raised.value.exit_code == 3 and "60 秒" in raised.value.message and "sidecar.log" in raised.value.message
    assert spawner.process.killed


def test_a_child_that_lost_the_library_goes_back_to_discovery(tmp_path):
    root = lib_root(tmp_path)
    spawner = Spawner(root, behave="silent", codes=[4])
    slept = []

    def sleep(seconds):
        slept.append(seconds)
        write_file(root, token="the-window", launcher="app")  # The window's sidecar finishes starting.

    connector = Connector(Options(data_dir=str(root)), transport_factory=factory_for({4242: instance_answer(root)}),
                          popen=spawner, sleep=sleep)
    session = connector.connect()
    assert len(spawner.calls) == 1 and not session.target.spawned and session.target.launcher == "app"


def test_a_child_that_fails_for_another_reason_is_an_error_naming_the_log(tmp_path):
    root = lib_root(tmp_path)
    spawner = Spawner(root, behave="silent", codes=[1])
    connector = Connector(Options(data_dir=str(root)), transport_factory=factory_for({}), popen=spawner,
                          sleep=lambda _s: None)
    with pytest.raises(CliError) as raised:
        connector.connect()
    assert raised.value.exit_code == 3 and "終了コード 1" in raised.value.message and "sidecar.log" in raised.value.message


def test_the_child_always_gets_the_absolute_library_folder(tmp_path, monkeypatch):
    # PAPEER_DATA_DIR relative: this process resolves it against its working directory, but the child runs in
    # the repository (or the exe's folder), where the same text would be another library.
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PAPEER_DATA_DIR", "rel/lib")
    root = (tmp_path / "rel" / "lib").resolve()
    spawner = Spawner(root)
    connector = Connector(Options(), transport_factory=factory_for({4242: instance_answer(root, launcher="cli")}),
                          popen=spawner, sleep=lambda _s: None)
    assert connector.connect().target.spawned
    (call,) = spawner.calls
    assert call["env"]["PAPEER_DATA_DIR"] == str(root) and Path(call["env"]["PAPEER_DATA_DIR"]).is_absolute()
    assert call["cwd"] != str(tmp_path)


def test_no_spawn_never_starts_a_process(tmp_path):
    root = lib_root(tmp_path)
    spawner = Spawner(root)
    connector = Connector(Options(data_dir=str(root), no_spawn=True), transport_factory=factory_for({}), popen=spawner)
    with pytest.raises(CliError) as raised:
        connector.connect()
    assert raised.value.exit_code == 3 and raised.value.message == "Papeer が起動していません。" and spawner.calls == []


# --- server stop ---

def test_server_stop_refuses_a_window_and_stops_a_cli_sidecar():
    window = FakeTransport({("GET", "/api/instance"): {"pid": 1, "launcher": "app", "data_dir": "d", "port": 1, "version": "v"}})
    session = Session(window, Target(base_url="x", launcher="app"))
    out = Output(io.StringIO(), io.StringIO())
    code = main(["server", "stop"], transport=window, out=out)
    assert code == 1 and "ウィンドウを閉じてください" in out.stderr.getvalue()  # type: ignore[attr-defined]
    assert session and not any(c["path"] == "/shutdown" for c in window.calls)
    cli = FakeTransport({
        ("GET", "/api/instance"): {"pid": 1, "launcher": "cli", "data_dir": "d", "port": 1, "version": "v"},
        ("POST", "/shutdown"): {"status": "shutting down"},
    })

    class StopConnector(FakeConnector):
        def connect(self, patience=0.0, spawn=True):
            assert spawn is False
            return Session(cli, Target(base_url="x", pid=1, launcher="cli"), self)

        def wait_gone(self, target, seconds):
            return True

    code, stdout, _ = run(["server", "stop", "--json"], connector=StopConnector())
    assert code == 0 and json.loads(stdout)["stopped"] is True and "/shutdown" in cli.paths("POST")


# --- Output ---

def test_table_aligns_wide_characters_and_page_ranges_compact():
    text = table([["日本語", "x"], ["ab", "y"]], ["名前", "値"])
    lines = text.splitlines()
    # The second column starts at the same column on every line: 6 (the widest cell) + the 2-column gap.
    assert [display_width(line[:-1]) for line in lines] == [8, 8, 8]
    assert page_ranges([5, 1, 2, 3, 3, 9]) == "1-3,5,9" and page_ranges([]) == ""


def test_a_pipe_is_written_in_utf8_even_when_the_console_code_page_is_not(monkeypatch):
    out_bytes, err_bytes = io.BytesIO(), io.BytesIO()
    monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(out_bytes, encoding="cp932", newline="\n"))
    monkeypatch.setattr(sys, "stderr", io.TextIOWrapper(err_bytes, encoding="cp932", newline="\n"))
    out = Output.for_process()
    out.emit(None, "論文①")
    out.error("失敗")
    sys.stdout.flush()
    sys.stderr.flush()
    assert out_bytes.getvalue() == "論文①\n".encode("utf-8")
    assert err_bytes.getvalue() == "エラー: 失敗\n".encode("utf-8")


# --- What the CLI imports ---

def test_importing_the_cli_does_not_load_the_apps_heavy_packages():
    code = ("import sys, papeer.cli.main, papeer.cli.connect, papeer.cli.jobs\n"
            "heavy = ('fastapi', 'uvicorn', 'starlette', 'pydantic', 'fitz', 'pymupdf', 'PIL', 'fontTools', "
            "'pypdfium2', 'sidecar', 'httpx', 'anyio', 'winrt')\n"
            "print(sorted(m for m in sys.modules if m.split('.')[0] in heavy))\n"
            "print(sorted(m for m in sys.modules if m.startswith('papeer.') and not m.startswith('papeer.cli')))")
    result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    heavy, papeer_modules = result.stdout.strip().splitlines()
    assert heavy == "[]"
    allowed = {"papeer.core", "papeer.core.instance", "papeer.core.paths", "papeer.core.fileio", "papeer.core.file_lock",
               "papeer.core.collection_paths"}
    assert set(eval(papeer_modules)) <= allowed, papeer_modules
