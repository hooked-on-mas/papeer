"""Work B7-g: interrupting the staging writer and resuming it (synthetic, isolated data only; DESIGN-r161-b7-staging.md 5.2, 5.3, 12 R-1..R-8).

The matrix: for every interruption point of `_staging_resume_points.POINTS` (P0..P10) the same run is stopped there and called again, and the
result must be what an uninterrupted run makes. "The same" is the sealed report AND the logical dump of the whole staging database (every row of
every table, resource bytes by hash). The uninterrupted run is made first on the same run (its staging folder is then removed by the test: the
product never deletes one), because every run has its own run and Library IDs, so two runs in two roots cannot have the same dump.

  R-1  an uninterrupted run twice gives the same dump         R-2  every point, by exception, in this process
  R-3  every point, by a child process that dies there (`os._exit`), and by a child the parent kills (its own Popen handle)
  R-4  a resume creates no ID and calls no uuid4          R-5  a changed manifest / converter / plan / checkpoint / resource is refused, nothing written
  R-6  a unit that differs from the plan: `staging-unit-conflict`      R-7  `diagnostic-required` is never resumed and never written
  R-8  an abandoned run's staging is `orphaned` and is not deleted      L-*  the second build of the same run, in this process and in another

Old bytes (Library, canonical store, device without the lock-protocol files, backups without a killed process's `.analysis-*`, bootstrap) never
change; nothing appears beside the Library except the staging folder; the hold stays. A killed child may leave ONE `.analysis-*` folder inside the
backup root (known, F3): the next run ignores it and does not remove it. The only processes killed are children this file started (a `Popen`
handle of this test) in the isolated environment (`assert_isolated`); no process is searched for by name. Power loss and the real environment are
not tested. Every expectation about the staging comes from the sealed rows of an uninterrupted run of the same run, never from the writer's own
resume logic.
"""
from contextlib import closing, contextmanager
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import threading
from types import SimpleNamespace
import uuid

from fastapi.testclient import TestClient
import pymupdf
import pytest

from _staging_resume_points import EXIT_CODE, POINTS, REPO, Interrupted, child_command
from test_native_maintenance_entry import AUTH, PREFIX
from test_native_conversion_input import (assert_isolated, assert_no_working_copy, backup_base, capture_live, fresh_gate, hashed, prepared,  # noqa: F401
                                          read_line, runtime)
from test_native_notebook_preview import to_cold
from test_native_staging import MAIN_RESIDUAL, bridge, db_path, failing, free_gate, stage, state_of
from papeer.core import paths
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_repository import SqliteEditRepository
from papeer.core.edit_storage import edit_storage_root
from papeer.core.migrations import legacy_staging_store as store
from papeer.core.migrations.legacy_startup import LegacyMigrationRequired, NativeLegacyStartup, legacy_startup_allowed
from papeer.core.storage import Library
from sidecar.app import app
from sidecar.lifecycle import instance
from sidecar.migrations import conversion_input, preparation, preview_gate, staging

REFUSED_BY_THE_LOCK = ('staging-unavailable', 'staging-library-lock-unavailable', 'staging-other-writer-present', 'staging-instance-writer-unverified',
                       'staging-state-unavailable')
# What the status counts must be at each point (the numbers of the 2-resource, 5-unit fixture of `image_library`).
COUNTS = {
    'P2': {'resources': 0, 'ids': 0, 'provenance': 0}, 'P3': {'resources': 1, 'ids': 1, 'provenance': 1, 'plan': 0},
    'P4': {'resources': 1, 'ids': 1, 'provenance': 1}, 'P5': {'resources': 2, 'ids': 2, 'plan': 0, 'units': 0},
    'P5-tx': {'resources': 2, 'ids': 2, 'plan': 0}, 'P6-0': {'plan': 1, 'units': 0, 'roots': 0, 'checkpoints': 0},
    'P6-2': {'plan': 1, 'units': 2, 'roots': 0}, 'P6-tx': {'units': 1, 'roots': 0}, 'P6-all': {'units': 5, 'checkpoints': 0, 'roots': 0},
    'P7': {'units': 5, 'checkpoints': 1, 'roots': 5}, 'P8': {'checkpoints': 1, 'roots': 5, 'verification': 0},
    'P8-tx': {'verification': 0}, 'P9': {'verification': 1}, 'P9-tx': {'verification': 1}, 'P10': {'verification': 1}}


