"""Work B7-f: the staging writer on the registered preparation run (synthetic, isolated data only).

The whole of DESIGN 5.1 on a real synthetic Library: the verified copy and backup are read once, the REAL TypeScript converters (through the
test bridge `frontend/tests/migrations/stagingConversionBridge.ts`, decision J1) produce the plan, the writer checks that plan against numbers it
counted itself, writes resource -> plan -> unit -> assembly, reads everything back, verifies and seals. `staged` is the only final state and
nothing is publishable. Every expectation below is counted straight from SQLite / the files of the fixture (`Synthetic.expected`), never from
the converter or from the staging.

  S-1 .. S-14 of DESIGN 12.2 are the tests named `test_s1_` .. `test_s14_`; the others are the hand-overs of B7-a / B7-c / B7-d / B7-e (named
  in the docstrings). The interrupted-process matrix and every resume from P1-P7 are work B7-g (this file only pins the boundary).
A test that needs a second call does it inside the same `TestClient` block: the live preparation run ends with the lifespan.
`monkeypatch.undo()` is never used (it would also undo the fixtures' own patches); a patch that must end early is a `monkeypatch.context()`.
"""
from contextlib import closing, contextmanager
import copy
import hashlib
import json
import shutil
import sqlite3
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pymupdf
import pytest

from _synthetic_legacy_library import SENTINELS
from test_native_conversion_input import (assert_no_working_copy, capture_live, fresh_gate, prepared, runtime, snapshot)  # noqa: F401 - shared fixtures
from test_native_notebook_preview import to_cold
from test_native_staging_conversion_ts import converted
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_storage import edit_storage_root
from papeer.core.migrations import legacy_staging_rows as staging_rows
from papeer.core.migrations import legacy_staging_store as store
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from sidecar.app import app
from sidecar.migrations import preview_gate, staging

WAIT = 600
MAIN_RESOLVED = ['folder-not-converted', 'item-link-not-converted', 'markdown-not-converted', 'pdf-annotation-not-converted',
                 'pdf-document-not-converted']
NOTEBOOK_INCOMPLETE = ['external-writer-quiescence', 'original-pdf-fidelity-unverified', 'publication-and-activation',
                       'whole-library-and-other-source-coverage']
MAIN_RESIDUAL = sorted(['derived-file-retained', 'device-local-undecided', 'library-metadata-not-converted', 'messages-not-converted',
                        'note-import-pending', 'page-text-not-converted', 'summary-not-converted', 'translation-not-converted',
                        'uncollected-source', *NOTEBOOK_INCOMPLETE])


def bridge(data):
    """The real TypeScript converters."""
    return converted(data)


def stage(run_id, convert=bridge):
    return staging.build(run_id, convert, timeout=WAIT)


def failing(run_id, convert=bridge):
    """The arguments of the ValueError that staging raises (a call that succeeds fails the test)."""
    with pytest.raises(ValueError) as error:
        stage(run_id, convert)
    assert error.value.__cause__ is None and error.value.__suppress_context__
    return error.value.args


def free_gate():
    assert preview_gate.gate.wait_idle(10) and not preview_gate.gate.inflight(), 'the gate was not given back'


def db_path(root, run_id):
    return store.staging_folder(root, run_id) / store.DB_NAME


def sql(root, run_id, statement, *args):
    with closing(sqlite3.connect(db_path(root, run_id))) as db:
        rows = db.execute(statement, args).fetchall()
        db.commit()
    return rows


def direct(root, statement, *args):
    with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
        return db.execute(statement, args).fetchall()


def state_of(root, run_id):
    """The read-only classification of the run's staging (the hold is this run's)."""
    return store.staging_status(root, run_id, hold_run_id=run_id)


def retamper(plan, edit):
    """A plan an honest-looking converter could not have made: edited, then every hash recomputed, so that only the writer's own
    independent counts can tell (E-3 of work B7-h, in a cheaper form)."""
    plan = copy.deepcopy(plan)
    edit(plan)
    for unit in plan['units']:
        unit['payloadSha256'] = edit_content_hash(unit['payload'])
    plan['planSha256'] = edit_content_hash({key: value for key, value in plan.items() if key != 'planSha256'})
    return plan


def tampering(edit):
    return lambda data: retamper(bridge(data), edit)


def unit_of(plan, kind):
    return next(unit for unit in plan['units'] if unit['sourceKind'] == kind)


@contextmanager
def at_boundary(monkeypatch, stage_name, action):
    """Run `action(token)` at the boundary just before the stage `stage_name` starts (a boundary is never inside a transaction), then the
    real check. Only this patch is undone afterwards."""
    real = staging._boundary

    def wrapper(token, name):
        if name == stage_name:
            action(token)
        real(token, name)                                   # the stage has not started: a cancel set by `action` stops it right here

    with monkeypatch.context() as patch:
        patch.setattr(staging, '_boundary', wrapper)
        yield


def staged(runtime, **options):          # noqa: F811
    """(synthetic, run id, report) of the main fixture (or a variant) staged once."""
    synthetic = prepared(runtime, **options)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
    return synthetic, run_id, report


def roots_of(root, run_id):
    scope = store.read_run_record(root, run_id)['scope']
    namespace = json.dumps([scope['accountId'], scope['libraryId'], scope['epoch']], ensure_ascii=False, separators=(',', ':'))
    return {target: json.loads(payload) for target, payload in sql(root, run_id, 'SELECT target, payload FROM edit_roots WHERE scope = ?', namespace)}


def namespace_of(root, run_id):
    scope = store.read_run_record(root, run_id)['scope']
    return json.dumps([scope['accountId'], scope['libraryId'], scope['epoch']], ensure_ascii=False, separators=(',', ':'))


def ids_of(root, run_id):
    return {(kind, tuple(json.loads(source))): target for kind, source, target in sql(
        root, run_id, 'SELECT kind, source_key, target_id FROM migration_staging_ids WHERE run_id = ?', run_id)}


def library_id_of(root, run_id):
    return store.read_run_record(root, run_id)['manifest']['libraryId']


