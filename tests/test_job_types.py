"""The job contract (sidecar/job_types.py): kinds, a result model per kind, the finished jobs kept for
GET /api/jobs/{job_id}, and the events of /ws/events, as the frontend's types follow them."""
from __future__ import annotations

import logging
from pathlib import Path
import re
import threading
import time

from fastapi.testclient import TestClient
from pydantic import BaseModel, TypeAdapter
import pytest

from sidecar import deps, jobs
from sidecar.app import app
from sidecar.job_types import (
    RESULT_TYPES, SNAPSHOT_KINDS, BackupResult, GlossaryTerm, ImportResult, JobKind, ServerEvent, TranslateResult,
    Usage,
)
from sidecar.jobs import JobManager

FRONTEND = Path(__file__).parents[1] / "frontend/src"


def _ts_list(source: str, name: str) -> list[str]:
    match = re.search(rf"export const {name}\b[^=]*=\s*\[(.*?)\]", source, re.S)
    assert match, name
    return re.findall(r'"([^"]+)"', match[1])


def test_the_frontend_names_the_same_kinds():
    source = (FRONTEND / "features/jobs/jobKinds.ts").read_text("utf-8")
    assert _ts_list(source, "JOB_KINDS") == [kind.value for kind in JobKind]
    assert set(_ts_list(source, "SNAPSHOT_JOBS")) == {kind.value for kind in SNAPSHOT_KINDS}
    # Every kind has a result model, and the frontend a result type for it.
    assert set(RESULT_TYPES) == set(JobKind)
    results = (FRONTEND / "api/jobTypes.ts").read_text("utf-8")
    block = re.search(r"export type JobResults = \{(.*?)\};", results, re.S)
    assert block
    assert set(re.findall(r'^\s*"?([a-z-]+)"?:', block[1], re.M)) == {kind.value for kind in JobKind}


def test_the_frontend_result_types_name_the_same_fields():
    # Usage is lib/usage.ts's, which jobTypes.ts uses.
    source = "\n".join((FRONTEND / name).read_text("utf-8") for name in ("api/jobTypes.ts", "lib/usage.ts"))
    models = {model for model in RESULT_TYPES.values() if isinstance(model, type) and issubclass(model, BaseModel)}
    for model in models | {Usage, GlossaryTerm}:
        block = re.search(rf"export type {model.__name__} = \{{(.*?)\}};", source, re.S)
        assert block, model.__name__
        body = re.sub(r"/\*.*?\*/|//[^\n]*", "", block[1], flags=re.S)
        assert set(re.findall(r"(?:^|[;{\s])([a-z_]+)\??:", body)) == set(model.model_fields), model.__name__


@pytest.fixture
def manager(monkeypatch):
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    manager = JobManager()
    monkeypatch.setattr(deps, "job_manager", manager)
    return manager


def _run(manager: JobManager, kind: str, result, paper_id: str | None = None):
    job = manager.submit_job(kind, lambda *_: result, paper_id=paper_id)
    deadline = time.monotonic() + 5
    while job.running:
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)
    return job


def test_a_result_becomes_its_kinds_model(manager):
    job = _run(manager, "import", {"paper_ids": ["a" * 32], "added": 1})
    assert job.status == "succeeded" and job.result == ImportResult(paper_ids=["a" * 32], added=1)
    assert _run(manager, "check", "応答を受信しました").result == "応答を受信しました"
    # A translation report keeps the fields the model does not name.
    report = {"pages": 2, "requested_pages": [1], "selected_pages": [1], "already_translated_pages": [],
              "preserved_pages": [], "translated_pages": [1], "untranslated_pages": [2], "skipped_pages": [],
              "skipped_blocks": [], "skipped_block_pages": [], "page_errors": {}, "model": "m", "usage": None,
              "scaled_blocks": 3}
    translated = _run(manager, "translate", report, paper_id="p")
    assert isinstance(translated.result, TranslateResult)
    assert translated.result.model_dump() == report


