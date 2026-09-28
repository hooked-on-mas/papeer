"""One rule for how failures reach the frontend (papeer/core/errors.py, sidecar/errors.py), and changes
that must not overlap a job (JobManager.idle)."""
from __future__ import annotations

import json
import logging
import logging.handlers
import threading

from fastapi.testclient import TestClient
import pymupdf
import pytest

from papeer.core import config
from papeer.core.config import Settings, device_settings_path
from papeer.core.errors import Conflict, Invalid, NotFound
from papeer.core.storage import Library
from papeer.providers import Cancelled
from sidecar import app as runtime, deps
from sidecar.errors import job_error_message
from sidecar.jobs import ConcurrencyConflict, JobManager

ORIGIN = "http://tauri.localhost"


@pytest.fixture
def paper_env(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = tmp_path / "paper.pdf"
    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((72, 72), "Error handling")
        pdf.save(source)
    paper, _ = lib.import_pdf(source)
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())
    return lib, paper


def test_errors_read_as_their_message_and_keep_their_older_types():
    missing = NotFound("論文が見つかりません。")
    # A plain KeyError would read "'論文が見つかりません。'", quotes included.
    assert str(missing) == "論文が見つかりません。" and isinstance(missing, KeyError)
    assert isinstance(Invalid("x"), ValueError)
    assert (Invalid("x").status_code, missing.status_code, Conflict("x").status_code) == (400, 404, 409)
    assert issubclass(ConcurrencyConflict, Conflict) and issubclass(deps.LibraryBusy, Conflict)


def test_routes_answer_each_kind_of_failure_with_its_status(paper_env):
    lib, paper = paper_env
    with TestClient(runtime.app) as client:
        missing = client.get("/api/papers/" + "0" * 32)
        assert (missing.status_code, missing.json()) == (404, {"detail": "論文が見つかりません。"})
        # A plain ValueError of the core (an invalid year) is still 400 with its message.
        year = client.patch(f"/api/papers/{paper}", json={"year": "12"})
        assert (year.status_code, year.json()) == (400, {"detail": "出版年は半角数字4桁で入力してください。"})
        empty = client.post("/api/collections", json={"name": " / "})
        assert (empty.status_code, empty.json()["detail"]) == (400, "有効なフォルダー名を入力してください。")
        bibtex = client.post("/api/papers/bibtex", json={"paper_ids": [paper, "f" * 32]})
        assert (bibtex.status_code, bibtex.json()["detail"]) == (404, "論文が見つかりません。")
        assert client.post("/api/jobs/unknown/cancel").json() == {"detail": "実行中のジョブが見つかりません。"}


def test_a_bug_in_a_route_is_logged_and_answered_in_general_words(paper_env, monkeypatch, caplog):
    def broken() -> Library:
        raise KeyError("abc")

    monkeypatch.setattr(deps, "get_library", broken)
    with TestClient(runtime.app) as client, caplog.at_level(logging.ERROR, logger="papeer.sidecar"):
        response = client.get("/api/collections", headers={"Origin": ORIGIN})
    assert response.status_code == 500
    detail = response.json()["detail"]
    assert detail.startswith("予期しないエラーが発生しました（KeyError）") and "abc" not in detail
    # Inside the CORS middleware, so the window can read the answer.
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert any(record.exc_info and "GET /api/collections" in record.getMessage() for record in caplog.records)


def test_a_refused_request_keeps_its_code(paper_env, monkeypatch):
    def busy() -> Library:
        raise deps.LibraryBusy()

    monkeypatch.setattr(deps, "get_library", busy)
    with TestClient(runtime.app) as client:
        response = client.get("/api/collections")
    assert response.status_code == 409
    assert response.json() == {"detail": "同期・バックアップ・復元が終わるまでお待ちください。", "code": deps.LIBRARY_BUSY}


def test_sticky_note_routes_need_the_paper(paper_env):
    lib, paper = paper_env
    gone = "e" * 32
    note = {"page": 1, "side": "original", "quote": "", "anchor_y": .5}
    with TestClient(runtime.app) as client:
        for method, path, body in [("GET", "sticky-notes", None), ("POST", "sticky-notes", note),
                                   ("PATCH", "sticky-notes/1", {"label": "重要"}), ("DELETE", "sticky-notes/1", None)]:
            response = client.request(method, f"/api/papers/{gone}/{path}", json=body)
            assert (response.status_code, response.json()["detail"]) == (404, "論文が見つかりません。"), method
        saved = client.post(f"/api/papers/{paper}/sticky-notes", json=note).json()
        missing = client.patch(f"/api/papers/{paper}/sticky-notes/{saved['id'] + 1}", json={"label": "重要"})
        assert (missing.status_code, missing.json()["detail"]) == (404, "付箋が見つかりません。")
    # A wrong color is invalid (400), not missing (the route used to answer every ValueError here with 404).
    with pytest.raises(ValueError) as error:
        lib.update_bookmark(paper, saved["id"], color="orange")
    assert not isinstance(error.value, KeyError)


