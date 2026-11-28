"""Work B7-h: the round trip Python -> TypeScript -> Python on synthetic Libraries (isolated data only).

The Library is a synthetic one (`tests/_synthetic_legacy_library.py`). Python reads it and hands rows to the REAL TypeScript converters (node, through
the test bridge `frontend/tests/migrations/stagingConversionBridge.ts`; nothing is faked), the writer puts the plan into the invisible staging, and the
tests here read the staging back with NOTHING but `sqlite3` and `json` and rebuild, in the vocabulary of the OLD Library (old paper ids, page numbers,
folder paths), what the staging says. That reconstruction is compared with a second one made straight from the OLD Library's SQLite and files. Neither
side uses the writer's own verification (`staging._verify`), the converters' plan, or the report's numbers as a source of truth: a report number is only
compared, never trusted.

  E-1  the main fixture: reconstruction == source view; row counts; the ID table (a bijection, no run id inside, every old paper id present);
       provenance both ways (targets and hashes recomputed from the files); the residual accounting is exactly the expected set.
  E-2  the variants named in DESIGN 12.1 that matter for the round trip: closed WAL, a translated-side row, an image Markdown note, a note owned by
       a PDF, titles the Library cannot hold, a web-annotation ledger. Each has its own expected source view and expected reasons.
  E-3  a converter plan that was edited and then made self-consistent again (every hash recomputed) is never staged: it is refused before anything
       is written, or stops before `staged`; the writer does not believe the caller's plan.

What is NOT shown here: a real Library, a real screen, a real application, a power cut, Web / Drive / macOS / Linux.
"""
from collections import Counter
from contextlib import closing
import hashlib
import json
import re
import sqlite3
import uuid

from fastapi.testclient import TestClient
import pymupdf
import pytest

from test_native_conversion_input import (assert_no_working_copy, capture_live, fresh_gate, prepared, runtime, snapshot)  # noqa: F401 - shared fixtures
from test_native_staging import (MAIN_RESIDUAL, MAIN_RESOLVED, failing, free_gate, ids_of, library_id_of, namespace_of, roots_of,
                                 sql, stage, tampering, unit_of)
from papeer.core.migrations import legacy_staging_store as store
from sidecar.app import app
from sidecar.migrations import staging

ALL_REASONS = set(MAIN_RESOLVED) | set(MAIN_RESIDUAL)


def path_of(name):
    """The folder path as the converter normalizes it: parts trimmed and joined with '/'."""
    return '/'.join(part.strip() for part in name.split('/'))


def source_view(root, synthetic, *, skip=(), original_side_only=True, strokeless=()):
    """What the OLD Library says, counted straight from its SQLite and files (never from the staging, the plan or the report).
    `skip`: old paper ids whose content the converter must not have converted; `strokeless`: old ids whose annotations must be absent."""
    view = {'items': {}, 'folders': set(), 'links': set(), 'annotations': {}, 'markdown': {}, 'resources': []}
    with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
        for paper_id, kind, title, folder, parent in db.execute('SELECT id, kind, title, collection_name, parent_id FROM papers'):
            if paper_id in skip:
                continue
            view['items'][paper_id] = {'kind': kind, 'title': title, 'folder': path_of(folder) if folder and parent is None else None,
                                       'owner': parent}
        paths = {path_of(name) for (name,) in db.execute('SELECT name FROM collections')}
        paths |= {item['folder'] for item in view['items'].values() if item['folder']}
        for path in list(paths):                                   # a folder's ancestors are folders too
            while '/' in path:
                path = path.rsplit('/', 1)[0]
                paths.add(path)
        view['folders'] = paths
        view['links'] = {frozenset(pair) for pair in db.execute('SELECT a, b FROM item_links')
                         if pair[0] in view['items'] and pair[1] in view['items']}
        for paper_id in view['items']:
            if paper_id in strokeless or view['items'][paper_id]['kind'] == 'markdown':
                continue
            counts = Counter()
            for side, page, strokes in db.execute('SELECT side, page, strokes FROM pdf_ink WHERE paper_id = ?', (paper_id,)):
                if side == 'original' or not original_side_only:
                    counts[(page, 'ink')] += len(json.loads(strokes))
            for page, side, kind in db.execute('SELECT page, side, kind FROM bookmarks WHERE paper_id = ?', (paper_id,)):
                if side == 'original' or not original_side_only:
                    counts[(page, {'note': 'sticky', 'highlight': 'highlight'}[kind])] += 1
            view['annotations'][paper_id] = counts
        for paper_id, content in db.execute('SELECT id, content FROM note_state'):
            if paper_id in view['items']:
                view['markdown'][paper_id] = content
    for paper_id, item in view['items'].items():
        if item['kind'] == 'pdf':
            view['resources'].append(hashlib.sha256((root / 'papers' / paper_id / 'original.pdf').read_bytes()).hexdigest())
    return view