# helpers ---------------------------------------------------------------------------------------------------------------
def image_library(values):
    """The main fixture plus one PNG in the Markdown note: 2 resources (the PDF and the image) and 5 units."""
    root, _device, _lock = values
    synthetic = prepared(values)
    m = synthetic.ids['M']
    png = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 2, 2), False)
    png.clear_with(200)
    content = '# memo\n![capture](media/ink-capture-1.png)\n'
    synthetic.sql(('UPDATE note_state SET content = ? WHERE id = ?', (content, m)))
    (root / 'papers' / m / 'media').mkdir(parents=True, exist_ok=True)
    (root / 'papers' / m / 'media' / 'ink-capture-1.png').write_bytes(png.tobytes('png'))
    (root / 'papers' / m / 'note.md').write_bytes(content.encode('utf-8'))
    return synthetic


def logical_dump(root, run_id):
    """Every row of every table of the staging DB (resource bytes by their hash), sorted: the logical content, not the file."""
    def cell(value):
        return {'bytes': hashlib.sha256(value).hexdigest()} if isinstance(value, bytes) else value

    with closing(sqlite3.connect(db_path(root, run_id), timeout=30)) as db:
        names = sorted(name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7) <> 'sqlite_'"))
        return {name: sorted(json.dumps([cell(value) for value in row], sort_keys=True) for row in db.execute(f'SELECT * FROM "{name}"')) for name in names}


def old_bytes(root, device):
    """Every old byte: Library, canonical store, device (except `instances/`, the lock-protocol files each process rewrites), the backups
    (except a killed process's `.analysis-*`) and the bootstrap."""
    def kept(base, skip):
        return {key: value for key, value in hashed(base, skip_locks=True).items() if not any(part in skip for part in key.split('/'))}

    def without_analysis(base):
        return {key: value for key, value in hashed(base).items() if not any(part.startswith('.analysis-') for part in key.split('/'))}

    # the bootstrap (the hold) lives in the backup root too, so a killed process's `.analysis-*` is inside both views
    return {'library': hashed(root), 'canonical': hashed(edit_storage_root(root)), 'device': kept(device, ('instances',)),
            'backups': without_analysis(backup_base(root)), 'bootstrap': without_analysis(NativeLegacyStartup(root).root)}


def siblings(root):
    return sorted(path.name for path in root.parent.iterdir())


def analysis_folders(root):
    return sorted(path.name for path in backup_base(root).rglob('.analysis-*'))


def assert_invisible(root, before_siblings):
    """Nothing but the staging folder appeared beside the Library, no canonical store, the hold stays: the Library is still not usable."""
    base = store.staging_base(root).name
    assert set(siblings(root)) <= set(before_siblings) | {base}, siblings(root)
    assert not edit_storage_root(root).exists()
    assert not legacy_startup_allowed(root)
    with pytest.raises(LegacyMigrationRequired):
        Library(root)


def raise_interrupt():
    raise Interrupted('injected')


@contextmanager
def no_random_ids(monkeypatch):
    """A resume creates no ID: every `uuid4` the process has imported fails (the stable IDs come from the converter, never from chance)."""
    def boom(*_args, **_kwargs):
        raise AssertionError('a resume asked for a random UUID')

    real = uuid.uuid4
    with monkeypatch.context() as patch:
        patch.setattr(uuid, 'uuid4', boom)
        for module in list(sys.modules.values()):
            if getattr(module, 'uuid4', None) is real:
                patch.setattr(module, 'uuid4', boom)
        yield


@contextmanager
def interrupted_at(point_id):
    restore = POINTS[point_id].install(raise_interrupt)
    try:
        yield
    finally:
        restore()


# An exception raised inside a resource's own transaction is reported by the writer as a failed resource (`staging-resource-mismatch`; low).
E_REASON = {'P4': 'staging-resource-mismatch'}


def interrupt(root, run_id, point_id):
    """Stop the run at `point_id` in this process (the writer wraps the exception as a closed reason) and check where it stopped."""
    with interrupted_at(point_id):
        assert failing(run_id) == (E_REASON.get(point_id, 'staging-unavailable'),)
    free_gate()
    return assert_point(root, run_id, point_id)


def assert_point(root, run_id, point_id):
    point = POINTS[point_id]
    state = state_of(root, run_id)
    assert (state['state'], state['phase']) == (point.state, point.phase), (point_id, state)
    assert state['reasons'] == []
    for key, value in COUNTS.get(point_id, {}).items():
        assert state['counts'][key] == value, (point_id, key, state['counts'])
    return state


