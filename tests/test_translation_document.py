"""Primary/translated pages share one document DAG but never share annotation identities."""
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import shutil
import subprocess

import pytest

from papeer.core.edit_model import EditGraph, apply_batch, assert_snapshot
from native_core_test_authority import core_repository

FOLDER = Path(__file__).parent / "fixtures"
FIXTURE = json.loads((FOLDER / "shared-edits.json").read_text("utf-8"))
ROOT = FIXTURE["translation"]["root"]
INK, UPDATE = FIXTURE["translation"]["batches"]


def test_translated_ink_mapping_replacement_and_late_edit_keep_distinct_document_branches():
    annotated = apply_batch(ROOT, INK)
    assert annotated["pages"] == ROOT["pages"]
    assert len(annotated["translation"]["pages"][0]["annotations"]) == 1
    replaced = apply_batch(annotated, UPDATE)
    assert replaced["translation"]["revision"] == UPDATE["id"]
    assert len(replaced["deletedPages"][0]["annotations"]) == 1
    assert replaced["translation"]["pages"][0]["annotations"] == []
    late = deepcopy(INK)
    late["id"], late["parents"] = "00000000-0000-0000-0000-000000000940", [INK["id"]]
    late["expected"]["annotationVersion"] = INK["id"]
    late["changes"] = [{"type": "delete", "id": INK["changes"][0]["annotation"]["id"]}]
    graph = EditGraph({"version": 1, "libraryId": FIXTURE["libraryId"], "root": ROOT, "batches": [UPDATE, late, INK]})
    assert graph.view["heads"] == sorted([UPDATE["id"], late["id"]])
    late["parents"] = [UPDATE["id"]]
    with pytest.raises(ValueError, match="stale-page"):
        apply_batch(replaced, late)


@pytest.mark.parametrize("fault", ["duplicate-original", "duplicate-candidate", "missing-target", "non-pdf", "shared-page-id"])
def test_invalid_translation_snapshot_is_rejected_in_the_shared_domain(fault):
    value = deepcopy(ROOT)
    mapping = value["translation"]
    if fault == "duplicate-original":
        mapping["bindings"].append(deepcopy(mapping["bindings"][0]))
    elif fault == "duplicate-candidate":
        mapping["bindings"][0]["candidates"] *= 2
    elif fault == "missing-target":
        mapping["bindings"][0]["candidates"][0]["pageId"] = value["pages"][0]["id"]
    elif fault == "non-pdf":
        mapping["pages"][0]["background"] = {"kind": "paper", "spec": {"template": "blank", "color": "white"}}
    else:
        mapping["pages"][0]["id"] = value["pages"][0]["id"]
    with pytest.raises(ValueError):
        assert_snapshot(value)


def test_native_repository_projects_translation_pages_as_immutable_refs_and_restores_after_restart(tmp_path):
    @contextmanager
    def connection():
        with sqlite3.connect(tmp_path / "library.sqlite3") as db:
            yield db
    scope = {"accountId": "fixture", "libraryId": FIXTURE["libraryId"], "epoch": "translation"}
    repository = core_repository(connection, scope)
    metadata = FIXTURE["resource"]["metadata"]
    repository.store_resource(metadata["id"], metadata["sha256"], metadata["mediaType"], (FOLDER / FIXTURE["resource"]["file"]).read_bytes(), metadata)
    repository.initialize(ROOT)
    assert repository.commit(INK)["status"] == "durable"
    with connection() as db:
        db.execute("CREATE TRIGGER fail_mapping BEFORE INSERT ON edit_projections WHEN NEW.version='" + UPDATE["id"] + "' BEGIN SELECT RAISE(ABORT, 'quota'); END")
    assert repository.commit(UPDATE)["status"] == "aborted"
    assert repository.read(ROOT["id"])["heads"] == [INK["id"]]
    with connection() as db:
        db.execute("DROP TRIGGER fail_mapping")
    assert repository.commit(UPDATE)["status"] == "durable"
    restarted = core_repository(connection, scope)
    state = restarted.read(ROOT["id"])
    graph = EditGraph(state["checkpoint"])
    assert len(graph.states[UPDATE["id"]]["deletedPages"][0]["annotations"]) == 1
    with connection() as db:
        projection = json.loads(db.execute("SELECT payload FROM edit_projections WHERE scope=? AND version=?", (repository.namespace, UPDATE["id"])).fetchone()[0])
    assert all(isinstance(page, str) for page in projection["translation"]["pages"])
    assert projection["translation"]["bindings"] == UPDATE["changes"][0]["translation"]["bindings"]


def test_typescript_history_inverse_batches_are_accepted_by_native_sqlite_without_field_loss(tmp_path):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is needed for the actual shared history producer")
    script = """
import { readFileSync } from 'node:fs';
import { applyBatch } from './frontend/src/runtime/edits/editModel.ts';
import { DocumentEditHistory } from './frontend/src/features/reader/edit/documentHistory.ts';
const fixture = JSON.parse(readFileSync(0, 'utf8'));
let current = fixture.translation.root, nextId = 2000;
const snapshots = new Map([[current.version, current]]), batches = new Map(), requests = [], history = new DocumentEditHistory();
const versions = { batch: id => batches.get(id), snapshot: id => snapshots.get(id) };
const apply = (batch, record = { operationId: batch.id, beforeVersion: current.version, afterVersion: batch.id, undoRequested: false }) => {
  current = applyBatch(current, batch); snapshots.set(batch.id, current); batches.set(batch.id, batch);
  history.record(batch, record); requests.push({ batch, history: record });
};
for (const batch of fixture.translation.batches) apply(batch);
for (const kind of ['undo','undo','redo','redo']) {
  const id = '00000000-0000-0000-0000-' + String(nextId++).padStart(12, '0');
  const command = history.command(kind, versions, current, id); apply(command.batch, command.history);
}
process.stdout.write(JSON.stringify({ requests, final: current }));
"""
    produced = subprocess.run([node, "--input-type=module", "-e", script], cwd=FOLDER.parents[1],
                              input=json.dumps(FIXTURE), text=True, encoding="utf-8", capture_output=True, check=True, timeout=30)
    result = json.loads(produced.stdout)
    @contextmanager
    def connection():
        with sqlite3.connect(tmp_path / "library.sqlite3") as db:
            yield db
    scope = {"accountId": "fixture", "libraryId": FIXTURE["libraryId"], "epoch": "history-interop"}
    repository = core_repository(connection, scope)
    metadata = FIXTURE["resource"]["metadata"]
    repository.store_resource(metadata["id"], metadata["sha256"], metadata["mediaType"], (FOLDER / FIXTURE["resource"]["file"]).read_bytes(), metadata)
    repository.initialize(ROOT)
    for request in result["requests"]:
        assert repository.commit(request["batch"], request["history"])["status"] == "durable"
    restarted = core_repository(connection, scope)
    read = restarted.read(ROOT["id"])
    assert EditGraph(read["checkpoint"]).states[read["heads"][0]] == result["final"]
    assert sum("action" in record for record in read["history"]) == 4