def test_a_result_of_another_shape_fails_the_job_as_a_bug(manager, caplog):
    with caplog.at_level(logging.ERROR, logger="papeer.sidecar"):
        job = _run(manager, "backup", {"destination": "x.zip"})
    assert job.status == "failed" and job.result is None
    assert job.error and job.error.startswith("予期しないエラーが発生しました（ValidationError）")
    assert caplog.records[-1].exc_info is not None


def test_finished_jobs_are_kept_for_a_while_and_told_by_their_id(manager, monkeypatch):
    monkeypatch.setattr(jobs, "FINISHED_JOBS_KEPT", 3)
    client = TestClient(app)
    gate = threading.Event()
    running = manager.submit_job("translate", lambda *_: gate.wait(5) and None, paper_id="p")
    # Adding PDFs may run beside a paper's job.
    finished = [_run(manager, "import", {"paper_ids": [str(i)], "added": 1}) for i in range(4)]
    try:
        # Only the running ones in the list; a finished one by its id, with its result.
        assert [job["job_id"] for job in client.get("/api/jobs").json()] == [running.job_id]
        told = client.get(f"/api/jobs/{finished[-1].job_id}").json()
        assert told["status"] == "succeeded" and not told["running"] and told["result"] == {"paper_ids": ["3"], "added": 1}
        assert told["kind"] == "import" and told["error"] is None
        assert client.get(f"/api/jobs/{running.job_id}").json()["running"] is True
        # Beyond FINISHED_JOBS_KEPT the oldest is forgotten.
        assert client.get(f"/api/jobs/{finished[0].job_id}").status_code == 404
        assert client.get(f"/api/jobs/{finished[1].job_id}").status_code == 200
        assert client.get("/api/jobs/unknown").json()["detail"] == "ジョブが見つかりません。"
    finally:
        gate.set()
        assert manager.wait_idle(5)
    # The running job, once it failed (its None is no translation report), is told too.
    assert client.get(f"/api/jobs/{running.job_id}").json()["status"] == "failed"
    assert client.get(f"/api/jobs/{finished[1].job_id}").status_code == 404


def test_the_events_follow_their_models(manager, monkeypatch):
    events = []
    monkeypatch.setattr(manager, "broadcast", events.append)
    job = manager.submit_job("backup", lambda cancel, progress, page_ready: (
        progress("コピー 1/2"), page_ready(3), {"path": "b.zip"})[-1])
    assert manager.wait_idle(5)
    sent = [event.model_dump(mode="json") for event in events]
    assert [event["type"] for event in sent] == ["job.started", "job.progress", "job.page_ready", "job.finished"]
    assert sent[1] | {"message": None} == {"type": "job.progress", "job_id": job.job_id, "paper_id": None,
                                            "kind": "backup", "message": None, "done": 1, "total": 2}
    # job.finished is the job as GET /api/jobs/{job_id} tells it afterwards.
    assert sent[-1] == {"type": "job.finished", **job.model_dump(mode="json")}
    assert sent[-1]["result"] == BackupResult(path="b.zip").model_dump()
    adapter = TypeAdapter(ServerEvent)
    assert [type(adapter.validate_python(event)) for event in sent] == [type(event) for event in events]


def test_the_api_schema_has_the_results_and_the_events():
    schemas = app.openapi()["components"]["schemas"]
    for name in ("JobInfo", "JobKind", "TranslateResult", "DriveSyncResult", "GlossaryDraftResult", "Usage",
                 "ServerEvent", "JobFinishedEvent", "JobProgressEvent", "PaperChangedEvent", "ImportPagesEvent"):
        assert name in schemas, name
    kinds = set(schemas["JobKind"]["enum"])
    assert kinds == {kind.value for kind in JobKind}
    assert schemas["ServerEvent"]["discriminator"]["propertyName"] == "type"
    paths = app.openapi()["paths"]
    assert paths["/api/jobs/{job_id}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/JobInfo"}
