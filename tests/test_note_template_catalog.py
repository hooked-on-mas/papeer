from copy import deepcopy
from contextlib import contextmanager
import sqlite3

import pytest

from papeer.core.edit_model import apply_batch, assert_snapshot
from native_core_test_authority import core_repository


def identity(number):
    return f"00000000-0000-0000-0000-{number:012d}"


def item(number, title="Custom"):
    return {"id": identity(number), "kind": "markdown", "title": title, "ownerId": None,
            "folderId": None, "position": 0, "tags": [], "read": False,
            "metadata": {"papeer.note-template": "v1"}}


def root(items=None):
    return {"kind": "library", "id": identity(1), "version": identity(2), "items": items or [],
            "folders": [], "links": [], "deletions": []}


def command(before, changes):
    return {"kind": "library", "id": identity(20), "libraryId": before["id"],
            "targetId": before["id"], "parents": [before["version"]], "changes": changes}


def test_template_duplicate_is_atomic_and_ordinary_markdown_has_a_separate_role():
    before = root([item(10)])
    preserved = deepcopy(before)
    with pytest.raises(ValueError, match="duplicate-note-template-name"):
        apply_batch(before, command(before, [{"type": "put-item", "item": item(11, "Other")}, {"type": "put-item", "item": item(12)}]))
    assert before == preserved
    normal = item(11)
    normal["metadata"] = {}
    assert_snapshot(root([item(10), normal]))


def test_sqlite_duplicate_template_transaction_has_no_partial_projection_receipt_or_outbox(tmp_path):
    @contextmanager
    def connection():
        with sqlite3.connect(tmp_path / 'templates.sqlite3') as db:
            yield db

    before = root([item(10)])
    repository = core_repository(connection, {'accountId': 'template-contract', 'libraryId': before['id'], 'epoch': 'one'})
    repository.initialize({'kind': 'markdown', 'id': identity(10), 'version': identity(40), 'content': 'Template body', 'appendIds': [], 'imageResources': []})
    repository.initialize(before)
    batch = command(before, [{'type': 'put-item', 'item': item(11, 'Other')}, {'type': 'put-item', 'item': item(12)}])
    unchanged = repository.read(before['id'])
    result = repository.commit(batch)
    assert result['status'] == 'aborted'
    assert 'duplicate-note-template-name' in result['reason']
    assert repository.read(before['id']) == unchanged
    assert repository.receipt(batch['id']) is None
    assert repository.pending() == []


@pytest.mark.parametrize("original_marker", [True, False])
def test_template_role_cannot_be_changed_by_metadata_update(original_marker):
    original = item(10)
    if not original_marker:
        original["metadata"] = {}
    before = root([original])
    changed = deepcopy(original)
    changed["metadata"] = {} if original_marker else {"papeer.note-template": "v1"}
    with pytest.raises(ValueError, match="note-template-role-rebind"):
        apply_batch(before, command(before, [{"type": "put-item", "item": changed}]))


def test_template_names_versions_topology_and_restore_match_frontend_rules():
    assert_snapshot(root([item(10, "𠮷" * 80)]))
    for title in [" Custom ", "𠮷" * 81, "読書メモ"]:
        with pytest.raises(ValueError, match="note-template-name"):
            assert_snapshot(root([item(10, title)]))
    unsupported = item(10)
    unsupported["metadata"]["papeer.note-template"] = "v2"
    with pytest.raises(ValueError, match="note-template-version"):
        assert_snapshot(root([unsupported]))
    wrong = item(10)
    wrong["kind"] = "pdf"
    with pytest.raises(ValueError, match="note-template-kind"):
        assert_snapshot(root([wrong]))
    deleted = root([item(10), item(11)])
    record = {"id": identity(30), "itemIds": [identity(10)], "observed": [{"targetId": identity(10), "heads": [identity(40)]}], "active": True}
    deleted["deletions"] = [record]
    assert_snapshot(deleted)
    with pytest.raises(ValueError, match="duplicate-note-template-name"):
        apply_batch(deleted, command(deleted, [{"type": "put-deletion", "deletion": {**record, "active": False}}]))


def test_templates_cannot_own_hidden_ordinary_children():
    child = {**item(11, 'Child'), 'ownerId': identity(10), 'metadata': {}}
    with pytest.raises(ValueError, match='invalid-owner'):
        assert_snapshot(root([item(10), child]))
    assert_snapshot(root([{**item(10), 'metadata': {}}, child]))