def test_job_errors_read_as_messages_and_a_bug_says_so(caplog):
    assert job_error_message(NotFound("論文が見つかりません。"), "translate") == "論文が見つかりません。"
    assert job_error_message(RuntimeError("未ログインです。"), "translate") == "未ログインです。"
    assert job_error_message(OSError(13, "Permission denied"), "backup") == "[Errno 13] Permission denied"
    assert job_error_message(Cancelled("翻訳を中止しました。"), "translate") == "翻訳を中止しました。"
    with caplog.at_level(logging.ERROR, logger="papeer.sidecar"):
        message = job_error_message(KeyError("abc"), "translate")
    assert message.startswith("予期しないエラーが発生しました（KeyError）") and "abc" not in message
    assert caplog.records[-1].exc_info is not None and "translate" in caplog.records[-1].getMessage()


def test_a_failed_job_reports_the_message_not_the_key(caplog):
    manager = JobManager()
    finished = threading.Event()

    def action(cancel, progress, page_ready):
        try:
            return {}["abc"]
        finally:
            finished.set()

    with caplog.at_level(logging.ERROR, logger="papeer.sidecar"):
        job = manager.submit_job("translate", action, paper_id="p")
        assert finished.wait(5)
        assert manager.wait_idle(5)
    assert job.status == "failed" and job.error and job.error.startswith("予期しないエラー") and "'abc'" not in job.error


def _run_until_released(manager: JobManager, paper_id: str | None = None):
    release = threading.Event()
    started = threading.Event()

    def action(cancel, progress, page_ready):
        started.set()
        release.wait(5)

    manager.submit_job("translate", action, paper_id=paper_id)
    assert started.wait(5)
    return release


def test_idle_refuses_while_a_job_runs_and_keeps_jobs_out_until_done():
    manager = JobManager()
    release = _run_until_released(manager, "a")
    with pytest.raises(ConcurrencyConflict, match="終わってから"):
        with manager.idle("実行中の処理が終わってから変更してください。"):
            pass
    # Only that paper's jobs count for a change to one paper.
    with manager.idle("処理中のジョブがあるため削除できません。", "b"):
        with pytest.raises(ConcurrencyConflict, match="終わってから"):
            manager.submit_job("translate", lambda *_: None, paper_id="b")
    release.set()
    assert manager.wait_idle(5)

    with manager.idle("実行中の処理が終わってから変更してください。"):
        # A job that would start between the check and the change is refused instead.
        for paper_id in ("a", None):
            with pytest.raises(ConcurrencyConflict, match="終わってから"):
                manager.submit_job("translate", lambda *_: None, paper_id=paper_id)
    with pytest.raises(RuntimeError), manager.idle("x"):
        raise RuntimeError("the change failed")
    # Released however the change ended.
    manager.submit_job("translate", lambda *_: None, paper_id="a")
    assert manager.wait_idle(5)


def test_idle_routes_answer_409_while_a_job_runs(paper_env):
    lib, paper = paper_env
    release = _run_until_released(deps.job_manager, paper)
    try:
        with TestClient(runtime.app) as client:
            glossary = client.put("/api/glossary", json={"terms": [], "expected_terms": []})
            assert (glossary.status_code, glossary.json()["detail"]) == (409, "実行中の処理が終わってから共通辞書を保存してください。")
            drive = client.put("/api/drive", json={"auto_sync": False})
            assert (drive.status_code, drive.json()["detail"]) == (409, "実行中の処理が終わってから変更してください。")
            deleted = client.delete(f"/api/papers/{paper}")
            assert (deleted.status_code, deleted.json()["detail"]) == (409, "処理中のジョブがあるため削除できません。")
    finally:
        release.set()
        deps.job_manager.wait_idle(5)
    with TestClient(runtime.app) as client:
        assert client.put("/api/glossary", json={"terms": [], "expected_terms": []}).status_code == 200