def reconstruction(root, run_id):
    """What the STAGING says, in the vocabulary of the old Library: only sqlite3 and json, through the ID table's inverse."""
    ids = ids_of(root, run_id)
    old = {target: (kind, source) for (kind, source), target in ids.items()}
    roots = roots_of(root, run_id)
    library = roots[library_id_of(root, run_id)]
    document_kinds = {'notebook-document': 'notebook', 'pdf-document': 'pdf', 'markdown-document': 'markdown'}
    assert library['kind'] == 'library'
    view = {'items': {}, 'folders': set(), 'links': set(), 'annotations': {}, 'markdown': {}, 'resources': [], 'unmapped': []}
    folder_titles = {folder['id']: folder for folder in library['folders']}

    def folder_path(folder_id):
        parts = []
        while folder_id is not None:
            parts.append(folder_titles[folder_id]['title'])
            folder_id = folder_titles[folder_id]['parentId']
        return '/'.join(reversed(parts))

    for folder in library['folders']:
        kind, source = old[folder['id']]
        assert kind == 'library-folder' and path_of(source[0]) == folder_path(folder['id']), 'the folder id names a path other than the folder tree'
        view['folders'].add(folder_path(folder['id']))     # the ID's source key is the stored name ('Folder / Sub'); the tree is the normalized path
    for item in library['items']:
        kind, source = old[item['id']]
        assert kind in document_kinds and len(source) == 1 and document_kinds[kind] == item['kind']
        owner = None if item['ownerId'] is None else old[item['ownerId']][1][0]
        view['items'][source[0]] = {'kind': item['kind'], 'title': item['title'], 'owner': owner,
                                    'folder': None if item['folderId'] is None else folder_path(item['folderId'])}
    for link in library['links']:
        view['links'].add(frozenset((old[link['pdfId']][1][0], old[link['noteId']][1][0])))
    for target, payload in roots.items():
        if payload['kind'] == 'markdown':
            view['markdown'][old[target][1][0]] = payload['content']
        elif payload['kind'] == 'document':
            kind, source = old[target]
            counts = Counter()
            for index, page in enumerate(payload['pages'], 1):
                number = page['background']['pdfPage'] if page['background']['kind'] == 'pdf' else index
                for annotation in page['annotations']:
                    counts[(number, annotation['kind'])] += 1
            view['annotations'][source[0]] = counts
            if kind == 'pdf-document':
                view['resources'].append(payload['pages'][0]['background']['sourceRevision'])
    return view


def nonzero(annotations):
    """Per document, the (page, kind) counts that are not zero; documents without any left out."""
    result = {key: {name: value for name, value in counts.items() if value} for key, counts in annotations.items()}
    return {key: counts for key, counts in result.items() if counts}