def baseline_of(root, run_id):
    """The uninterrupted run of this run (report and dump); its staging folder is then removed so the same run can be interrupted."""
    report = stage(run_id)
    dump = logical_dump(root, run_id)
    assert report['reportSha256'] == edit_content_hash({key: value for key, value in report.items() if key != 'reportSha256'})
    shutil.rmtree(store.staging_base(root))
    free_gate()
    return report, dump


def run_child(env, root, run_id, point_id, mode):
    result = subprocess.run(child_command(root, run_id, point_id, mode), env=env, cwd=REPO, capture_output=True, text=True, encoding='utf8', timeout=1200)
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    answer = None
    for line in reversed(lines):
        try:
            answer = json.loads(line)
            break
        except ValueError:
            continue
    return result, answer


class Own:
    """A child this test started (its own Popen handle), alive and waiting at a point; `kill` ends it through that handle only."""

    def __init__(self, env, root, run_id, point_id):
        self.point_id = point_id
        self.process = subprocess.Popen(child_command(root, run_id, point_id, 'wait'), env=env, cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, encoding='utf8')
        marker = read_line(self.process, 900)
        if marker != 'AT ' + point_id:
            self.kill()
            pytest.fail(f'the child did not reach {point_id}: {marker!r} / {self.process.stderr.read()[-1500:]}')

    def kill(self):
        if self.process.poll() is None:
            self.process.kill()                                   # TerminateProcess on this test's own child
        self.process.wait(timeout=120)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()
        return self.process.returncode


# R-1 -------------------------------------------------------------------------------------------------------------------
def test_r1_two_uninterrupted_runs_of_the_same_run_have_the_same_logical_dump(runtime):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        first, dump_one = baseline_of(root, run_id)
        second, dump_two = baseline_of(root, run_id)
    assert first == second and dump_one == dump_two
    assert len(dump_one['migration_staging_units']) == 5 and len(dump_one['edit_resources']) == 2 and len(dump_one['edit_checkpoints']) == 1
    assert dump_one['migration_staging_run'] and json.loads(dump_one['migration_staging_run'][0])[8] == 'staged'      # phase, as the last committed state


# R-2 -------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize('point_id', list(POINTS))
def test_r2_an_exception_at_every_point_is_resumed_to_the_uninterrupted_staging(runtime, monkeypatch, point_id):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        before, before_siblings = old_bytes(root, device), siblings(root)
        report, want = baseline_of(root, run_id)
        interrupt(root, run_id, point_id)
        interrupted = logical_dump(root, run_id) if POINTS[point_id].state in ('resumable', 'staged') else None
        with no_random_ids(monkeypatch):
            resumed = stage(run_id)
        assert resumed == report
        assert logical_dump(root, run_id) == want
        if interrupted is not None:                                 # what was committed before the stop is still there, unchanged
            now = logical_dump(root, run_id)
            for table in ('migration_staging_ids', 'migration_staging_provenance', 'migration_staging_units'):
                assert set(interrupted[table]) <= set(now[table]), (point_id, table)
        assert state_of(root, run_id)['state'] == 'staged' and not preview_gate.gate.inflight()
        assert old_bytes(root, device) == before
        assert_no_working_copy(root)
        assert_invisible(root, before_siblings)
    free_gate()


# R-3 -------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize('point_id', list(POINTS))
def test_r3_a_child_that_dies_at_every_point_is_resumed_by_a_new_process(runtime, monkeypatch, tmp_path_factory, point_id):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    env = assert_isolated(tmp_path_factory, device, root, paths.selected_data_directory())
    with TestClient(app) as client:
        run_id = capture_live(client)
        to_cold(monkeypatch)                                          # what a restarted process sees: the durable state alone
        before, before_siblings = old_bytes(root, device), siblings(root)
        report, want = baseline_of(root, run_id)
        instance.release()                                           # this process lets the Library lock go; the children take it themselves
        died, answer = run_child(env, root, run_id, point_id, 'exit')
        assert died.returncode == EXIT_CODE and answer is None, (died.returncode, died.stdout[-500:], died.stderr[-1500:])
        assert_point(root, run_id, point_id)
        leftovers = analysis_folders(root)
        assert len(leftovers) == (1 if point_id == 'P0-copy' else 0), leftovers      # only a death inside the working copy leaves one
        resumed, answer = run_child(env, root, run_id, 'none', 'none')
        assert resumed.returncode == 0 and answer is not None and answer.get('report') == report, (resumed.returncode, resumed.stderr[-1500:], answer)
        assert logical_dump(root, run_id) == want
        assert analysis_folders(root) == leftovers                    # the leftover is ignored, neither removed nor added to
        assert old_bytes(root, device) == before
        assert_invisible(root, before_siblings)