# S-1 -----------------------------------------------------------------------------------------------------------------
def test_s1_the_main_fixture_is_staged_and_the_reasons_split_exactly(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        before = snapshot(root, device)
        report = stage(run_id)
        assert snapshot(root, device) == before
        assert_no_working_copy(root)
        assert staging.status(run_id)['state'] == 'staged'
    assert report['resolvedReasons'] == MAIN_RESOLVED
    assert report['residualReasons'] == MAIN_RESIDUAL
    assert set(report['resolvedReasons']).isdisjoint(report['residualReasons'])
    state = state_of(root, run_id)
    assert state['state'] == 'staged' and state['phase'] == 'staged' and state['complete'] is True and state['reasons'] == []
    counts = report['counts']
    expected = synthetic.expected['notebooks']
    assert counts['items'] == 4 and counts['folders'] == 2 and counts['links'] == 1 and counts['tags'] == 0
    assert counts['documents'] == {'pdf': 1, 'notebook': 2} and counts['markdown'] == 1 and counts['resources'] == 1 and counts['images'] == 0
    assert counts['pages'] == sum(item['pages'] for item in expected.values()) + 1
    assert counts['ink'] == sum(item['strokes'] for item in expected.values()) + 1
    assert counts['sticky'] == sum(item['notes'] for item in expected.values()) + 1
    assert counts['highlight'] == sum(item['highlights'] for item in expected.values())
    # The report is the sealed one: the run row names its hash and the hash is the report's own.
    assert report['reportSha256'] == sql(root, run_id, 'SELECT report_sha256 FROM migration_staging_run')[0][0]
    assert report['reportSha256'] == edit_content_hash({key: value for key, value in report.items() if key != 'reportSha256'})
    # Every reason that blocks the whole Library is accounted for exactly once; the converter's own keep-alives and the Notebooks'
    # `incomplete` codes (REVIEW-r161-b7e low 5) are residual too. The whole Library is refused in every case.
    assert [item['reason'] for item in report['accounting']] == sorted(set(MAIN_RESOLVED) | set(MAIN_RESIDUAL))
    assert {item['reason'] for item in report['accounting'] if item['status'] == 'resolved'} == set(MAIN_RESOLVED)
    assert all(item['covered'] == item['count'] for item in report['accounting'] if item['status'] == 'resolved' and item['elements'])
    assert 'uncollected-source' in report['residualReasons']


# S-2 -----------------------------------------------------------------------------------------------------------------
def test_s2_what_was_staged_equals_what_the_sources_say(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic, run_id, report = staged(runtime)
    a, b, m, p = (synthetic.ids[key] for key in 'ABMP')
    ids, roots = ids_of(root, run_id), roots_of(root, run_id)
    expected = synthetic.expected['notebooks']
    # Notebook documents: the pages and the annotation counts are the direct counts of SQLite and notebook.json.
    for notebook in (a, b):
        counts = expected[notebook]
        document = roots[ids[('notebook-document', (notebook,))]]
        assert [page['id'] for page in document['pages']] == [ids[('notebook-page', (notebook, page_id))] for page_id in counts['pageIds']]
        kinds = [annotation['kind'] for page in document['pages'] for annotation in page['annotations']]
        assert (kinds.count('ink'), kinds.count('sticky'), kinds.count('highlight')) == (counts['strokes'], counts['notes'], counts['highlights'])
    # The PDF: page count, page order and geometry are the file's (PyMuPDF on the Library's own original.pdf), the resource is that file.
    file = (root / 'papers' / p / 'original.pdf').read_bytes()
    with pymupdf.open(stream=file, filetype='pdf') as pdf:
        sizes = [(page.rect.width, page.rect.height) for page in pdf]
    document = roots[ids[('pdf-document', (p,))]]
    assert [(page['widthPt'], page['heightPt']) for page in document['pages']] == sizes
    assert [page['background']['pdfPage'] for page in document['pages']] == list(range(1, len(sizes) + 1))
    sha = direct(root, 'SELECT sha256 FROM papers WHERE id = ?', p)[0][0]
    assert hashlib.sha256(file).hexdigest() == sha
    resource = document['pages'][0]['background']['resourceId']
    assert all(page['background'] == {'kind': 'pdf', 'resourceId': resource, 'sourceRevision': sha, 'pdfPage': index}
               for index, page in enumerate(document['pages'], 1))
    assert [bytes(row[0]) for row in sql(root, run_id, 'SELECT payload FROM edit_resource_bytes')] == [file]
    annotations = [item['kind'] for page in document['pages'] for item in page['annotations']]
    assert annotations.count('ink') == 1 and annotations.count('sticky') == 1 and len(annotations) == 2
    # Markdown: the body is the row's body, byte for byte.
    content = direct(root, 'SELECT content FROM note_state WHERE id = ?', m)[0][0]
    assert roots[ids[('markdown-document', (m,))]]['content'] == content
    # The Library: every title and folder of the rows, the link, nothing else.
    library = roots[library_id_of(root, run_id)]
    assert sorted(item['title'] for item in library['items']) == sorted(title for (title,) in direct(root, 'SELECT title FROM papers'))
    assert sorted(folder['title'] for folder in library['folders']) == ['Folder', 'Sub']
    by_id = {item['id']: item for item in library['items']}
    assert [(by_id[link['pdfId']]['kind'], by_id[link['noteId']]['kind']) for link in library['links']] == [('pdf', 'notebook')]
    assert all(item['read'] is False and item['metadata'] == {} for item in library['items'])
    # One checkpoint, no edit, no control record, no batch: nothing a user could have made.
    for table in store.FORBIDDEN_ROW_TABLES:
        assert sql(root, run_id, f'SELECT COUNT(*) FROM {table}') == [(0,)]
    assert sql(root, run_id, 'SELECT COUNT(*) FROM edit_checkpoints') == [(1,)]
    assert report['counts']['resources'] == 1


# S-3 -----------------------------------------------------------------------------------------------------------------
def test_s3_every_object_has_provenance_and_the_hashes_are_the_sources(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic, run_id, report = staged(runtime)
    p, m = synthetic.ids['P'], synthetic.ids['M']
    roots, ids = roots_of(root, run_id), ids_of(root, run_id)
    library_id = library_id_of(root, run_id)
    targets = {('library', library_id)}
    for target, payload in roots.items():
        if payload['kind'] == 'document':
            targets |= {('document', target)} | {('page', page['id']) for page in payload['pages']}
            targets |= {('annotation', annotation['id']) for page in payload['pages'] for annotation in page['annotations']}
            targets |= {('resource', page['background']['resourceId']) for page in payload['pages'] if page['background']['kind'] == 'pdf'}
        elif payload['kind'] == 'markdown':
            targets.add(('markdown', target))
        else:
            targets |= {('library-item', item['id']) for item in payload['items']} | {('folder', folder['id']) for folder in payload['folders']}
            targets |= {('link', json.dumps([link['pdfId'], link['noteId']], separators=(',', ':'))) for link in payload['links']}
    rows = sql(root, run_id, 'SELECT target_kind, target_id, source_kind, source_key, source_sha256, converter_version, manifest_sha256 '
                             'FROM migration_staging_provenance')
    assert {(row[0], row[1]) for row in rows} == targets and len(rows) == len(targets)          # both directions: no more, no less
    manifest_sha = store.read_run_record(root, run_id)['manifestSha256']
    assert {(row[5], row[6]) for row in rows} == {('b7-v1', manifest_sha)}
    assert report['provenance'] == {'targets': len(targets), 'rows': len(targets)}
    by_target = {(row[0], row[1]): row for row in rows}
    # The hashes are recomputed here from the SQLite rows and from the files, not read back from the staging.
    cols = list(staging_rows.PAPER_COLUMNS)
    for paper in (p, m):
        values = direct(root, f"SELECT {', '.join(cols)} FROM papers WHERE id = ?", paper)[0]
        kind = 'pdf-document' if paper == p else 'markdown-document'
        row = by_target[('library-item', ids[(kind, (paper,))])]
        assert row[2] == 'row' and json.loads(row[3]) == ['papers', paper] and row[4] == staging_rows.source_hash('papers', cols, values)
    state = direct(root, 'SELECT id, revision, content, source, updated_at FROM note_state WHERE id = ?', m)[0]
    note_row = by_target[('markdown', ids[('markdown-document', (m,))])]
    assert note_row[4] == staging_rows.source_hash('note_state', ('id', 'revision', 'content', 'source', 'updated_at'), state)
    link = direct(root, 'SELECT a, b FROM item_links')[0]
    link_row = next(row for key, row in by_target.items() if key[0] == 'link')
    assert json.loads(link_row[3]) == ['item_links', *link] and link_row[4] == staging_rows.source_hash('item_links', ('a', 'b'), link)
    pdf_sha = direct(root, 'SELECT sha256 FROM papers WHERE id = ?', p)[0][0]
    assert by_target[('document', ids[('pdf-document', (p,))])][4] == pdf_sha
    ink = direct(root, 'SELECT paper_id, side, page, strokes FROM pdf_ink WHERE paper_id = ?', p)[0]
    bookmark = direct(root, 'SELECT * FROM bookmarks WHERE paper_id = ?', p)[0]
    columns = [row[1] for row in direct(root, 'PRAGMA table_info(bookmarks)')]
    page_row = by_target[('page', roots[ids[('pdf-document', (p,))]]['pages'][0]['id'])]
    expected = staging_rows.rows_hash([staging_rows.source_hash('pdf_ink', ('paper_id', 'side', 'page', 'strokes'), ink),
                                       staging_rows.source_hash('bookmarks', columns, bookmark)])
    assert page_row[2] == 'rows' and page_row[4] == expected
    # The Library root's own provenance is derived from the item, folder and link rows.
    derived = sorted(f'{kind}|{target}|{row[4]}' for (kind, target), row in by_target.items() if kind in ('library-item', 'folder', 'link'))
    assert by_target[('library', library_id)][2:5] == ('derived', '["library"]', edit_content_hash(derived))
    # The sealed account of the staging is the InputSet's, not a caller's claim (REVIEW-r161-b7c low 13).
    account = NativeLegacyInputs(root).read(run_id)['catalog']['identity']['accountId']
    assert store.read_run_record(root, run_id)['scope'] == {'accountId': account, 'libraryId': library_id, 'epoch': 'legacy-' + run_id}


# S-4 -----------------------------------------------------------------------------------------------------------------
def test_s4_no_old_byte_changes_and_nothing_appears_outside_the_staging_root(runtime):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        names = {path.name for path in root.parent.iterdir()}
        before = snapshot(root, device)
        stage(run_id)
        assert snapshot(root, device) == before
        assert {path.name for path in root.parent.iterdir()} - names == {store.staging_base(root).name}
        assert not edit_storage_root(root).exists() and not list(root.rglob('.analysis-*'))
        assert_no_working_copy(root)
        assert sorted(path.name for path in store.staging_folder(root, run_id).iterdir()) in (
            ['content.sqlite3'], ['content.sqlite3', 'content.sqlite3-shm', 'content.sqlite3-wal'])
    free_gate()


# S-5 -----------------------------------------------------------------------------------------------------------------
def test_s5_nothing_is_publishable_whatever_the_report_says(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
        with pytest.raises(ValueError) as error:
            staging.assert_staging_publishable(run_id)
        assert error.value.args == ('staging-not-publishable', report['residualReasons']) and report['residualReasons']
        with monkeypatch.context() as patch:
            patch.setattr(staging, 'report', lambda _run: {'residualReasons': []})            # a report with nothing left over
            with pytest.raises(ValueError) as error:
                staging.assert_staging_publishable(run_id)
            assert error.value.args == ('staging-not-publishable', [])
        with pytest.raises(ValueError) as error:                                                  # a run that was never staged
            staging.assert_staging_publishable('11111111-1111-4111-8111-111111111111')
        assert error.value.args == ('staging-not-publishable', ['staging-incomplete'])
        assert 'publishable' not in json.dumps(staging.status(run_id)) and 'accepted' not in json.dumps(report)
    assert not hasattr(store, 'PUBLISHABLE') and 'publishable' not in store.PHASES
    free_gate()


# S-6 -----------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize('name', ['root-payload', 'unit-payload', 'checkpoint-row'])
def test_s6_a_failed_verification_stops_at_assembled_and_repeats_the_same_failure(runtime, monkeypatch, name):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)

        def tamper(_token):
            namespace = namespace_of(root, run_id)
            roots = roots_of(root, run_id)
            pdf = next(payload for payload in roots.values() if payload['kind'] == 'document' and payload['pages'][0]['background']['kind'] == 'pdf')
            after = copy.deepcopy(pdf)
            page = next(page for page in after['pages'] if page['annotations'])
            page['annotations'] = [item for item in page['annotations'] if item['kind'] != 'ink']          # one ink stroke fewer
            if name == 'root-payload':
                sql(root, run_id, 'UPDATE edit_roots SET payload = ? WHERE scope = ? AND target = ?', store.canonical_json(after), namespace, pdf['id'])
            elif name == 'unit-payload':
                sql(root, run_id, 'UPDATE migration_staging_units SET payload = ? WHERE target_id = ?', store.canonical_json(after), pdf['id'])
            else:
                sql(root, run_id, 'UPDATE edit_checkpoints SET sha256 = ? WHERE scope = ?', 'f' * 64, namespace)

        with at_boundary(monkeypatch, 'verify', tamper):
            args = failing(run_id)
        assert args[0] == 'staging-verification-failed' and args[1] == ({'root-payload': ['checkpoint'], 'unit-payload': ['units'], 'checkpoint-row': ['status']}[name]), args
        state = state_of(root, run_id)
        assert state['phase'] == 'assembled' and state['complete'] is False and state['state'] != 'staged'
        assert sql(root, run_id, 'SELECT COUNT(*) FROM migration_staging_verification') == [(0,)]
        assert sql(root, run_id, 'SELECT report_sha256 FROM migration_staging_run') == [(None,)]
        free_gate()
        if name == 'checkpoint-row':                                      # the damaged checkpoint row is a diagnostic: admission itself refuses
            assert failing(run_id) == ('staging-diagnostic-required',)
        else:
            assert failing(run_id) == args                                # a second call fails the same way and changes nothing
        assert state_of(root, run_id)['phase'] == 'assembled'
        with pytest.raises(ValueError):
            staging.assert_staging_publishable(run_id)
    free_gate()


def test_s6_a_converter_plan_that_lost_an_ink_stroke_is_refused_before_anything_is_written(runtime):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)

    def drop_ink(plan):
        page = next(page for page in unit_of(plan, 'pdf')['payload']['pages'] if page['annotations'])
        page['annotations'] = [item for item in page['annotations'] if item['kind'] != 'ink']

    with TestClient(app) as client:
        run_id = capture_live(client)
        args = failing(run_id, tampering(drop_ink))
        assert args[0] == 'staging-plan-rejected' and 'pdf-annotations' in args[1]
        assert staging.status(run_id)['state'] == 'absent' and not store.staging_base(root).exists()
    free_gate()


# S-7 -----------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize('kind', ['annotation', 'page', 'resource', 'library-item', 'document'])
def test_s7_a_missing_provenance_row_is_refused(runtime, monkeypatch, kind):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with at_boundary(monkeypatch, 'verify', lambda _token: sql(
                root, run_id, 'DELETE FROM migration_staging_provenance WHERE rowid = (SELECT MIN(rowid) FROM migration_staging_provenance '
                              'WHERE target_kind = ?)', kind)):
            args = failing(run_id)
        assert args[0] == 'staging-provenance-incomplete' and 'provenance-targets' in args[1], args
        assert state_of(root, run_id)['phase'] == 'assembled'
    free_gate()


def test_s7_an_extra_a_wrong_and_a_foreign_provenance_row_are_refused_too(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with at_boundary(monkeypatch, 'verify', lambda _token: sql(
                root, run_id, 'INSERT INTO migration_staging_provenance SELECT run_id, ?, ?, source_kind, source_key, source_sha256, converter_version, '
                              'manifest_sha256 FROM migration_staging_provenance LIMIT 1', 'page', 'extra-target-that-is-no-object')):
            args = failing(run_id)
        assert args[0] == 'staging-provenance-incomplete' and 'provenance-targets' in args[1], args
        free_gate()
        sql(root, run_id, "DELETE FROM migration_staging_provenance WHERE target_id = 'extra-target-that-is-no-object'")
        sql(root, run_id, "UPDATE migration_staging_provenance SET source_sha256 = ? WHERE rowid = (SELECT MIN(rowid) FROM "
                          "migration_staging_provenance WHERE target_kind = 'library-item')", 'e' * 64)
        args = failing(run_id)
        assert args[0] == 'staging-provenance-incomplete' and 'provenance-source-library-item' in args[1], args
        free_gate()
        sql(root, run_id, "UPDATE migration_staging_provenance SET source_sha256 = (SELECT source_sha256 FROM migration_staging_provenance WHERE "
                          "target_kind = 'library-item' AND rowid != (SELECT MIN(rowid) FROM migration_staging_provenance WHERE target_kind = 'library-item') LIMIT 1) "
                          "WHERE rowid = (SELECT MIN(rowid) FROM migration_staging_provenance WHERE target_kind = 'library-item')")
        sql(root, run_id, "UPDATE migration_staging_provenance SET converter_version = 'b7-v0' WHERE rowid = (SELECT MIN(rowid) FROM migration_staging_provenance)")
        args = failing(run_id)
        assert args[0] == 'staging-provenance-incomplete' and 'provenance-header' in args[1], args
    free_gate()


# S-8 -----------------------------------------------------------------------------------------------------------------
def test_s8_changed_resource_bytes_are_refused(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with at_boundary(monkeypatch, 'verify', lambda _token: sql(root, run_id, 'UPDATE edit_resource_bytes SET payload = ?', b'%PDF-1.4 not the original')):
            args = failing(run_id)
        assert args[0] == 'staging-verification-failed' and 'resource-bytes' in args[1], args
        assert state_of(root, run_id)['phase'] == 'assembled'
    free_gate()


def test_s8_a_plan_that_names_another_file_for_a_resource_is_refused_before_anything_is_written(runtime):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)

    def other_hash(plan):
        plan['resources'][0]['sha256'] = '0' * 64

    with TestClient(app) as client:
        run_id = capture_live(client)
        args = failing(run_id, tampering(other_hash))
        assert args[0] == 'staging-plan-rejected', args
        assert staging.status(run_id)['state'] == 'absent'
    free_gate()


# S-9 -----------------------------------------------------------------------------------------------------------------
def test_s9_a_note_the_converter_blocked_is_reported_and_keeps_its_reasons(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    m = synthetic.ids['M']
    synthetic.sql(('UPDATE note_state SET content = ? WHERE id = ?', ('# a body that note.md does not have\n', m)))       # the mirror differs
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
    kinds = [(item['kind'], item['reason'], item['residual']) for item in report['notConverted']]
    assert ('markdown', 'markdown-mirror-mismatch', 'markdown-conversion-blocked') in kinds
    assert 'markdown-conversion-blocked' in report['residualReasons']
    assert 'markdown-not-converted' in report['residualReasons'] and 'markdown-not-converted' not in report['resolvedReasons']       # its rows are not covered
    assert report['counts']['markdown'] == 0 and report['counts']['items'] == 3
    assert not [payload for payload in roots_of(root, run_id).values() if payload['kind'] == 'markdown']
    assert set(report['resolvedReasons']) == set(MAIN_RESOLVED) - {'markdown-not-converted'}


# S-10 ----------------------------------------------------------------------------------------------------------------
def test_s10_a_translated_side_row_keeps_pdf_annotation_residual(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    p = synthetic.ids['P']
    synthetic.sql(("INSERT INTO pdf_ink VALUES(?, 'translated', 1, ?)", (p, json.dumps([{'id': 't1', 'color': '#000000', 'width': .01, 'points': [[.1, .2], [.3, .4]]}]))))
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
    assert 'pdf-annotation-not-converted' in report['residualReasons'] and 'pdf-annotation-not-converted' not in report['resolvedReasons']
    assert [(item['reason'], item['count']) for item in report['notConverted'] if item['kind'] == 'pdf-annotation'] == [('pdf-annotation-translated-side', 1)]
    assert report['counts']['ink'] == 6 and 'pdf-document-not-converted' in report['resolvedReasons']       # the original side is still converted


def test_s10_an_image_note_is_converted_with_its_resource(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    m = synthetic.ids['M']
    png = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 2, 2), False)
    png.clear_with(200)
    data = png.tobytes('png')
    content = '# memo\n![capture](media/ink-capture-1.png)\n'
    synthetic.sql(('UPDATE note_state SET content = ? WHERE id = ?', (content, m)))
    (root / 'papers' / m / 'media').mkdir(parents=True, exist_ok=True)
    (root / 'papers' / m / 'media' / 'ink-capture-1.png').write_bytes(data)
    (root / 'papers' / m / 'note.md').write_bytes(content.encode('utf-8'))
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
    assert report['counts']['images'] == 1 and report['counts']['resources'] == 2 and 'markdown-not-converted' in report['resolvedReasons']
    note = next(payload for payload in roots_of(root, run_id).values() if payload['kind'] == 'markdown')
    assert [image['sha256'] for image in note['imageResources']] == [hashlib.sha256(data).hexdigest()]
    assert [bytes(row[0]) for row in sql(root, run_id, 'SELECT payload FROM edit_resource_bytes') if len(row[0]) == len(data)] == [data]


def test_s10_a_legacy_citation_link_keeps_markdown_residual(runtime):  # noqa: F811
    """REVIEW-r161-b7e low 10: the body is converted, the link stays text, and the reason is NOT resolved."""
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    m, p = synthetic.ids['M'], synthetic.ids['P']
    content = f'# memo\nsee [page 1](papeer://{p}/1)\n'
    synthetic.sql(('UPDATE note_state SET content = ? WHERE id = ?', (content, m)))
    (root / 'papers' / m / 'note.md').write_bytes(content.encode('utf-8'))
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
    assert report['counts']['markdown'] == 1 and 'markdown-not-converted' in report['residualReasons'] and 'markdown-not-converted' not in report['resolvedReasons']
    assert [(item['reason'], item['count']) for item in report['notConverted'] if item['kind'] == 'markdown-link'] == [('markdown-legacy-links-retained', 1)]


@pytest.mark.parametrize('title', ['', 'x' * 201])
def test_s10_an_item_the_library_cannot_hold_is_not_in_the_library_and_its_reasons_stay(runtime, title):  # noqa: F811
    """REVIEW-r161-b7e low 1: a converted content the Library dropped covers nothing (`not-in-library`)."""
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    p = synthetic.ids['P']
    synthetic.sql(('UPDATE papers SET title = ? WHERE id = ?', (title, p)))
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
    assert report['counts']['items'] == 3 and report['counts']['documents'] == {'pdf': 0, 'notebook': 2} and report['counts']['resources'] == 0
    assert ('item', 'title-unrepresentable', 'library-item-not-converted') in [(i['kind'], i['reason'], i['residual']) for i in report['notConverted']]
    assert 'library-item-not-converted' in report['residualReasons']
    assert 'pdf-document-not-converted' in report['residualReasons'] and 'pdf-annotation-not-converted' in report['residualReasons']
    assert 'item-link-not-converted' in report['residualReasons']                    # the link's PDF end is gone
    assert not [payload for payload in roots_of(root, run_id).values() if payload['kind'] == 'document' and payload['pages'][0]['background']['kind'] == 'pdf']


def test_s10_a_note_owned_by_a_pdf_keeps_its_owner(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    m, p = synthetic.ids['M'], synthetic.ids['P']
    synthetic.sql(('UPDATE papers SET parent_id = ? WHERE id = ?', (p, m)))
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
    ids = ids_of(root, run_id)
    library = roots_of(root, run_id)[library_id_of(root, run_id)]
    owned = next(item for item in library['items'] if item['id'] == ids[('markdown-document', (m,))])
    assert owned['ownerId'] == ids[('pdf-document', (p,))] and owned['folderId'] is None
    assert report['counts']['items'] == 4


# S-11 ----------------------------------------------------------------------------------------------------------------
def test_s11_a_staged_run_called_again_writes_nothing_and_answers_the_same_report(runtime):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        first = stage(run_id)
        main = db_path(root, run_id)
        before = (main.read_bytes(), main.stat().st_mtime_ns)

        def never(_data):
            raise AssertionError('a staged run is not converted again')

        second = stage(run_id, never)
        assert second == first and staging.report(run_id) == first
        assert (main.read_bytes(), main.stat().st_mtime_ns) == before                        # the database file itself is untouched
        assert staging.status(run_id)['complete'] is True
    free_gate()


# S-12 ----------------------------------------------------------------------------------------------------------------
STAGE_STATE = {'gather': ('absent', None), 'descriptors': ('absent', None), 'convert': ('absent', None), 'validate': ('absent', None),
               'initialize': ('absent', None), 'resource': ('resumable', 'initialized'), 'plan': ('resumable', 'resources'),
               'unit': ('resumable', 'planned'), 'assemble': ('resumable', 'units'), 'verify': ('resumable', 'assembled'),
               'seal': ('resumable', 'verified')}


@pytest.mark.parametrize('stage_name', sorted(STAGE_STATE))
def test_s12_a_cancel_at_each_boundary_stops_there(runtime, monkeypatch, stage_name):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with at_boundary(monkeypatch, stage_name, lambda token: token.cancel.set()):
            args = failing(run_id)
        state = state_of(root, run_id)
    assert args == ('staging-cancelled',), args
    assert (state['state'], state['phase']) == STAGE_STATE[stage_name], state
    free_gate()
    assert not list(root.rglob('.analysis-*'))
    assert_no_working_copy(root)


def test_s12_a_timeout_cancels_the_worker_and_the_gate_is_given_back(runtime):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)

        def slow(data):
            while not preview_gate.gate._token.cancel.wait(.05):
                pass
            return bridge(data)

        with pytest.raises(ValueError) as error:
            staging.build(run_id, slow, timeout=.3)
        assert error.value.args == ('staging-cancelled',)
        assert preview_gate.gate.wait_idle(60)
        assert state_of(root, run_id)['state'] == 'absent'


# S-13 ----------------------------------------------------------------------------------------------------------------
def test_s13_the_report_carries_no_content_path_or_exception_text_and_the_peer_stays_in_the_run_row(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime, folder_sync_state=True)
    p = synthetic.ids['P']
    synthetic.sql(('UPDATE papers SET title = ? WHERE id = ?', ('', p)))             # something not converted, with a folder key in the report
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
        peer = store.read_run_record(root, run_id)['manifest']['peerId']
    text = json.dumps(report, ensure_ascii=False)
    for forbidden in (*SENTINELS, 'Synthetic', 'Folder', str(root), str(device), str(root.parent), root.name, peer, synthetic.library_key, 'Traceback', 'Error'):
        assert forbidden not in text, forbidden
    # The peer of the preparation is only in the run row's manifest column (REVIEW-r161-b7c low 14): nowhere else of the staging.
    with closing(sqlite3.connect(db_path(root, run_id))) as db:
        for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall():
            for row in db.execute(f'SELECT * FROM "{table}"').fetchall():
                blob = json.dumps([item.hex() if isinstance(item, bytes) else item for item in row], default=str)
                assert (peer in blob) == (table == 'migration_staging_run'), table
                assert synthetic.library_key not in blob and str(device) not in blob, table
    free_gate()


def test_s13_a_notebook_less_folder_is_named_by_a_hash_in_the_report(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    synthetic.sql(("INSERT INTO collections(name) VALUES('x/' || ?)", ('y' * 250,)))         # a folder title the Library cannot hold (over 200)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
    folders = [item for item in report['notConverted'] if item['kind'] == 'folder']
    assert folders and all(item['sourceKey'][0] == 'folder' and len(item['sourceKey'][1]) == 64 for item in folders)
    assert 'folder-not-converted' in report['residualReasons'] and 'yyyy' not in json.dumps(report)


def test_s13_refusal_details_are_closed_codes(runtime):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)

    def retitle(plan):
        library = unit_of(plan, 'library')['payload']
        library['items'][0]['title'] = 'SENTINEL-NOTE a title the rows do not have'

    with TestClient(app) as client:
        run_id = capture_live(client)
        args = failing(run_id, tampering(retitle))
    assert args[0] == 'staging-plan-rejected' and args[1] == ['library']
    text = json.dumps(args)
    assert 'SENTINEL' not in text and str(root) not in text
    free_gate()


# S-14 ----------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize('error', [KeyError('secret-key'), TypeError('secret text'), RuntimeError('C:/secret/path'), OSError(2, 'secret')],
                         ids=['key', 'type', 'runtime', 'os'])
def test_s14_an_unexpected_exception_is_wrapped_and_never_echoed(runtime, error):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)

    def boom(_data):
        raise error

    with TestClient(app) as client:
        run_id = capture_live(client)
        args = failing(run_id, boom)
        assert args == ('staging-unavailable',) and state_of(root, run_id)['state'] == 'absent'
    free_gate()


def test_s14_an_unexpected_exception_in_a_later_stage_keeps_the_phase_and_gives_the_gate_back(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with monkeypatch.context() as patch:
            patch.setattr(store, 'put_plan', lambda *args, **kwargs: (_ for _ in ()).throw(KeyError('C:/secret')))        # the plan's own transaction (work B7-g: `_plan_row` is made before anything is written)
            args = failing(run_id)
        assert args == ('staging-unavailable',)
        assert state_of(root, run_id)['phase'] == 'resources' and not list(root.rglob('.analysis-*'))
    free_gate()


# boundaries of this unit ---------------------------------------------------------------------------------------------
def test_a_staging_before_assembly_is_resumed_by_the_second_call(runtime, monkeypatch):  # noqa: F811
    """Work B7-g (it was `staging-state-unavailable` in B7-f): the second call continues the run; the whole matrix is `test_native_staging_resume.py`."""
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with at_boundary(monkeypatch, 'unit', lambda token: token.cancel.set()):
            assert failing(run_id) == ('staging-cancelled',)
        free_gate()
        assert state_of(root, run_id)['phase'] == 'planned'
        report = stage(run_id)
        assert report['residualReasons'] == MAIN_RESIDUAL and state_of(root, run_id)['phase'] == 'staged'
    free_gate()


def test_a_verified_staging_is_sealed_by_the_second_call_without_converting_again(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with at_boundary(monkeypatch, 'seal', lambda token: token.cancel.set()):
            assert failing(run_id) == ('staging-cancelled',)
        assert state_of(root, run_id)['phase'] == 'verified'
        free_gate()

        def never(_data):
            raise AssertionError('not converted again')

        report = stage(run_id, never)
        assert report['residualReasons'] == MAIN_RESIDUAL and state_of(root, run_id)['phase'] == 'staged'
    free_gate()


def test_a_cold_run_is_staged_too(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        to_cold(monkeypatch)
        report = stage(run_id)
    assert report['resolvedReasons'] == MAIN_RESOLVED and report['residualReasons'] == MAIN_RESIDUAL
    free_gate()


def test_a_database_whose_rows_cannot_be_listed_stages_nothing(runtime, monkeypatch):  # noqa: F811
    """REVIEW-r161-b6c low 4 / b7d: nothing can be staged from rows that cannot be read; the refusal is closed and nothing is created."""
    root, device, _lock = runtime
    prepared(runtime)
    real = staging.extract_staging_rows
    with TestClient(app) as client:
        run_id = capture_live(client)
        with monkeypatch.context() as patch:
            patch.setattr(staging, 'extract_staging_rows', lambda *args, **kwargs: {**real(*args, **kwargs), 'listable': False, 'rows': None})
            assert failing(run_id) == ('staging-rows-not-listable',)
        assert staging.status(run_id)['state'] == 'absent' and not store.staging_base(root).exists()
    free_gate()


def test_too_little_free_space_is_refused_before_anything_is_created(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with monkeypatch.context() as patch:
            # only the name inside the writer's module: the backup's own free-space check (shutil.disk_usage) must not be what refuses here
            patch.setattr(staging, 'shutil', SimpleNamespace(disk_usage=lambda _path: shutil._ntuple_diskusage(10, 9, 1)))
            assert failing(run_id) == ('staging-disk-insufficient',)
        assert not store.staging_base(root).exists()
    free_gate()


def test_the_closed_wal_variant_follows_the_hand_over_of_work_b7_a(runtime):  # noqa: F811
    """B7-a low 8 (a): `sqlite-wal-closed` is a supported fact, not a reason, so a closed WAL Library stages like the main one."""
    root, device, _lock = runtime
    prepared(runtime, wal_closed=True)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
    assert report['resolvedReasons'] == MAIN_RESOLVED and report['residualReasons'] == MAIN_RESIDUAL and 'sqlite-wal-closed' not in json.dumps(report)


def test_a_web_annotation_ledger_keeps_its_reasons_and_withholds_the_strokes(runtime):  # noqa: F811
    """B7-a low 8 (a): `web-annotation-ops-not-converted` is retained-blocking and is never resolved (B7-e 1.6)."""
    root, device, _lock = runtime
    prepared(runtime, glossary_tables=True)
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
    assert 'web-annotation-ops-not-converted' in report['residualReasons'] and 'library-metadata-not-converted' in report['residualReasons']
    assert 'pdf-annotation-not-converted' in report['residualReasons'] and 'notebook-projection-blocked' in report['residualReasons']
    assert 'pdf-document-not-converted' in report['resolvedReasons'] and report['counts']['documents'] == {'pdf': 1, 'notebook': 0}
    assert report['counts']['ink'] == 0 and report['counts']['sticky'] == 0
    assert 'pdf-annotation-web-ops-present' in {item['reason'] for item in report['notConverted']}


def test_the_plan_is_checked_against_independent_numbers_for_these_tampered_plans(runtime):  # noqa: F811
    """E-3 in a cheaper form (work B7-h repeats it through the whole round trip): each edit keeps every hash consistent."""
    root, device, _lock = runtime
    prepared(runtime)

    def drop_link(plan):
        unit_of(plan, 'library')['payload']['links'] = []

    def reverse_pages(plan):
        document = unit_of(plan, 'notebook')['payload']
        document['pages'] = list(reversed(document['pages']))

    def wrong_header(plan):
        plan['libraryId'] = '11111111-1111-4111-8111-111111111111'

    def change_content(plan):
        unit_of(plan, 'markdown')['payload']['content'] += 'tail'

    def drop_provenance(plan):
        plan['provenance'] = [row for row in plan['provenance'] if row['targetKind'] != 'folder']

    def wrong_source_hash(plan):
        row = next(row for row in plan['provenance'] if row['targetKind'] == 'markdown')
        row['sourceSha256'] = 'a' * 64

    def folder_title(plan):
        unit_of(plan, 'library')['payload']['folders'][0]['title'] = 'Elsewhere'

    expected = {'drop_link': 'library', 'reverse_pages': 'notebook', 'wrong_header': 'plan-shape', 'change_content': 'markdown',
                'drop_provenance': 'provenance-targets', 'wrong_source_hash': 'provenance-source-markdown', 'folder_title': 'library'}
    with TestClient(app) as client:
        run_id = capture_live(client)
        for edit in (drop_link, reverse_pages, wrong_header, change_content, drop_provenance, wrong_source_hash, folder_title):
            args = failing(run_id, tampering(edit))
            assert args[0] == 'staging-plan-rejected' and expected[edit.__name__] in args[1], (edit.__name__, args)
            assert state_of(root, run_id)['state'] == 'absent'
            free_gate()
        assert not store.staging_base(root).exists()


def test_the_closed_reason_of_a_refusal_survives_only_with_closed_codes_and_row_codes_are_mapped():
    assert staging.reason_of(ValueError('staging-plan-rejected', ['library', 'pdf-annotations'])) == 'staging-plan-rejected'
    assert staging.reason_of(ValueError('staging-plan-rejected', ['C:/secret path'])) == 'staging-unavailable'       # a detail that is not a code
    assert staging.reason_of(ValueError('staging-plan-rejected', 'library')) == 'staging-unavailable'
    assert staging.reason_of(ValueError('staging-not-a-reason')) == 'staging-unavailable'
    assert staging.reason_of(ValueError('staging-rows-cancelled')) == 'staging-cancelled'                  # REVIEW-r161-b7d low 2
    assert staging.reason_of(ValueError('staging-rows-capacity-exceeded')) == 'staging-capacity-exceeded'
    assert staging.reason_of(ValueError('staging-rows-copy-changed')) == 'staging-source-changed'
    assert staging.reason_of(ValueError('staging-rows-count-mismatch')) == 'staging-unavailable'
    assert staging.reason_of(KeyError('x')) == 'staging-unavailable' and staging.reason_of(ValueError('a', 'b', 'c')) == 'staging-unavailable'


def test_a_closed_row_extraction_code_reaches_the_caller_as_a_staging_reason(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)

    def too_big(*_args, **_kwargs):
        raise ValueError('staging-rows-capacity-exceeded')

    with TestClient(app) as client:
        run_id = capture_live(client)
        with monkeypatch.context() as patch:
            patch.setattr(staging, 'extract_staging_rows', too_big)
            assert failing(run_id) == ('staging-capacity-exceeded',)
        assert state_of(root, run_id)['state'] == 'absent'
    free_gate()


def test_nothing_in_the_product_calls_the_writer_or_the_accounting():
    """Decision J1: the converters, the writer and the accounting are reached from tests only (no route, CLI or start-up code)."""
    import re
    from pathlib import Path
    repo = Path(__file__).resolve().parents[3]
    pattern = re.compile(r'legacy_staging_accounting|migrations\.staging|from \. import[^\n]*\bstaging\b|from \.staging import|from sidecar\.migrations import[^\n]*\bstaging\b')
    found = []
    for folder in ('papeer', 'sidecar', 'tools'):
        for path in sorted((repo / folder).rglob('*.py')):
            if path.name in ('staging.py', 'legacy_staging_accounting.py'):
                continue
            if pattern.search(path.read_text('utf-8')):
                found.append(path.relative_to(repo).as_posix())
    assert found == [], found
    from fastapi.routing import APIRoute
    assert not [route.path for route in app.routes if isinstance(route, APIRoute) and 'staging' in route.path]


def test_s9_a_pdf_the_converter_blocked_keeps_every_reason_it_raised(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    p = synthetic.ids['P']
    synthetic.sql(('UPDATE papers SET pages = 2 WHERE id = ?', (p,)))                      # the page count of the row is not the file's
    with TestClient(app) as client:
        run_id = capture_live(client)
        report = stage(run_id)
    assert ('pdf', 'pdf-page-count-mismatch', 'pdf-conversion-blocked') in [(i['kind'], i['reason'], i['residual']) for i in report['notConverted']]
    for reason in ('pdf-conversion-blocked', 'pdf-document-not-converted', 'pdf-annotation-not-converted', 'item-link-not-converted'):
        assert reason in report['residualReasons'] and reason not in report['resolvedReasons'], reason
    assert report['counts']['documents'] == {'pdf': 0, 'notebook': 2} and report['counts']['resources'] == 0 and report['counts']['items'] == 3
    assert report['resolvedReasons'] == ['folder-not-converted', 'markdown-not-converted']
    assert sql(root, run_id, 'SELECT COUNT(*) FROM edit_resource_bytes') == [(0,)]


# the independent checks, one staged run, many differences ---------------------------------------------------------------
def captured(runtime, monkeypatch, **options):  # noqa: F811
    """Stage the main fixture (or a variant) once and keep what the verification was handed: the read-back `model`, the writer's own
    `facts`, and the arguments of the accounting. The checks are then run again on edited copies (milliseconds each, no node)."""
    seen = {}
    real_check, real_account = staging.accounting.check_conversion, staging.accounting.account

    def check(model, facts):
        seen['model'], seen['facts'] = model, facts
        return real_check(model, facts)

    def account(manifest, report, model, facts, *, plan_residual):
        seen['account'] = (manifest, report, model, facts, plan_residual)
        return real_account(manifest, report, model, facts, plan_residual=plan_residual)

    synthetic = prepared(runtime, **options)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with monkeypatch.context() as patch:
            patch.setattr(staging.accounting, 'check_conversion', check)
            patch.setattr(staging.accounting, 'account', account)
            report = stage(run_id)
    free_gate()
    return synthetic, report, seen


def edited(seen, edit):
    model, facts = copy.deepcopy(seen['model']), copy.deepcopy(seen['facts'])
    edit(model, facts)
    return staging.accounting.check_conversion(model, facts)


def payload_of(model, kind, *, pdf=None):
    for unit in model['units']:
        if unit['unitKind'] == kind and (pdf is None or (unit['payload']['pages'][0]['background']['kind'] == 'pdf') == pdf):
            return unit['payload']
    raise KeyError(kind)


def test_every_independent_check_sees_its_own_difference(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    synthetic, report, seen = captured(runtime, monkeypatch)
    assert edited(seen, lambda model, facts: None) == {'verification': [], 'provenance': []}                      # control: the read-back is clean

    def pdf_page(model, facts):
        payload_of(model, 'document', pdf=True)['pages'][0]['widthPt'] += 5

    def pdf_background(model, facts):
        payload_of(model, 'document', pdf=True)['pages'][0]['background']['sourceRevision'] = 'f' * 64

    def pdf_ink(model, facts):
        page = payload_of(model, 'document', pdf=True)['pages'][0]
        page['annotations'] = [item for item in page['annotations'] if item['kind'] != 'ink']

    def pdf_sticky_extra(model, facts):
        page = payload_of(model, 'document', pdf=True)['pages'][0]
        page['annotations'].append({**next(item for item in page['annotations'] if item['kind'] == 'sticky'), 'id': '00000000-0000-4000-8000-0000000000aa'})

    def pdf_resource_pages(model, facts):
        model['resources'][0]['pdfPages'] = model['resources'][0]['pdfPages'] + model['resources'][0]['pdfPages']

    def notebook_sticky(model, facts):
        for unit in model['units']:
            if unit['unitKind'] == 'document' and unit['payload']['pages'][0]['background']['kind'] != 'pdf':
                for page in unit['payload']['pages']:
                    if any(item['kind'] == 'sticky' for item in page['annotations']):
                        page['annotations'] = [item for item in page['annotations'] if item['kind'] != 'sticky']
                        return

    def notebook_pages(model, facts):
        for unit in model['units']:
            if unit['unitKind'] == 'document' and unit['payload']['pages'][0]['background']['kind'] != 'pdf':
                unit['payload']['pages'].reverse()
                return

    def markdown_body(model, facts):
        payload_of(model, 'markdown')['content'] += 'x'

    def markdown_state(model, facts):
        next(iter(facts['markdown'].values()))['mirror'] = 'mismatch'

    def library(field, value):
        def edit(model, facts):
            item = payload_of(model, 'library')['items'][0]
            item[field] = value(item) if callable(value) else value
        return edit

    def library_positions(model, facts):
        for item in payload_of(model, 'library')['items']:
            item['position'] = 7

    def library_folder(model, facts):
        payload_of(model, 'library')['folders'][0]['title'] = 'Elsewhere'

    def library_folder_parent(model, facts):
        folders = payload_of(model, 'library')['folders']
        child = next(folder for folder in folders if folder['parentId'] is not None)
        child['parentId'] = None

    def library_links(model, facts):
        payload_of(model, 'library')['links'] = []

    def library_link_extra(model, facts):
        link = payload_of(model, 'library')['links'][0]
        payload_of(model, 'library')['links'].append({'pdfId': link['noteId'], 'noteId': link['pdfId']})

    def library_deletions(model, facts):
        payload_of(model, 'library')['deletions'] = [{'id': '00000000-0000-4000-8000-0000000000bb', 'kind': 'pdf'}]

    def library_resource(model, facts):
        for item in payload_of(model, 'library')['items']:
            if item['kind'] == 'pdf':
                item['resourceId'] = '00000000-0000-4000-8000-0000000000cc'

    def unit_gap(model, facts):
        model['units'][1]['seq'] = 9

    def unit_dropped(model, facts):
        model['units'] = [unit for unit in model['units'] if unit['unitKind'] != 'markdown']

    def unit_duplicated(model, facts):
        model['units'].append(copy.deepcopy(model['units'][0]))
        model['units'][-1]['seq'] = len(model['units']) - 1

    def ids_collision(model, facts):
        entry = model['ids'][0]
        model['ids'].append({'kind': entry['kind'], 'source': entry['source'], 'targetId': '00000000-0000-4000-8000-0000000000dd'})

    def ids_target_collision(model, facts):
        model['ids'].append({'kind': 'other-kind', 'source': ['x'], 'targetId': model['ids'][0]['targetId']})

    def swap_resource_id(model, facts):
        old = model['resources'][0]['id']
        text = json.dumps({key: model[key] for key in ('units', 'ids', 'provenance', 'resources')}).replace(old, '00000000-0000-4000-8000-0000000000ee')
        model.update(json.loads(text))

    def resource_sha(model, facts):
        model['resources'][0]['sha256'] = '0' * 64

    def resource_size(model, facts):
        model['resources'][0]['byteLength'] += 1

    def resource_type(model, facts):
        model['resources'][0]['mediaType'] = 'application/octet-stream'

    def resource_extra(model, facts):
        model['resources'].append({**model['resources'][0], 'id': '00000000-0000-4000-8000-0000000000ff'})

    def entry_changed(model, facts):
        for entry in facts['entries'].values():
            if entry['key'][-1] == 'original.pdf':
                entry['sha256'] = '1' * 64

    def coverage(status):
        def edit(model, facts):
            model['coverage'][0]['status'] = status
        return edit

    def coverage_missing(model, facts):
        model['coverage'] = model['coverage'][1:]

    def coverage_unknown(model, facts):
        model['coverage'][0]['sourceKey'] = ['papers', 'f' * 32]

    def web_ledger(model, facts):
        facts['webOps'] = 1

    def web_unknown(model, facts):
        facts['webOps'] = None

    def title_row(model, facts):
        next(item for item in facts['items'].values() if item['kind'] == 'pdf')['columns']['title'] = 'Another'

    def not_converted_missing(model, facts):
        model['coverage'][0]['status'] = 'blocked'
        model['coverage'][0]['reason'] = 'a-reason-nothing-reported'

    def provenance_row(kind, field, value, *, source_kind=None):
        def edit(model, facts):
            row = next(row for row in model['provenance'] if row['targetKind'] == kind and (source_kind is None or row['sourceKind'] == source_kind))
            row[field] = value
        return edit

    def provenance_drop(kind):
        def edit(model, facts):
            row = next(row for row in model['provenance'] if row['targetKind'] == kind)
            model['provenance'].remove(row)
        return edit

    def provenance_duplicate(model, facts):
        model['provenance'].append(copy.deepcopy(model['provenance'][0]))

    def provenance_extra(model, facts):
        model['provenance'].append({**model['provenance'][0], 'targetId': 'not-an-object'})

    def provenance_link_key(model, facts):
        next(row for row in model['provenance'] if row['targetKind'] == 'link')['sourceKey'] = ['item_links', 'a' * 32, 'b' * 32]

    def resource_dropped(model, facts):
        model['resources'] = []

    def translated_unreported(model, facts):
        next(iter(facts['pdfs'].values()))['counts']['ink']['other'] = 1

    def second_page(model, facts):
        """A two-page PDF whose only ink row is on page 2 while the staged ink is on page 1: the totals agree, the pages do not."""
        document = payload_of(model, 'document', pdf=True)
        page = copy.deepcopy(document['pages'][0])
        page.update(id='00000000-0000-4000-8000-0000000000a1', annotations=[])
        page['background']['pdfPage'] = 2
        document['pages'].append(page)
        model['resources'][0]['pdfPages'] = model['resources'][0]['pdfPages'] * 2
        pdf = next(iter(facts['pdfs'].values()))
        pdf['pagesColumn'], pdf['counts']['pageRows'], pdf['pageNumbers'] = 2, 2, [1, 2]
        for row in pdf['inkRows']:
            if row['side'] == 'original':
                row['page'] = 2

    def folder_parent_lost(model, facts):
        folders = payload_of(model, 'library')['folders']
        child = next(folder for folder in folders if folder['parentId'] is not None)
        child['parentId'], child['position'] = None, 1                  # a valid snapshot: only the folder's own parent is wrong

    cases = {
        'resource-dropped': (resource_dropped, 'verification', 'resources'),
        'translated-rows-unreported': (translated_unreported, 'verification', 'pdf-annotations'),
        'pdf-second-page-ink': (second_page, 'verification', 'pdf-annotations'),
        'library-folder-parent-lost': (folder_parent_lost, 'verification', 'library'),
        'unit-dropped-library-code': (unit_dropped, 'verification', 'library'),
        'pdf-page-width': (pdf_page, 'verification', 'pdf-geometry'), 'pdf-background': (pdf_background, 'verification', 'pdf-geometry'),
        'pdf-ink-lost': (pdf_ink, 'verification', 'pdf-annotations'), 'pdf-sticky-extra': (pdf_sticky_extra, 'verification', 'pdf-annotations'),
        'pdf-resource-pages': (pdf_resource_pages, 'verification', 'pdf-document'),
        'notebook-sticky-lost': (notebook_sticky, 'verification', 'notebook'), 'notebook-page-order': (notebook_pages, 'verification', 'notebook'),
        'markdown-body': (markdown_body, 'verification', 'markdown'), 'markdown-mirror': (markdown_state, 'verification', 'markdown'),
        'library-title': (library('title', 'Elsewhere'), 'verification', 'library'), 'library-tags': (library('tags', ['x']), 'verification', 'library'),
        'library-read': (library('read', True), 'verification', 'library'), 'library-metadata': (library('metadata', {'a': 1}), 'verification', 'library'),
        'library-owner': (library('ownerId', '00000000-0000-4000-8000-000000000001'), 'verification', 'library'),
        'library-folder-of-item': (library('folderId', '00000000-0000-4000-8000-000000000002'), 'verification', 'library'),
        'library-kind': (library('kind', lambda item: 'markdown' if item['kind'] != 'markdown' else 'notebook'), 'verification', 'library'),
        'library-positions': (library_positions, 'verification', 'library'), 'library-folder-title': (library_folder, 'verification', 'library'),
        'library-folder-parent': (library_folder_parent, 'verification', 'library'), 'library-links-lost': (library_links, 'verification', 'library'),
        'library-link-extra': (library_link_extra, 'verification', 'library'), 'library-deletions': (library_deletions, 'verification', 'library'),
        'library-pdf-resource': (library_resource, 'verification', 'library'),
        'unit-seq-gap': (unit_gap, 'verification', 'units'), 'unit-dropped': (unit_dropped, 'verification', 'id-set'),
        'unit-duplicated': (unit_duplicated, 'verification', 'id-set'),
        'ids-same-source': (ids_collision, 'verification', 'ids-table'), 'ids-same-target': (ids_target_collision, 'verification', 'ids-table'),
        'resource-id-formula': (swap_resource_id, 'verification', 'resources'), 'resource-sha': (resource_sha, 'verification', 'resources'),
        'resource-size': (resource_size, 'verification', 'resources'), 'resource-media-type': (resource_type, 'verification', 'resources'),
        'resource-extra': (resource_extra, 'verification', 'resources'), 'backup-entry-changed': (entry_changed, 'verification', 'resources'),
        'coverage-not-in-library': (coverage('not-in-library'), 'verification', 'id-set'), 'coverage-blocked': (coverage('blocked'), 'verification', 'id-set'),
        'coverage-missing': (coverage_missing, 'verification', 'id-set'), 'coverage-unknown': (coverage_unknown, 'verification', 'id-set'),
        'coverage-without-a-reason': (not_converted_missing, 'verification', 'id-set'),
        'web-ledger': (web_ledger, 'verification', 'pdf-annotations'), 'web-ledger-unknown': (web_unknown, 'verification', 'pdf-annotations'),
        'row-title': (title_row, 'verification', 'library'),
        'provenance-annotation-hash': (provenance_row('annotation', 'sourceSha256', 'b' * 64), 'provenance', 'provenance-source-annotation'),
        'provenance-page-rows': (provenance_row('page', 'sourceSha256', 'c' * 64, source_kind='rows'), 'provenance', 'provenance-source-page'),
        'provenance-page-file': (provenance_row('page', 'sourceSha256', 'c' * 64, source_kind='file'), 'provenance', 'provenance-source-page'),
        'provenance-resource-hash': (provenance_row('resource', 'sourceSha256', 'c' * 64), 'provenance', 'provenance-source-resource'),
        'provenance-document-key': (provenance_row('document', 'sourceKey', ['papers', 'a' * 32, 'original.pdf']), 'provenance', 'provenance-source-document'),
        'provenance-library-derived': (provenance_row('library', 'sourceSha256', 'c' * 64), 'provenance', 'provenance-source-library'),
        'provenance-library-kind': (provenance_row('library', 'sourceKind', 'row'), 'provenance', 'provenance-source-library'),
        'provenance-item-hash': (provenance_row('library-item', 'sourceSha256', 'c' * 64), 'provenance', 'provenance-source-library-item'),
        'provenance-folder-hash': (provenance_row('folder', 'sourceSha256', 'c' * 64), 'provenance', 'provenance-source-folder'),
        'provenance-link-hash': (provenance_row('link', 'sourceSha256', 'c' * 64), 'provenance', 'provenance-source-link'),
        'provenance-link-key': (provenance_link_key, 'provenance', 'provenance-source-link'),
        'provenance-markdown-hash': (provenance_row('markdown', 'sourceSha256', 'c' * 64), 'provenance', 'provenance-source-markdown'),
        'provenance-dropped-annotation': (provenance_drop('annotation'), 'provenance', 'provenance-targets'),
        'provenance-dropped-link': (provenance_drop('link'), 'provenance', 'provenance-targets'),
        'provenance-dropped-folder': (provenance_drop('folder'), 'provenance', 'provenance-targets'),
        'provenance-dropped-library': (provenance_drop('library'), 'provenance', 'provenance-targets'),
        'provenance-duplicate': (provenance_duplicate, 'provenance', 'provenance-duplicate'),
        'provenance-extra': (provenance_extra, 'provenance', 'provenance-targets'),
    }
    # An edit that makes a snapshot itself invalid is also caught by `assert_snapshot` (`snapshot-invalid`): accepted for those names only.
    either = {'library-owner', 'library-folder-of-item', 'library-kind', 'library-link-extra', 'library-deletions', 'library-metadata'}
    for name, (edit, side, code) in sorted(cases.items()):
        found = edited(seen, edit)
        accepted = {code, 'snapshot-invalid'} if name in either else {code}
        if name == 'library-pdf-resource':
            accepted = {'library', 'resources'}
        assert accepted & set(found[side]), (name, found)


def test_the_accounting_resolves_a_reason_only_on_complete_evidence(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    synthetic, report, seen = captured(runtime, monkeypatch)
    manifest, inventory, model, facts, residual = seen['account']
    base = staging.accounting.account(manifest, inventory, model, facts, plan_residual=residual)
    assert base['resolved'] == MAIN_RESOLVED and base['residual'] == MAIN_RESIDUAL

    def run(edit):
        value = [copy.deepcopy(item) for item in (manifest, inventory, model, facts, list(residual))]
        edit(*value)
        return staging.accounting.account(value[0], value[1], value[2], value[3], plan_residual=value[4])

    def library_object(inventory, name):
        source = next(item for item in inventory['sources'] if item['kind'] == 'desktop-library')
        return next(item for item in source['sqlite']['objects'] if item['type'] == 'table' and item['name'] == name)

    def a_group(name, group, count, reason):
        def edit(_manifest, inventory, _model, _facts, _residual):
            table = library_object(inventory, name)
            table['rows']['groups'].append({'group': group, 'count': count, 'category': 'retained-blocking', 'reason': reason})
        return edit

    def a_file(key, reason):
        def edit(_manifest, inventory, _model, _facts, _residual):
            source = next(item for item in inventory['sources'] if item['kind'] == 'desktop-library')
            source['entries'].append({'key': key, 'category': 'retained-blocking', 'reason': reason})
        return edit

    def more_rows(name, group, delta):
        def edit(_manifest, inventory, _model, _facts, _residual):
            next(item for item in library_object(inventory, name)['rows']['groups'] if item['group'] == group)['count'] += delta
        return edit

    def forced(reason):
        def edit(_manifest, _inventory, _model, _facts, residual):
            residual.append(reason)
        return edit

    def not_converted(reason, residual_reason):
        def edit(_manifest, _inventory, model, _facts, _residual):
            model['notConverted'].append({'sourceKey': ['papers', 'a' * 32], 'kind': 'item', 'reason': reason, 'residual': residual_reason, 'count': 1})
        return edit

    def withheld_annotations(_manifest, _inventory, model, facts, _residual):
        pdf = next(iter(facts['pdfs']))
        model['notConverted'].append({'sourceKey': ['papers', pdf], 'kind': 'pdf-annotation', 'reason': 'pdf-annotation-web-ops-present',
                                      'residual': 'a-reason-of-its-own', 'count': 1})

    def withheld_ink_only(manifest, inventory, model, facts, residual):
        source = next(item for item in inventory['sources'] if item['kind'] == 'desktop-library')
        next(item for item in source['sqlite']['objects'] if item['name'] == 'bookmarks')['rows']['groups'].clear()
        withheld_annotations(manifest, inventory, model, facts, residual)

    def withheld_bookmarks_only(manifest, inventory, model, facts, residual):
        source = next(item for item in inventory['sources'] if item['kind'] == 'desktop-library')
        next(item for item in source['sqlite']['objects'] if item['name'] == 'pdf_ink')['rows']['groups'].clear()
        withheld_annotations(manifest, inventory, model, facts, residual)

    def an_unused_media_file(_manifest, inventory, _model, facts, _residual):
        source = next(item for item in inventory['sources'] if item['kind'] == 'desktop-library')
        source['entries'].append({'key': ['papers', next(iter(facts['markdown'])), 'media', 'unused.png'], 'category': 'retained-blocking',
                                  'reason': 'markdown-not-converted'})

    def blank_collection(_manifest, _inventory, _model, facts, _residual):
        facts['collections']['blank'] = 1

    def collections_differ(_manifest, _inventory, _model, facts, _residual):
        facts['collections']['rows'] += 1

    def less_folders(_manifest, _inventory, model, _facts, _residual):
        payload_of(model, 'library')['folders'].pop()

    def less_links(_manifest, _inventory, model, _facts, _residual):
        payload_of(model, 'library')['links'] = []

    def not_in_library(_manifest, _inventory, model, _facts, _residual):
        entry = next(entry for entry in model['coverage'] if entry['kind'] == 'pdf')
        entry['status'] = 'not-in-library'

    def blocked_notebook_incomplete(_manifest, _inventory, _model, facts, _residual):
        for item in facts['manifestNotebooks'].values():
            item['incomplete'] = []

    def not_blocking(_manifest, _inventory, _model, _facts, _residual):
        _manifest['wholeLibrary']['reasons'] = [reason for reason in _manifest['wholeLibrary']['reasons'] if reason != 'folder-not-converted']

    cases = {
        'a-note_legacy-row-covers-nothing': (a_group('note_legacy', 'markdown', 1, 'markdown-not-converted'), 'markdown-not-converted'),
        'a-translated-ink-row': (more_rows('pdf_ink', 'pdf', 1), 'pdf-annotation-not-converted'),
        'a-pdf-row-more-than-converted': (more_rows('pages', 'pdf', 1), 'pdf-document-not-converted'),
        'a-note-state-row-of-another-owner': (a_group('note_state', 'pdf', 1, 'markdown-not-converted'), 'markdown-not-converted'),
        'a-media-file-nothing-used': (a_file(['papers', 'a' * 32, 'media', 'x.png'], 'markdown-not-converted'), 'markdown-not-converted'),
        'a-pdf-file-nothing-converted': (a_file(['papers', 'a' * 32, 'original.pdf'], 'pdf-document-not-converted'), 'pdf-document-not-converted'),
        'a-note-file-nothing-converted': (a_file(['papers', 'a' * 32, 'note.md'], 'markdown-not-converted'), 'markdown-not-converted'),
        'annotations-withheld-for-a-pdf': (withheld_annotations, 'pdf-annotation-not-converted'),
        'withheld-and-only-ink-rows': (withheld_ink_only, 'pdf-annotation-not-converted'),
        'withheld-and-only-bookmark-rows': (withheld_bookmarks_only, 'pdf-annotation-not-converted'),
        'an-unused-media-file-of-a-converted-note': (an_unused_media_file, 'markdown-not-converted'),
        'a-blank-collection': (blank_collection, 'folder-not-converted'), 'a-collection-row-more': (collections_differ, 'folder-not-converted'),
        'fewer-folders': (less_folders, 'folder-not-converted'), 'fewer-links': (less_links, 'item-link-not-converted'),
        'an-unresolved-link-row': (more_rows('item_links', 'all', 1), 'item-link-not-converted'),
        'the-converter-keeps-a-reason': (forced('folder-not-converted'), 'folder-not-converted'),
        'a-converter-note-keeps-a-reason': (not_converted('a-reason', 'markdown-not-converted'), 'markdown-not-converted'),
        'a-dropped-content-covers-nothing': (not_in_library, 'pdf-document-not-converted'),
    }
    for name, (edit, reason) in sorted(cases.items()):
        found = run(edit)
        assert reason in found['residual'] and reason not in found['resolved'], (name, found)
        assert not set(found['resolved']) & set(found['residual']), name
    assert 'pdf-annotation-not-converted' in run(not_in_library)['residual']
    # A reason that is not in the manifest is not claimed (resolved is a subset of the blocking reasons), and the Notebooks' own `incomplete`
    # codes are residual only while a staged Notebook has them (REVIEW-r161-b7e low 5).
    assert 'folder-not-converted' not in run(not_blocking)['resolved']
    assert set(run(blocked_notebook_incomplete)['residual']) == set(MAIN_RESIDUAL) - set(NOTEBOOK_INCOMPLETE)

    def no_evidence(_manifest, inventory, _model, _facts, _residual):
        source = next(item for item in inventory['sources'] if item['kind'] == 'desktop-library')
        source['entries'].clear()
        source['sqlite']['objects'].clear()

    # A reason none of whose elements can be found is never resolved on a guess.
    assert run(no_evidence)['resolved'] == []


def test_a_plan_with_a_stale_hash_or_a_stale_unit_hash_is_refused(runtime):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)

    def stale_plan(data):
        plan = bridge(data)
        plan['counts']['items'] += 1                                                   # the plan changed after its hash was made
        return plan

    def stale_unit(data):
        plan = bridge(data)
        unit_of(plan, 'markdown')['payload']['content'] += 'x'
        plan['planSha256'] = edit_content_hash({key: value for key, value in plan.items() if key != 'planSha256'})       # the plan hash is fresh, the unit's is not
        return plan

    def other_scope(data):
        plan = bridge(data)
        plan['scope'] = 'native-legacy-staging-plan-v0'
        plan['planSha256'] = edit_content_hash({key: value for key, value in plan.items() if key != 'planSha256'})
        return plan

    def other_version(data):
        plan = bridge(data)
        plan['converterVersion'] = 'b7-v0'
        plan['planSha256'] = edit_content_hash({key: value for key, value in plan.items() if key != 'planSha256'})
        return plan

    def other_manifest(data):
        plan = bridge(data)
        plan['manifestSha256'] = '0' * 64
        plan['planSha256'] = edit_content_hash({key: value for key, value in plan.items() if key != 'planSha256'})
        return plan

    def extra_key(data):
        plan = bridge(data)
        plan['extra'] = 1
        plan['planSha256'] = edit_content_hash({key: value for key, value in plan.items() if key != 'planSha256'})
        return plan

    def not_a_plan(_data):
        return ['not', 'a', 'plan']

    with TestClient(app) as client:
        run_id = capture_live(client)
        for convert in (stale_plan, stale_unit, other_scope, other_version, other_manifest, extra_key, not_a_plan):
            args = failing(run_id, convert)
            assert args == ('staging-plan-rejected', ['plan-shape']), (convert.__name__, args)
            assert state_of(root, run_id)['state'] == 'absent'
            free_gate()
        assert not store.staging_base(root).exists()


def test_s8_resource_bytes_that_are_not_the_planned_file_never_enter_the_staging(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    real = staging._gather
    flip = {'on': False}

    def gather(admission):
        built, hooked = real(admission)
        read_entry = hooked['read_entry']
        hooked['read_entry'] = lambda entry, limit: (b'x' * entry['byteLength']) if flip['on'] else read_entry(entry, limit)
        return built, hooked

    with TestClient(app) as client:
        run_id = capture_live(client)
        with monkeypatch.context() as patch:
            patch.setattr(staging, '_gather', gather)
            with at_boundary(monkeypatch, 'initialize', lambda _token: flip.update(on=True)):
                assert failing(run_id) == ('staging-resource-mismatch',)
        assert state_of(root, run_id)['phase'] == 'initialized' and sql(root, run_id, 'SELECT COUNT(*) FROM edit_resource_bytes') == [(0,)]
    free_gate()


def test_the_seal_looks_again_at_the_other_writers(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        flag = {'on': False}
        real_writers = staging.conversion_input._assert_external_writers

        def writers(selection):
            if flag['on']:
                raise ValueError('conversion-input-other-writer-present')
            return real_writers(selection)

        with at_boundary(monkeypatch, 'seal', lambda _token: flag.update(on=True)):
            with monkeypatch.context() as patch:
                patch.setattr(staging.conversion_input, '_assert_external_writers', writers)
                assert failing(run_id) == ('staging-other-writer-present',)
        assert state_of(root, run_id)['phase'] == 'verified' and sql(root, run_id, 'SELECT report_sha256 FROM migration_staging_run') == [(None,)]
        free_gate()
        assert stage(run_id, lambda _data: pytest.fail('not converted again'))['residualReasons'] == MAIN_RESIDUAL     # the next call seals
        assert state_of(root, run_id)['phase'] == 'staged'
    free_gate()


def test_the_seal_refuses_when_the_sources_are_not_what_they_were_at_the_start(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        calls = []
        with monkeypatch.context() as patch:
            patch.setattr(staging, '_fingerprint', lambda _token: calls.append(1) or ('fingerprint', len(calls)))        # the second look differs
            assert failing(run_id) == ('staging-source-changed',)
        assert len(calls) == 2 and state_of(root, run_id)['phase'] == 'verified'
    free_gate()


def test_an_ids_row_that_no_other_check_uses_is_compared_with_the_plans_table(runtime, monkeypatch):  # noqa: F811
    """The old-to-new ID of an annotation is used by no independent check, so only the comparison with the plan's own table sees it change."""
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with at_boundary(monkeypatch, 'verify', lambda _token: sql(
                root, run_id, "UPDATE migration_staging_ids SET source_key = '[\"tampered\"]' WHERE rowid = "
                              "(SELECT MIN(rowid) FROM migration_staging_ids WHERE kind = 'ink')")):
            args = failing(run_id)
        assert args == ('staging-verification-failed', ['ids-table']), args
        assert state_of(root, run_id)['phase'] == 'assembled'
        # Review fix (REVIEW-r161-b7f medium 1): the second call fails the same way and never seals the tampered table.
        free_gate()
        assert failing(run_id) == args
        state = state_of(root, run_id)
        assert state['phase'] == 'assembled' and state['state'] != 'staged' and state['complete'] is False
        assert sql(root, run_id, 'SELECT COUNT(*) FROM migration_staging_verification') == [(0,)]
        assert sql(root, run_id, "SELECT COUNT(*) FROM migration_staging_ids WHERE source_key = '[\"tampered\"]'") == [(1,)]      # nothing was repaired
    free_gate()


def test_an_id_row_the_plan_names_but_the_staging_lacks_fails_again_on_the_second_call(runtime):  # noqa: F811
    """REVIEW-r161-b7f medium 1, the other route: a converter that gives an unused resource an ID row. The row is never written, so the
    read-back table differs from the plan's; the run stops at `assembled` and a second call must not seal it."""
    root, device, _lock = runtime
    prepared(runtime)

    def extra_resource_id(plan):
        plan['ids'].append({'kind': 'resource', 'source': ['markdown-image', 'papers', 'f' * 32, 'media', 'x.png', '0' * 64],
                            'targetId': '00000000-0000-4000-8000-0000000000f1'})

    with TestClient(app) as client:
        run_id = capture_live(client)
        args = failing(run_id, tampering(extra_resource_id))
        assert args == ('staging-verification-failed', ['ids-table']), args
        assert state_of(root, run_id)['phase'] == 'assembled'
        free_gate()
        assert failing(run_id) == args
        assert state_of(root, run_id)['phase'] == 'assembled' and state_of(root, run_id)['complete'] is False
        assert sql(root, run_id, 'SELECT COUNT(*) FROM migration_staging_verification') == [(0,)]
    free_gate()