def assert_round_trip(root, synthetic, run_id, report, **source_options):
    """The reconstruction from the staging equals the view from the old Library; then the row counts, the ID table and the provenance."""
    staged = reconstruction(root, run_id)
    source = source_view(root, synthetic, **source_options)
    assert staged['items'] == source['items']
    assert staged['folders'] == source['folders']
    assert staged['links'] == source['links']
    assert staged['markdown'] == source['markdown']
    assert nonzero(staged['annotations']) == nonzero(source['annotations'])
    assert sorted(staged['resources']) == sorted(source['resources'])
    # Row counts: one root per document, per note and the Library; one resource row per file; units are the roots.
    roots = roots_of(root, run_id)
    kinds = Counter(payload['kind'] for payload in roots.values())
    assert kinds == Counter({'document': sum(1 for i in staged['items'].values() if i['kind'] != 'markdown'),
                             'markdown': sum(1 for i in staged['items'].values() if i['kind'] == 'markdown'), 'library': 1})
    resource_rows = sql(root, run_id, 'SELECT payload FROM edit_resources WHERE scope = ?', namespace_of(root, run_id))
    assert sorted(json.loads(row[0])['sha256'] for row in resource_rows) == sorted(report_resource_hashes(root, run_id, staged))
    assert sql(root, run_id, 'SELECT COUNT(*) FROM migration_staging_units') == [(len(roots),)]
    assert sql(root, run_id, 'SELECT COUNT(*) FROM edit_checkpoints') == [(1,)]
    for table in store.FORBIDDEN_ROW_TABLES:
        assert sql(root, run_id, f'SELECT COUNT(*) FROM {table}') == [(0,)]
    # The report only agrees with what was just counted (it is compared, never trusted).
    counts = report['counts']
    assert counts['items'] == len(staged['items']) and counts['folders'] == len(staged['folders']) and counts['links'] == len(staged['links'])
    assert counts['markdown'] == len(staged['markdown']) and counts['resources'] == len(staged['resources']) + counts['images']
    for annotation in ('ink', 'sticky', 'highlight'):
        assert counts[annotation] == sum(value for per_page in staged['annotations'].values() for (page, name), value in per_page.items()
                                         if name == annotation)
    # The ID table is a bijection, has no run id in it, and names every old paper id that was converted.
    table = sql(root, run_id, 'SELECT kind, source_key, target_id FROM migration_staging_ids WHERE run_id = ?', run_id)
    assert len({row[2] for row in table}) == len(table) and len({(row[0], row[1]) for row in table}) == len(table)
    assert not [row for row in table if run_id in row[1] or run_id in row[2]]
    named = {json.loads(row[1])[0] for row in table if row[0] in ('notebook-document', 'pdf-document', 'markdown-document')}
    assert named == set(staged['items'])
    assert_provenance(root, run_id, roots)


def report_resource_hashes(root, run_id, staged):
    """The hashes of the resource bytes in the staging (recomputed here, bytes hashed again), for the PDFs and the images."""
    rows = sql(root, run_id, 'SELECT payload FROM edit_resource_bytes WHERE scope = ?', namespace_of(root, run_id))
    return [hashlib.sha256(bytes(row[0])).hexdigest() for row in rows]


def assert_provenance(root, run_id, roots):
    """Every object has exactly one provenance row and every provenance row has an object (both directions); resource rows name the file's hash."""
    targets = {('library', library_id_of(root, run_id))}
    for target, payload in roots.items():
        if payload['kind'] == 'document':
            targets |= {('document', target)} | {('page', page['id']) for page in payload['pages']}
            targets |= {('annotation', item['id']) for page in payload['pages'] for item in page['annotations']}
            targets |= {('resource', page['background']['resourceId']) for page in payload['pages'] if page['background']['kind'] == 'pdf'}
        elif payload['kind'] == 'markdown':
            targets.add(('markdown', target))
            targets |= {('resource', image['resourceId']) for image in payload.get('imageResources', [])}
        else:
            targets |= {('library-item', item['id']) for item in payload['items']} | {('folder', folder['id']) for folder in payload['folders']}
            targets |= {('link', json.dumps([link['pdfId'], link['noteId']], separators=(',', ':'))) for link in payload['links']}
    rows = sql(root, run_id, 'SELECT target_kind, target_id, source_kind, source_sha256 FROM migration_staging_provenance')
    assert {(row[0], row[1]) for row in rows} == targets and len(rows) == len(targets)
    hashes = {hashlib.sha256(bytes(row[0])).hexdigest() for row in sql(root, run_id, 'SELECT payload FROM edit_resource_bytes')}
    for target_kind, target_id, source_kind, source_sha in rows:
        if target_kind == 'resource':
            assert source_kind == 'file' and source_sha in hashes