@pytest.mark.parametrize('point_id', ['P0-copy', 'P3', 'P4', 'P6-tx', 'P7', 'P8', 'P9-tx'])
def test_r3_a_child_the_parent_kills_is_resumed_by_a_new_process(runtime, monkeypatch, tmp_path_factory, point_id):  # noqa: F811
    """The OS-level kill of a child this test started (TerminateProcess through its Popen handle) while it waits at the point. For the points
    inside a transaction the child holds the open write transaction when it is killed. Another process meanwhile cannot take the Library lock."""
    root, device, _lock = runtime
    image_library(runtime)
    env = assert_isolated(tmp_path_factory, device, root, paths.selected_data_directory())
    with TestClient(app) as client:
        run_id = capture_live(client)
        to_cold(monkeypatch)
        before, before_siblings = old_bytes(root, device), siblings(root)
        report, want = baseline_of(root, run_id)
        instance.release()
        child = Own(env, root, run_id, point_id)
        try:
            # L-2: while the first process is alive and holds the Library lock, nobody else can build the same run: this process (which no longer
            # holds the lock) is refused, and a second child cannot even take the lock. Neither writes anything.
            alive_dump = logical_dump(root, run_id) if POINTS[point_id].state in ('resumable', 'staged') else None
            refused = failing(run_id)
            assert refused[0] in REFUSED_BY_THE_LOCK, refused
            second, answer = run_child(env, root, run_id, 'none', 'none')
            assert second.returncode != 0 and answer is None, (second.returncode, second.stdout[-500:])
            free_gate()
            if alive_dump is not None:
                assert logical_dump(root, run_id) == alive_dump
        finally:
            returncode = child.kill()
        assert returncode not in (0, EXIT_CODE) and child.process.poll() is not None
        assert_point(root, run_id, point_id)
        resumed, answer = run_child(env, root, run_id, 'none', 'none')
        assert resumed.returncode == 0 and answer is not None and answer.get('report') == report, (resumed.returncode, resumed.stderr[-1500:], answer)
        assert logical_dump(root, run_id) == want
        assert old_bytes(root, device) == before
        assert_invisible(root, before_siblings)