def test_a_broken_device_file_is_warned_about_once(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(config, "_warned", set())
    path = device_settings_path()
    path.parent.mkdir(parents=True)
    path.write_text("{broken", "utf-8")
    for _ in range(3):
        Settings.load(tmp_path)
    assert capsys.readouterr().err.count("PCごとの設定") == 1
    # Once it reads again, a later break is told again.
    path.write_text(json.dumps({"version": 1, "migrated": True, "provider_options": {}}), "utf-8")
    Settings.load(tmp_path)
    path.write_text("{broken", "utf-8")
    Settings.load(tmp_path)
    assert capsys.readouterr().err.count("PCごとの設定") == 1


def _core_value_errors() -> list[type]:
    """Every ValueError subclass papeer defines (a new one is answered 400 like these)."""
    import importlib
    import pkgutil

    import papeer

    for module in pkgutil.walk_packages(papeer.__path__, "papeer."):
        importlib.import_module(module.name)
    found, pending = [], [ValueError]
    while pending:
        for cls in pending.pop().__subclasses__():
            pending.append(cls)
            if cls.__module__.split(".")[0] == "papeer" and not issubclass(cls, (KeyError, Conflict)):
                found.append(cls)
    return found


def test_the_cores_own_value_errors_are_400_and_others_bugs(caplog):
    from json import JSONDecodeError

    from pydantic import BaseModel, ValidationError

    from sidecar.errors import expected_response

    names = {cls.__name__ for cls in _core_value_errors()}
    assert {"InsufficientSpaceError", "NewerSchemaError", "LibraryMissingError", "RetryLimitExceeded", "Invalid"} <= names
    for cls in _core_value_errors():
        response = expected_response(cls("日本語の説明"))
        assert response is not None and response.status_code == 400, cls
    assert expected_response(ValueError("日本語の説明")).status_code == 400

    class Model(BaseModel):
        value: int

    try:
        Model(value="secret-value")  # type: ignore[arg-type]
    except ValidationError as exc:
        invalid_model = exc
    for exc in (JSONDecodeError("Expecting value", "{", 1), UnicodeDecodeError("utf-8", b"\xff", 0, 1, "bad"), invalid_model):
        assert expected_response(exc) is None, type(exc)
        with caplog.at_level(logging.ERROR, logger="papeer.sidecar"):
            assert job_error_message(exc, "ask").startswith("予期しないエラーが発生しました")
        assert caplog.records[-1].exc_info is not None


def test_a_broken_settings_file_is_a_logged_500_and_the_token_stays_out(paper_env, monkeypatch, caplog):
    lib, _ = paper_env
    (lib.root / "settings.json").write_text("{broken", "utf-8")
    monkeypatch.delenv("PAPEER_DEV_NO_AUTH")
    monkeypatch.setenv("PAPEER_TOKEN", "secret-token")
    with TestClient(runtime.app) as client, caplog.at_level(logging.ERROR, logger="papeer.sidecar"):
        response = client.get("/api/settings?token=secret-token", headers={"Origin": ORIGIN})
        # A request that does not validate is still 422, answered by FastAPI.
        assert client.post("/api/collections?token=secret-token", json={}).status_code == 422
    assert response.status_code == 500 and response.headers["access-control-allow-origin"] == ORIGIN
    assert response.json()["detail"].startswith("予期しないエラーが発生しました（JSONDecodeError）")
    record = next(record for record in caplog.records if record.exc_info)
    assert "GET /api/settings" in record.getMessage()
    assert "secret-token" not in caplog.text


def test_an_answer_that_is_not_json_is_told_in_words():
    from papeer.providers import parse_json_answer

    for text in ("not a json", "Here: {cut off"):
        with pytest.raises(ValueError) as error:
            parse_json_answer(text)
        assert type(error.value) is ValueError and "JSONを取り出せませんでした" in str(error.value)


def test_the_log_is_written_to_this_pcs_folder(isolated_app_data):
    from papeer.core.paths import log_directory
    from sidecar import errors

    handler = errors.log_to_file()
    assert handler is not None
    try:
        assert log_directory() == isolated_app_data / "PapeerSync" / "logs"
        try:
            raise KeyError("abc")
        except KeyError as exc:
            errors.error_response(exc, "GET /api/collections")
        handler.flush()
        text = (log_directory() / "sidecar.log").read_text("utf-8")
        assert "想定外のエラー（GET /api/collections）" in text and "Traceback" in text and "KeyError: 'abc'" in text
        assert isinstance(handler, logging.handlers.RotatingFileHandler)
        assert (handler.maxBytes, handler.backupCount) == (errors.LOG_FILE_BYTES, errors.LOG_FILE_BACKUPS)
    finally:
        for added in list(errors.log.handlers):
            errors.log.removeHandler(added)
            added.close()


def test_a_sync_backup_or_restore_still_starts_during_a_change():
    manager = JobManager()
    started = []
    with manager.idle("実行中の処理が終わってから変更してください。"):
        for kind in ("drive-sync", "backup"):
            manager.submit_job(kind, lambda *_: None)
            assert manager.wait_idle(5)
            started.append(kind)
        with pytest.raises(ConcurrencyConflict):
            manager.submit_job("import", lambda *_: None)
    assert started == ["drive-sync", "backup"]


def test_a_locked_database_is_told_in_words(caplog):
    import sqlite3

    with caplog.at_level(logging.ERROR, logger="papeer.sidecar"):
        message = job_error_message(sqlite3.OperationalError("database is locked"), "translate")
    assert message.startswith("ライブラリのデータベースを読み書きできませんでした（database is locked）")
    assert caplog.records[-1].exc_info is not None
