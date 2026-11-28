"""Preparation recovery records never stand in for retained OS authority."""
from copy import deepcopy
import json
from uuid import uuid4

import pytest

from papeer.core.migrations.legacy_preparation_journal import NativePreparationJournal
from papeer.core.migrations.legacy_startup import NativeLegacyStartup, legacy_startup_allowed


@pytest.fixture(autouse=True)
def synthetic_selection_binding(monkeypatch):
    # This module isolates journal mechanics; real selection checks are exercised
    # by test_native_preparation_recovery with actual NativeSelection/locks.
    monkeypatch.setattr('papeer.core.migrations.legacy_preparation_journal.selection_binding', lambda *_: 'd' * 64)


def record():
    return {'version': 1, 'runId': str(uuid4()), 'peerId': str(uuid4()), 'libraryId': str(uuid4()),
            'sources': [{'kind': 'desktop-library', 'id': 'a' * 64}, {'kind': 'desktop-library', 'id': 'b' * 64},
                        {'kind': 'desktop-device', 'id': 'c' * 64}],
            'backupIds': [str(uuid4()) for _ in range(3)], 'selectionSha256': 'd' * 64,
            'policy': 'native-local-capture-only-v1'}


def test_pre_hold_record_blocks_startup_and_conflicting_replay(tmp_path):
    root = tmp_path / 'library'; root.mkdir(); original = root / 'input'; original.write_bytes(b'unchanged')
    journal, value = NativePreparationJournal(root), record()
    journal.begin(value)
    assert NativeLegacyStartup(root).read() is None
    assert not legacy_startup_allowed(root)
    assert NativePreparationJournal(root).read() == value
    journal.begin(value)
    different = deepcopy(value); different['peerId'] = str(uuid4())
    with pytest.raises(ValueError): journal.begin(different)
    assert original.read_bytes() == b'unchanged'


def test_orphan_bootstrap_footprint_is_not_an_empty_startup(tmp_path):
    root = tmp_path / 'library'; root.mkdir(); journal = NativePreparationJournal(root)
    assert legacy_startup_allowed(root)
    journal.folder.mkdir(parents=True)
    (journal.folder / '.interrupted.tmp').write_bytes(b'partial')
    assert journal.read() is None and NativeLegacyStartup(root).read() is None
    assert not legacy_startup_allowed(root)


def test_interrupted_cancel_never_opens_admission(tmp_path):
    root = tmp_path / 'library'; root.mkdir(); journal, value = NativePreparationJournal(root), record()
    journal.begin(value); NativeLegacyStartup(root).hold({'version': 1, 'runId': value['runId']})
    journal.mark(value, 'cancel-intent')
    assert not legacy_startup_allowed(root)
    NativeLegacyStartup(root).path.unlink()  # Simulate interruption after the exact hold removal.
    assert not legacy_startup_allowed(root)
    journal.mark(value, 'cancel-complete')
    assert not legacy_startup_allowed(root)
    attempt = str(uuid4()); journal.mark_cleanup(value, attempt, 'begin')
    assert not legacy_startup_allowed(root)
    journal.mark_cleanup(value, attempt, 'complete')
    assert legacy_startup_allowed(root)
    assert NativePreparationJournal(root).event(value['runId'], 'cancel-complete')


def test_corrupt_or_mismatched_cancel_records_fail_closed(tmp_path):
    root = tmp_path / 'library'; root.mkdir(); journal, value = NativePreparationJournal(root), record()
    journal.begin(value); journal.mark(value, 'cancel-intent')
    event = journal._event_path(value['runId'], 'cancel-intent')
    event.write_text(json.dumps({'version': 1, 'runId': str(uuid4()), 'event': 'cancel-intent'}), 'utf8')
    assert not legacy_startup_allowed(root)
    with pytest.raises(ValueError): journal.event(value['runId'], 'cancel-intent')


def test_new_run_replaces_only_completed_cancel_with_no_unguarded_gap(tmp_path):
    root = tmp_path / 'library'; root.mkdir(); journal, first = NativePreparationJournal(root), record()
    journal.begin(first); journal.mark(first, 'cancel-intent'); journal.mark(first, 'cancel-complete')
    attempt = str(uuid4()); journal.mark_cleanup(first, attempt, 'begin'); journal.mark_cleanup(first, attempt, 'complete')
    assert legacy_startup_allowed(root)
    second = record(); journal.begin(second)
    assert NativePreparationJournal(root).read() == second
    assert not legacy_startup_allowed(root)
    assert journal.event(first['runId'], 'cancel-complete')


def test_incomplete_cancel_cannot_be_replaced_by_a_new_run(tmp_path):
    root = tmp_path / 'library'; root.mkdir(); journal, first = NativePreparationJournal(root), record()
    journal.begin(first); journal.mark(first, 'cancel-intent')
    with pytest.raises(ValueError): journal.begin(record())
    assert journal.read() == first and not legacy_startup_allowed(root)


def test_cleanup_without_completion_refuses_start_and_new_run(tmp_path):
    root = tmp_path / 'library'; root.mkdir(); journal, value = NativePreparationJournal(root), record()
    journal.begin(value); journal.mark(value, 'cancel-intent'); attempt = str(uuid4())
    journal.mark_cleanup(value, attempt, 'begin'); journal.mark(value, 'cancel-complete')
    assert journal.cleanup_state(value['runId']) == 'pending'
    assert not legacy_startup_allowed(root)
    with pytest.raises(ValueError): journal.begin(record())
    assert journal.read() == value


def test_completed_previous_run_cannot_be_replaced_under_changed_selection(tmp_path, monkeypatch):
    root = tmp_path / 'library'; root.mkdir(); journal, first = NativePreparationJournal(root), record()
    journal.begin(first); journal.mark(first, 'cancel-intent'); journal.mark(first, 'cancel-complete')
    attempt = str(uuid4()); journal.mark_cleanup(first, attempt, 'begin'); journal.mark_cleanup(first, attempt, 'complete')
    monkeypatch.setattr('papeer.core.migrations.legacy_preparation_journal.selection_binding', lambda *_: 'e' * 64)
    with pytest.raises(ValueError): journal.begin(record())
    assert journal.read() == first and not legacy_startup_allowed(root)