# R-4 -------------------------------------------------------------------------------------------------------------------
def test_r4_a_resume_keeps_every_id_it_already_has_and_asks_for_no_uuid(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report, want = baseline_of(root, run_id)
        interrupt(root, run_id, 'P6-2')
        ids = sql_rows(root, run_id, 'SELECT kind, source_key, target_id FROM migration_staging_ids')
        provenance = sql_rows(root, run_id, 'SELECT * FROM migration_staging_provenance')
        assert ids and provenance
        with no_random_ids(monkeypatch):
            assert stage(run_id) == report
        assert sql_rows(root, run_id, 'SELECT kind, source_key, target_id FROM migration_staging_ids') == ids
        assert sql_rows(root, run_id, 'SELECT * FROM migration_staging_provenance') == provenance
        assert logical_dump(root, run_id) == want
    free_gate()


def sql_rows(root, run_id, statement):
    with closing(sqlite3.connect(db_path(root, run_id), timeout=30)) as db:
        return sorted(db.execute(statement).fetchall())


# R-5 / R-6 -------------------------------------------------------------------------------------------------------------
def refused_with(run_id, reason, convert=bridge):
    assert failing(run_id, convert) == (reason,)
    free_gate()


def never(_data):
    raise AssertionError('not converted: the resume must have been refused before')


def changed_manifest(real):
    def wrapper(*args, **kwargs):
        manifest = real(*args, **kwargs)
        body = {key: value for key, value in manifest.items() if key != 'manifestSha256'}
        body['wholeLibrary'] = {**body['wholeLibrary'], 'reasons': sorted({*body['wholeLibrary']['reasons'], 'zz-a-new-reason'})}
        return {**body, 'manifestSha256': edit_content_hash(body)}
    return wrapper


def test_r5_a_resume_whose_manifest_converter_or_plan_differ_is_refused_and_writes_nothing(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        before = old_bytes(root, device)
        report, want = baseline_of(root, run_id)
        interrupt(root, run_id, 'P6-2')
        stopped = logical_dump(root, run_id)
        # the manifest the sources make now is not the stored one
        with monkeypatch.context() as patch:
            patch.setattr(conversion_input, '_manifest', changed_manifest(conversion_input._manifest))
            refused_with(run_id, 'staging-input-changed', never)
        assert logical_dump(root, run_id) == stopped
        # the converter makes another plan than the stored one (the plan is valid; only its hash differs)

        def other_plan(data):
            plan = bridge(data)
            plan['residualReasons'] = sorted({*plan['residualReasons'], 'zz-another-residual-reason'})
            plan['planSha256'] = edit_content_hash({key: value for key, value in plan.items() if key != 'planSha256'})
            return plan

        refused_with(run_id, 'staging-plan-changed', other_plan)
        assert logical_dump(root, run_id) == stopped
        # the stored run row names another converter version
        sql_write(root, run_id, "UPDATE migration_staging_run SET converter_version = 'b7-v0'")
        refused_with(run_id, 'staging-converter-changed', never)
        sql_write(root, run_id, "UPDATE migration_staging_run SET converter_version = ?", store.CONVERTER_VERSION)
        assert logical_dump(root, run_id) == stopped
        # and the right resume still works, and is the uninterrupted staging
        assert stage(run_id) == report and logical_dump(root, run_id) == want
        assert old_bytes(root, device) == before
    free_gate()


def sql_write(root, run_id, statement, *args):
    with closing(sqlite3.connect(db_path(root, run_id), timeout=30)) as db:
        db.execute(statement, args)
        db.commit()


def test_r6_a_unit_that_differs_from_the_plan_is_a_unit_conflict_and_nothing_more_is_written(runtime):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report, want = baseline_of(root, run_id)
        interrupt(root, run_id, 'P6-2')
        stopped = logical_dump(root, run_id)
        original = sql_rows(root, run_id, 'SELECT seq, payload FROM migration_staging_units ORDER BY seq')
        seq, payload = original[0]
        # the same unit ID and hash column, another payload: only the text itself shows it
        sql_write(root, run_id, 'UPDATE migration_staging_units SET payload = ? WHERE seq = ?', json.dumps({'kind': 'other'}), seq)
        tampered = logical_dump(root, run_id)
        refused_with(run_id, 'staging-unit-conflict')
        assert logical_dump(root, run_id) == tampered              # the remaining three units were NOT written before the refusal
        assert state_of(root, run_id)['counts']['units'] == 2 and state_of(root, run_id)['phase'] == 'planned'
        # a unit whose seq and hash column are not the plan's is not even resumable: diagnostic-required, at admission
        sql_write(root, run_id, 'UPDATE migration_staging_units SET payload = ? WHERE seq = ?', payload, seq)
        assert logical_dump(root, run_id) == stopped
        sql_write(root, run_id, "UPDATE migration_staging_units SET payload_sha256 = ? WHERE seq = ?", '0' * 64, seq)
        refused_with(run_id, 'staging-diagnostic-required', never)
        sql_write(root, run_id, "UPDATE migration_staging_units SET payload_sha256 = ? WHERE seq = ?", edit_content_hash(json.loads(payload)), seq)
        assert logical_dump(root, run_id) == stopped
        assert stage(run_id) == report and logical_dump(root, run_id) == want
    free_gate()


def test_r5_a_checkpoint_of_another_plan_and_a_resource_that_is_not_the_planned_one_are_refused(runtime):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report, want = baseline_of(root, run_id)
        # P7: a checkpoint is installed, but it is not the one this plan makes: it is not added to
        interrupt(root, run_id, 'P7')
        stopped = logical_dump(root, run_id)
        good = sql_rows(root, run_id, 'SELECT sha256 FROM edit_checkpoints')[0][0]
        sql_write(root, run_id, 'UPDATE edit_checkpoints SET sha256 = ?', 'f' * 64)
        tampered = logical_dump(root, run_id)
        refused_with(run_id, 'staging-plan-changed')
        assert logical_dump(root, run_id) == tampered and state_of(root, run_id)['phase'] == 'units'
        sql_write(root, run_id, 'UPDATE edit_checkpoints SET sha256 = ?', good)
        assert logical_dump(root, run_id) == stopped
        assert stage(run_id) == report and logical_dump(root, run_id) == want
        # P3: a stored resource whose bytes are not what its hash says, then one whose metadata is not the plan's
        shutil.rmtree(store.staging_base(root))
        interrupt(root, run_id, 'P3')
        stopped = logical_dump(root, run_id)
        (sha, payload), = sql_rows(root, run_id, 'SELECT sha256, payload FROM edit_resource_bytes')
        broken = bytes(payload[:-1]) + bytes([payload[-1] ^ 1])
        sql_write(root, run_id, 'UPDATE edit_resource_bytes SET payload = ?', broken)
        refused_with(run_id, 'staging-resource-mismatch')
        sql_write(root, run_id, 'UPDATE edit_resource_bytes SET payload = ?', bytes(payload))
        assert logical_dump(root, run_id) == stopped
        (metadata,) = sql_rows(root, run_id, 'SELECT payload FROM edit_resources')
        sql_write(root, run_id, 'UPDATE edit_resources SET payload = ?',
                  json.dumps({**json.loads(metadata[0]), 'mediaType': 'application/octet-stream'}, sort_keys=True, separators=(',', ':')))
        refused_with(run_id, 'staging-resource-mismatch')
        sql_write(root, run_id, 'UPDATE edit_resources SET payload = ?', metadata[0])
        assert logical_dump(root, run_id) == stopped
        # a stored resource that is consistent in itself (its bytes, their hash and length, its metadata) but is not the planned file at all:
        # the repository cannot tell, only the comparison with the plan can
        other = b'not the planned file'
        again = {**json.loads(metadata[0]), 'sha256': hashlib.sha256(other).hexdigest(), 'byteLength': len(other)}
        sql_write(root, run_id, 'UPDATE edit_resource_bytes SET sha256 = ?, payload = ?', again['sha256'], other)
        sql_write(root, run_id, 'UPDATE edit_resources SET payload = ?', json.dumps(again, sort_keys=True, separators=(',', ':')))
        refused_with(run_id, 'staging-resource-mismatch')
        sql_write(root, run_id, 'UPDATE edit_resource_bytes SET sha256 = ?, payload = ?', sha, bytes(payload))
        sql_write(root, run_id, 'UPDATE edit_resources SET payload = ?', metadata[0])
        assert logical_dump(root, run_id) == stopped
        assert stage(run_id) == report and logical_dump(root, run_id) == want
    free_gate()


# `verified` (P9): the manifest is rebuilt and the durable state compared before the seal (REVIEW-r161-b7f low 1) ----------
def test_r5_a_verified_staging_is_sealed_only_when_the_sources_are_still_the_stored_ones(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report, want = baseline_of(root, run_id)
        interrupt(root, run_id, 'P9')
        stopped = logical_dump(root, run_id)
        with monkeypatch.context() as patch:                           # the rebuilt manifest is not the stored one
            patch.setattr(conversion_input, '_manifest', changed_manifest(conversion_input._manifest))
            refused_with(run_id, 'staging-input-changed', never)
        assert state_of(root, run_id)['phase'] == 'verified' and logical_dump(root, run_id) == stopped
        real, calls = staging._fingerprint, []
        with monkeypatch.context() as patch:                           # the durable state moved while this call ran

            def moving(token):
                calls.append(1)
                return real(token) if len(calls) == 1 else ('moved', len(calls))

            patch.setattr(staging, '_fingerprint', moving)
            refused_with(run_id, 'staging-source-changed', never)
        assert len(calls) == 2 and state_of(root, run_id)['phase'] == 'verified' and logical_dump(root, run_id) == stopped
        assert stage(run_id, never) == report and logical_dump(root, run_id) == want
    free_gate()


# R-7 -------------------------------------------------------------------------------------------------------------------
def break_the_file(root, run_id):
    path = db_path(root, run_id)
    with closing(sqlite3.connect(path)) as db:
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        db.execute('PRAGMA journal_mode=DELETE')
    data = bytearray(path.read_bytes())
    for offset in range(4096 * 3, min(len(data), 4096 * 6)):
        data[offset] ^= 0xFF
    path.write_bytes(bytes(data))


def add_file(root, run_id):
    (store.staging_folder(root, run_id) / 'stray.txt').write_bytes(b'x')


DIAGNOSTICS = {
    'schema-mismatch': lambda root, run_id: sql_write(root, run_id, 'CREATE TABLE stray(x)'),
    'run-row-missing': lambda root, run_id: sql_write(root, run_id, 'DELETE FROM migration_staging_run'),
    'run-row-invalid': lambda root, run_id: sql_write(root, run_id, "UPDATE migration_staging_run SET input_set_sha256 = 'zz'"),
    'manifest-invalid': lambda root, run_id: sql_write(root, run_id, "UPDATE migration_staging_run SET manifest = '{}'"),
    'phase-mismatch': lambda root, run_id: sql_write(root, run_id, "UPDATE migration_staging_run SET phase = 'initialized'"),
    'unit-plan-mismatch': lambda root, run_id: sql_write(root, run_id, "UPDATE migration_staging_units SET target_id = 'x' WHERE seq = 1"),
    'plan-invalid': lambda root, run_id: sql_write(root, run_id, "UPDATE migration_staging_plan SET plan = '{}'"),
    'forbidden-rows': lambda root, run_id: sql_write(root, run_id, "INSERT INTO edit_batches VALUES('s', 'b', 't', '{}', '{}', NULL)"),
    'foreign-scope': lambda root, run_id: sql_write(root, run_id, "INSERT INTO edit_resources VALUES('another', 'r', '{}')"),
    'multiple-checkpoints': lambda root, run_id: sql_write(root, run_id, "INSERT INTO edit_checkpoints SELECT scope, 'e' || substr(sha256, 2) FROM edit_checkpoints"),
    'unexpected-entries': add_file,
    'unreadable-database': break_the_file,
}


def files_of(root, run_id):
    folder = store.staging_folder(root, run_id)
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(folder.iterdir())
            if not path.name.endswith('-shm') and not (path.name.endswith('-wal') and path.stat().st_size == 0)}


def test_r7_a_staging_that_cannot_be_classified_is_never_resumed_and_never_written(runtime):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        baseline_of(root, run_id)
        interrupt(root, run_id, 'P7')                                  # checkpoint and units: every table has a row to tamper with
        good = store.staging_folder(root, run_id)
        copy = good.with_name('good-copy')
        with closing(sqlite3.connect(db_path(root, run_id))) as db:
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        shutil.copytree(good, copy)
        before = old_bytes(root, device)
        seen = {}
        for cause, tamper in DIAGNOSTICS.items():
            tamper(root, run_id)
            files = files_of(root, run_id)
            state = state_of(root, run_id)
            assert state['state'] == 'diagnostic-required', (cause, state)
            seen[cause] = state['reasons']
            refused_with(run_id, 'staging-diagnostic-required', never)
            assert files_of(root, run_id) == files, cause              # not one byte of the staging was written, repaired or removed
            assert state_of(root, run_id)['state'] == 'diagnostic-required' and not preview_gate.gate.inflight()
            shutil.rmtree(good)
            shutil.copytree(copy, good)                                # the next cause starts from the same good state
        assert seen['schema-mismatch'] == ['schema-mismatch'] and seen['run-row-missing'] == ['run-row-missing']
        assert 'forbidden-rows' in seen['forbidden-rows'] and 'foreign-scope' in seen['foreign-scope']
        assert seen['multiple-checkpoints'] == ['multiple-checkpoints'] and seen['unexpected-entries'] == ['unexpected-entries']
        assert seen['unreadable-database'][0] in ('quick-check-failed', 'database-unreadable')
        assert old_bytes(root, device) == before
        assert stage(run_id)['residualReasons'] == MAIN_RESIDUAL and state_of(root, run_id)['state'] == 'staged'
    free_gate()


# R-8 -------------------------------------------------------------------------------------------------------------------
def test_r8_an_abandoned_run_leaves_its_staging_as_an_orphan_that_is_not_deleted(runtime):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        baseline_of(root, run_id)
        interrupt(root, run_id, 'P6-2')
        stopped, files = logical_dump(root, run_id), files_of(root, run_id)
        assert client.post(PREFIX + 'abandon', json={'runId': run_id}, headers=AUTH).status_code in (200, 202)
        assert preparation._current.wait(60)['state'] == 'cancelled'
        status = staging.status(run_id)
        assert status['state'] == 'orphaned' and status['underlying'] == 'resumable' and status['complete'] is False, status
        assert failing(run_id) == ('staging-state-unavailable',)       # the hold is gone: a build is refused, and nothing is written or deleted
        assert logical_dump(root, run_id) == stopped and files_of(root, run_id) == files
        assert store.staging_folder(root, run_id).is_dir()
    free_gate()


# L-1 -------------------------------------------------------------------------------------------------------------------
def test_l1_a_second_build_of_the_same_run_is_refused_while_the_first_is_running(runtime):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        entered, release = threading.Event(), threading.Event()

        def slow(data):
            entered.set()
            assert release.wait(600)
            return bridge(data)

        token, future = staging.start(run_id, slow)
        try:
            assert entered.wait(600)
            assert failing(run_id) == ('staging-busy',)
            with pytest.raises(ValueError) as error:
                staging.start(run_id, bridge)
            assert error.value.args == ('staging-busy',)
            assert staging.status(run_id)['state'] == 'absent'
        finally:
            release.set()
        report = future.result(900)
        assert report['reportSha256'] and state_of(root, run_id)['state'] == 'staged'
        assert stage(run_id) == report                                   # and afterwards the same call is the harmless "already staged"
    free_gate()


# resume details -------------------------------------------------------------------------------------------------------
def disk_with(free):
    return SimpleNamespace(disk_usage=lambda _path: shutil._ntuple_diskusage(free + 10, 10, free))


def test_a_resume_needs_free_space_only_for_the_resources_still_missing(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report, want = baseline_of(root, run_id)
        total = sum(json.loads(json.loads(row)[2])['byteLength'] for row in want['edit_resources'])       # both resources, from the uninterrupted run
        interrupt(root, run_id, 'P3')                                                                        # one of the two is stored
        stored = state_of(root, run_id)['counts']['resourceBytes']
        missing = total - stored
        assert 0 < stored < total
        # only the name inside the writer's module is replaced: the backup's own free-space check must not be what refuses here
        with monkeypatch.context() as patch:
            patch.setattr(staging, 'shutil', disk_with(conversion_input.DISK_MARGIN_BYTES + missing - 1))
            assert failing(run_id) == ('staging-disk-insufficient',)
        free_gate()
        assert state_of(root, run_id)['phase'] == 'initialized'
        with monkeypatch.context() as patch:
            patch.setattr(staging, 'shutil', disk_with(conversion_input.DISK_MARGIN_BYTES + missing))
            assert stage(run_id) == report
        assert logical_dump(root, run_id) == want
    free_gate()


def test_a_resume_that_finds_every_resource_with_the_phase_still_initialized_completes_the_phase(runtime):  # noqa: F811
    """A state the writer cannot make by itself (a resource and its rows are one transaction with the phase) but a resume must still not
    mistake: every resource is there, the phase says `initialized`. The rows are kept and the phase moves, nothing else changes."""
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report, want = baseline_of(root, run_id)
        interrupt(root, run_id, 'P5')
        sql_write(root, run_id, "UPDATE migration_staging_run SET phase = 'initialized'")
        assert state_of(root, run_id)['phase'] == 'initialized' and state_of(root, run_id)['counts']['resources'] == 2
        assert stage(run_id) == report and logical_dump(root, run_id) == want
    free_gate()


def test_a_resume_whose_status_and_run_row_disagree_is_refused(runtime, monkeypatch):  # noqa: F811
    """Defence in depth: the phase the admission classified and the phase the run row says when the worker reads it must be the same."""
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        baseline_of(root, run_id)
        interrupt(root, run_id, 'P6-2')
        stopped = logical_dump(root, run_id)
        real, calls = store.read_run_record, []

        def other_phase(*args, **kwargs):
            record = real(*args, **kwargs)
            calls.append(1)
            return {**record, 'phase': 'units'} if len(calls) == 1 else record

        with monkeypatch.context() as patch:
            patch.setattr(store, 'read_run_record', other_phase)
            refused_with(run_id, 'staging-state-unavailable', never)
        assert logical_dump(root, run_id) == stopped
    free_gate()


@pytest.mark.parametrize(('point_id', 'writes'), [('P2', 2), ('P3', 1), ('P5', 0), ('P6-2', 0)])
def test_a_resume_stores_only_the_resources_that_are_not_yet_stored(runtime, monkeypatch, point_id, writes):  # noqa: F811
    root, device, _lock = runtime
    image_library(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report, want = baseline_of(root, run_id)
        interrupt(root, run_id, point_id)
        calls = []
        real = SqliteEditRepository.store_resource
        with monkeypatch.context() as patch:
            patch.setattr(SqliteEditRepository, 'store_resource', lambda self, *args, **kwargs: (calls.append(args[0]), real(self, *args, **kwargs))[1])
            assert stage(run_id) == report
        assert len(calls) == writes and len(set(calls)) == writes
        assert logical_dump(root, run_id) == want
    free_gate()