def stage_variant(runtime, mutate=None, **options):  # noqa: F811
    """(synthetic, run id, report) of a synthetic Library (after `mutate(synthetic, root)`), staged once through the real converters."""
    root, device, _lock = runtime
    synthetic = prepared(runtime, **options)
    if mutate:
        mutate(synthetic, root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        before = snapshot(root, device)
        report = stage(run_id)
        assert snapshot(root, device) == before                      # the old Library, canonical store and device settings are the same bytes
        assert_no_working_copy(root)
        assert staging.status(run_id)['state'] == 'staged'
    free_gate()
    return synthetic, run_id, report


# E-1 -----------------------------------------------------------------------------------------------------------------
def test_e1_the_main_fixture_round_trips_and_the_reasons_split_exactly(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic, run_id, report = stage_variant(runtime)
    assert_round_trip(root, synthetic, run_id, report)
    assert report['resolvedReasons'] == MAIN_RESOLVED and report['residualReasons'] == MAIN_RESIDUAL
    assert 'uncollected-source' in report['residualReasons']
    kept = {item['reason']: item for item in report['accounting']}['uncollected-source']
    assert kept['status'] == 'residual' and kept['elements'] == 0          # nothing in the report could ever cover it: it is never resolved
    # The fixture's own sizes, independent of everything above: 4 items, 2 folders, 1 link, 3 documents' annotations.
    expected = synthetic.expected['notebooks']
    view = reconstruction(root, run_id)
    assert len(view['items']) == 4 and view['folders'] == {'Folder', 'Folder/Sub'} and len(view['links']) == 1
    assert sum(sum(counts.values()) for counts in view['annotations'].values()) == (
        sum(item['strokes'] + item['notes'] + item['highlights'] for item in expected.values()) + 2)    # P: 1 stroke, 1 note
    # Nothing is publishable, whatever the round trip says.
    with pytest.raises(ValueError) as error:
        staging.assert_staging_publishable(run_id)
    assert error.value.args[0] == 'staging-not-publishable' and 'uncollected-source' in error.value.args[1]


def test_e1_a_report_with_no_residual_reason_is_still_not_publishable(runtime, monkeypatch):  # noqa: F811
    """The refusal does not depend on the report (DESIGN 5.5): even a report that claims nothing is left over never passes."""
    root, device, _lock = runtime
    synthetic, run_id, report = stage_variant(runtime)
    with monkeypatch.context() as patch:
        patch.setattr(staging, 'report', lambda _run_id: {**report, 'residualReasons': []})
        with pytest.raises(ValueError) as error:
            staging.assert_staging_publishable(run_id)
    assert error.value.args[0] == 'staging-not-publishable'


# E-2 -----------------------------------------------------------------------------------------------------------------
def test_e2_a_closed_wal_library_round_trips_like_the_main_one(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic, run_id, report = stage_variant(runtime, wal_closed=True)
    assert_round_trip(root, synthetic, run_id, report)
    assert report['resolvedReasons'] == MAIN_RESOLVED and report['residualReasons'] == MAIN_RESIDUAL and 'sqlite-wal-closed' not in json.dumps(report)


def test_e2_a_translated_side_row_is_not_staged_and_keeps_its_reason(runtime):  # noqa: F811
    root, device, _lock = runtime

    def translated(synthetic, root):
        synthetic.sql(("INSERT INTO pdf_ink VALUES(?, 'translated', 1, ?)", (synthetic.ids['P'], json.dumps(
            [{'id': 't1', 'color': '#000000', 'width': .01, 'points': [[.1, .2], [.3, .4]]}]))))

    synthetic, run_id, report = stage_variant(runtime, translated)
    assert_round_trip(root, synthetic, run_id, report)                # the source view counts the original side only
    assert 'pdf-annotation-not-converted' in report['residualReasons'] and 'pdf-annotation-not-converted' not in report['resolvedReasons']
    assert set(report['resolvedReasons']) | set(report['residualReasons']) == ALL_REASONS


def test_e2_an_image_note_round_trips_with_its_image_bytes(runtime):  # noqa: F811
    root, device, _lock = runtime
    png = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 2, 2), False)
    png.clear_with(200)
    data = png.tobytes('png')

    def media(synthetic, root):
        m = synthetic.ids['M']
        content = '# memo\n![capture](media/ink-capture-1.png)\n'
        synthetic.sql(('UPDATE note_state SET content = ? WHERE id = ?', (content, m)))
        (root / 'papers' / m / 'media').mkdir(parents=True, exist_ok=True)
        (root / 'papers' / m / 'media' / 'ink-capture-1.png').write_bytes(data)
        (root / 'papers' / m / 'note.md').write_bytes(content.encode('utf-8'))

    synthetic, run_id, report = stage_variant(runtime, media)
    note = next(payload for payload in roots_of(root, run_id).values() if payload['kind'] == 'markdown')
    assert [image['sha256'] for image in note['imageResources']] == [hashlib.sha256(data).hexdigest()]
    assert hashlib.sha256(data).hexdigest() in report_resource_hashes(root, run_id, None)
    staged = reconstruction(root, run_id)
    sha = hashlib.sha256(data).hexdigest()
    source_content = source_view(root, synthetic)['markdown'][synthetic.ids['M']]
    body = staged['markdown'][synthetic.ids['M']]
    match = re.fullmatch(r'# memo\n!\[capture\]\((papeer://resource/([0-9a-f-]+)\?sha256=([0-9a-f]{64}))\)\n', body)
    assert match and match.group(3) == sha and report['counts']['images'] == 1
    assert match.group(2) in {json.loads(row[0])['id'] for row in sql(root, run_id, 'SELECT payload FROM edit_resources')}
    # The only difference from the old body is the image reference: put the old one back and the bodies are equal.
    assert body.replace(match.group(1), 'media/ink-capture-1.png') == source_content
    assert_provenance(root, run_id, roots_of(root, run_id))
    assert 'markdown-not-converted' in report['resolvedReasons']


def test_e2_a_note_owned_by_a_pdf_round_trips_its_owner(runtime):  # noqa: F811
    root, device, _lock = runtime

    def owned(synthetic, root):
        synthetic.sql(('UPDATE papers SET parent_id = ? WHERE id = ?', (synthetic.ids['P'], synthetic.ids['M'])))

    synthetic, run_id, report = stage_variant(runtime, owned)
    assert_round_trip(root, synthetic, run_id, report)
    assert reconstruction(root, run_id)['items'][synthetic.ids['M']]['owner'] == synthetic.ids['P']


@pytest.mark.parametrize('title', ['', 'x' * 201])
def test_e2_an_item_the_library_cannot_hold_leaves_the_round_trip_with_its_reasons(runtime, title):  # noqa: F811
    root, device, _lock = runtime

    def untitled(synthetic, root):
        synthetic.sql(('UPDATE papers SET title = ? WHERE id = ?', (title, synthetic.ids['P'])))

    synthetic, run_id, report = stage_variant(runtime, untitled)
    assert_round_trip(root, synthetic, run_id, report, skip=(synthetic.ids['P'],))
    view = reconstruction(root, run_id)
    assert synthetic.ids['P'] not in view['items'] and len(view['items']) == 3 and not view['links'] and not view['resources']
    assert 'library-item-not-converted' in report['residualReasons'] and 'pdf-document-not-converted' in report['residualReasons']
    assert 'item-link-not-converted' in report['residualReasons']


def test_e2_a_second_pdf_the_library_cannot_hold_leaves_the_reason_only_partly_covered(runtime):  # noqa: F811
    """Two PDFs, one of which the Library drops (a 201-character title): the reasons of the PDF rows are covered for the first and not for the
    second, so they stay residual. Resolving on partial evidence (`any` instead of `all` in the accounting) would show up here."""
    root, device, _lock = runtime
    holder = {}

    def second(synthetic, root):
        holder['id'] = identifier = uuid.uuid4().hex
        (root / 'papers' / identifier).mkdir()
        with pymupdf.open() as document:                       # another file (papers.sha256 is unique): one page of another size
            document.new_page(width=300, height=400)
            data = document.tobytes()
        (root / 'papers' / identifier / 'original.pdf').write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        synthetic.sql(("INSERT INTO papers(id,sha256,title,original_name,pages,status,collection_name,kind)"
                       " VALUES(?,?,?,?,1,'not_translated','Folder','pdf')", (identifier, digest, 'x' * 201, 'second.pdf')),
                      ('INSERT INTO pages VALUES(?, 1, ?)', (identifier, 'text')))

    synthetic, run_id, report = stage_variant(runtime, second)
    assert_round_trip(root, synthetic, run_id, report, skip=(holder['id'],))
    view = reconstruction(root, run_id)
    assert synthetic.ids['P'] in view['items'] and holder['id'] not in view['items']
    assert 'pdf-document-not-converted' in report['residualReasons'] and 'pdf-document-not-converted' not in report['resolvedReasons']
    assert 'library-item-not-converted' in report['residualReasons']
    accounting = {item['reason']: item for item in report['accounting']}['pdf-document-not-converted']
    assert 0 < accounting['covered'] < accounting['count']                      # partly covered: that is what keeps it residual


def test_e2_a_web_annotation_ledger_withholds_the_strokes_and_keeps_its_reasons(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic, run_id, report = stage_variant(runtime, glossary_tables=True)
    # The ledger blocks both Notebooks and the PDF's strokes; the PDF itself (without strokes) and the plain note are staged.
    assert_round_trip(root, synthetic, run_id, report, skip=(synthetic.ids['A'], synthetic.ids['B']), strokeless=(synthetic.ids['P'],))
    assert set(reconstruction(root, run_id)['items']) == {synthetic.ids['P'], synthetic.ids['M']}
    assert 'web-annotation-ops-not-converted' in report['residualReasons'] and 'web-annotation-ops-not-converted' not in report['resolvedReasons']
    assert 'pdf-document-not-converted' in report['resolvedReasons'] and 'pdf-annotation-not-converted' in report['residualReasons']
    assert report['counts']['ink'] == 0 and report['counts']['sticky'] == 0 and report['counts']['highlight'] == 0


# E-3 -----------------------------------------------------------------------------------------------------------------
def drop_pdf_ink(plan):
    page = next(page for page in unit_of(plan, 'pdf')['payload']['pages'] if page['annotations'])
    page['annotations'] = [item for item in page['annotations'] if item['kind'] != 'ink']


def drop_notebook_annotation(plan):
    for unit in plan['units']:
        if unit['sourceKind'] == 'notebook':
            for page in unit['payload']['pages']:
                if page['annotations']:
                    page['annotations'] = page['annotations'][1:]
                    return
    raise AssertionError('no annotated notebook page')


def change_markdown(plan):
    note = unit_of(plan, 'markdown')['payload']
    note['content'] = note['content'] + 'x'


def swap_notebook_pages(plan):
    unit = next(unit for unit in plan['units'] if unit['sourceKind'] == 'notebook' and len(unit['payload']['pages']) > 1)
    unit['payload']['pages'].reverse()


def resize_pdf_page(plan):
    unit_of(plan, 'pdf')['payload']['pages'][0]['widthPt'] += 1


def drop_link(plan):
    library = unit_of(plan, 'library')['payload']
    assert library['links']
    library['links'] = []


def retitle_item(plan):
    library = unit_of(plan, 'library')['payload']
    library['items'][0]['title'] = library['items'][0]['title'] + '!'


def rename_folder(plan):
    library = unit_of(plan, 'library')['payload']
    library['folders'][0]['title'] = library['folders'][0]['title'] + '!'


TAMPERINGS = {'drop-pdf-ink': drop_pdf_ink, 'drop-notebook-annotation': drop_notebook_annotation, 'change-markdown': change_markdown,
              'swap-notebook-pages': swap_notebook_pages, 'resize-pdf-page': resize_pdf_page, 'drop-link': drop_link,
              'retitle-item': retitle_item, 'rename-folder': rename_folder}


CHECKS = {'drop-pdf-ink': 'pdf-annotations', 'drop-notebook-annotation': 'notebook', 'change-markdown': 'markdown', 'swap-notebook-pages': 'notebook',
          'resize-pdf-page': 'pdf-geometry', 'drop-link': 'library', 'retitle-item': 'library', 'rename-folder': 'library'}
assert sorted(CHECKS) == sorted(TAMPERINGS)


@pytest.mark.parametrize('name', sorted(TAMPERINGS))
def test_e3_a_self_consistent_but_edited_plan_never_reaches_staged(runtime, name):  # noqa: F811
    """The edit keeps every hash consistent (`retamper`), so only the writer's independent counts and its read-back can tell. The call is refused
    (before anything is written), no staging folder, no report, nothing is publishable."""
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        args = failing(run_id, tampering(TAMPERINGS[name]))
        # Measured (output/qa/b7h-r161-r1/probe-e3.log): every one of them is refused by the writer's independent counts, by the named check,
        # before the staging folder exists. A different outcome (a later refusal, or none) is a change in the writer and must be looked at.
        assert args[0] == 'staging-plan-rejected' and CHECKS[name] in args[1], args
        assert staging.status(run_id)['state'] == 'absent' and not store.staging_base(root).exists()
        with pytest.raises(ValueError):
            staging.assert_staging_publishable(run_id)
    free_gate()


def test_e3_control_the_unedited_plan_of_the_same_library_stages(runtime):  # noqa: F811
    """Control: the same call with the unedited plan stages; the edited ones above are refused for the edit, not for the fixture."""
    root, device, _lock = runtime
    synthetic, run_id, report = stage_variant(runtime)
    assert report['counts']['items'] == 4

