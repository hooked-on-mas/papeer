"""Work B7-e: the real Python rows -> the TypeScript staging converters, through the test bridge (synthetic, isolated data only).

DESIGN-r161-b7-staging.md 7.3 / 11 B7-e: the converters are called ONLY from a test bridge (decision J1). This file checks the shape of the
exchange (not the Python->TS->Python round trip, which is work B7-h): the REAL `conversion_input.build(include_extractions=True)` manifest and
Notebook extractions of the synthetic Library, the REAL rows of `legacy_staging_rows.extract_staging_rows` for the same backup, and resource
descriptors made here from the verified backup objects (PDF page sizes by PyMuPDF `page.rect`, the same call as `SqliteEditRepository.store_resource`)
are handed to ``frontend/tests/migrations/stagingConversionBridge.ts``. The numbers that come back are compared with numbers this test counts straight
from SQLite (`Synthetic.expected`) or writes by hand from the fixture, never from the converters.
The stable ID of a resource is computed here with the DESIGN 3.4 formula (edit_content_hash); the converter refuses a descriptor whose ID differs, so a
pass also pins the equality of the Python and TypeScript formulas. Nothing here touches a real profile: conftest isolates the folders.
"""
import base64
import copy
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess

from fastapi.testclient import TestClient
import pymupdf
import pytest

from _synthetic_legacy_library import sqlite_names
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.migrations import legacy_staging_store
from papeer.core.migrations.legacy_backup import NativeLegacyBackup
from papeer.core.migrations.legacy_inventory import inventory_source
from papeer.core.migrations.legacy_staging_rows import extract_staging_rows
from sidecar.app import app

from test_native_conversion_input import (  # noqa: F401 - the autouse gate fixture and the controlled-copy fixture are shared on purpose
    assert_no_working_copy, build, capture_live, fresh_gate, prepared, runtime, snapshot,
)

FRONTEND = Path(__file__).resolve().parents[3] / 'frontend'
BRIDGE = FRONTEND / 'tests' / 'migrations' / 'stagingConversionBridge.ts'
TIMEOUT = 90
PNG = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 2, 2), False)
PNG.clear_with(200)
PNG_BYTES = PNG.tobytes('png')


def stable_id(library_id, kind, source):
    """DESIGN 3.4: frontend/src/migrations/stableId.ts migrationStableId, written out with edit_content_hash."""
    digest = list(edit_content_hash(['paper-desk-migration-v1', library_id, kind, list(source)])[:32])
    digest[12] = '8'
    digest[16] = '89ab'[int(digest[16], 16) & 3]
    text = ''.join(digest)
    return '-'.join([text[:8], text[8:12], text[12:16], text[16:20], text[20:]])


def run_bridge(data):
    """(exit code, stdout, stderr). A stuck child is left alone and reported, never killed (the established policy)."""
    node = shutil.which('node')
    assert node, 'node is required for the TypeScript half of this test'
    process = subprocess.Popen([node, '--experimental-transform-types', '--disable-warning=ExperimentalWarning', str(BRIDGE)], cwd=FRONTEND,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
    try:
        stdout, stderr = process.communicate(json.dumps(data), timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        pytest.fail(f'node bridge did not finish within {TIMEOUT}s; left running as PID {process.pid}')
    return process.returncode, stdout, stderr


def staging_input(root, value, *, web_operations=0):
    """What a writer would hand the converters: the manifest, the verified Notebook extractions, the REAL rows, the resource descriptors."""
    manifest = value['manifest']
    backup_id = manifest['sources'][0]['backupId']
    backup = NativeLegacyBackup(root)
    stored = backup.load(backup_id)
    names = sqlite_names('desktop-library', stored)

    def read_entry(entry, max_bytes):
        return backup.read_object(backup_id, entry, max_bytes=max_bytes)

    with backup.sqlite_working_copy(backup_id, names) as copy_root:
        source = inventory_source('desktop-library', stored, copy_root, copied=frozenset((name,) for name in names), read_entry=read_entry)
        rows = extract_staging_rows(copy_root / 'library.sqlite3', stored, source, read_entry=read_entry)['rows']
    entries = {tuple(entry['key']): entry for entry in stored['entries']}
    resources = []
    for pdf in rows['pdfs']:
        entry = entries[('papers', pdf['id'], 'original.pdf')]
        data = read_entry(entry, 64 * 1024 * 1024)
        with pymupdf.open(stream=data, filetype='pdf') as document:
            pages = [{'widthPt': page.rect.width, 'heightPt': page.rect.height} for page in document]
        key = ['papers', pdf['id'], 'original.pdf']
        resources.append({'kind': 'pdf', 'resourceId': stable_id(manifest['libraryId'], 'resource', ['pdf-original', *key, entry['sha256']]),
                          'sourceKey': key, 'sha256': entry['sha256'], 'byteLength': entry['byteLength'], 'mediaType': 'application/pdf', 'pdfPages': pages})
    for note in rows['markdown']:
        for media in note['media']:
            entry = entries[('papers', note['id'], 'media', media['name'])]
            if not read_entry(entry, 1024 * 1024).startswith(b'\x89PNG\r\n\x1a\n'):
                continue                                           # not a PNG: no resource (the note refusing it is the converter's decision)
            key = ['papers', note['id'], 'media', media['name']]
            resources.append({'kind': 'image', 'resourceId': stable_id(manifest['libraryId'], 'resource', ['markdown-image', *key, entry['sha256']]),
                              'sourceKey': key, 'sha256': entry['sha256'], 'byteLength': entry['byteLength'], 'mediaType': 'image/png', 'pdfPages': None})
    return {'manifest': manifest,
            'extractions': [{'libraryId': item['libraryId'], 'sourceDocumentId': item['sourceDocumentId'], 'entry': item['entry'],
                             'bytesBase64': base64.b64encode(item['bytes']).decode('ascii'), 'annotations': item['annotations']}
                            for item in value['extractions'].values()],
            'rows': json.loads(json.dumps(rows)), 'resources': resources, 'webAnnotationOpsRows': web_operations}


def converted(data):
    code, stdout, stderr = run_bridge(data)
    assert code == 0, stderr[-3000:]
    return json.loads(stdout)


def direct(root, sql, *args):
    with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
        return db.execute(sql, args).fetchall()


def unit(plan, kind):
    return [item for item in plan['units'] if item['sourceKind'] == kind]


# B7-e Python 1 --------------------------------------------------------------------------------------------------------
def test_main_fixture_rows_convert_and_the_plan_equals_the_source_counts(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        settled = snapshot(root, device)
        value = build(run_id, include_extractions=True)
        data = staging_input(root, value)
        plan = converted(data)
        assert snapshot(root, device) == settled          # reading, extracting and converting changed nothing
        assert_no_working_copy(root)
    a, b, m, p = (synthetic.ids[key] for key in 'ABMP')
    library_id = value['manifest']['libraryId']
    # The plan header: the same converter version as the Python store, the sealed manifest it was made from.
    assert plan['converterVersion'] == legacy_staging_store.CONVERTER_VERSION == 'b7-v1'
    assert plan['scope'] == 'native-legacy-staging-plan-v1' and plan['libraryId'] == library_id
    assert plan['manifestSha256'] == value['manifest']['manifestSha256']
    assert plan['wholeLibrary']['status'] == 'refused' and 'uncollected-source' in plan['wholeLibrary']['reasons']
    # Counted by hand from the fixture (tests/_synthetic_legacy_library.py) and straight from SQLite (`Synthetic.expected`), never from the plan.
    expected = synthetic.expected['notebooks']
    pages = sum(item['pages'] for item in expected.values()) + 1                  # the PDF has one page
    strokes = sum(item['strokes'] for item in expected.values()) + 1              # and one stroke
    notes = sum(item['notes'] for item in expected.values()) + 1                  # and one sticky note
    highlights = sum(item['highlights'] for item in expected.values())
    assert plan['counts'] == {'items': 4, 'folders': 2, 'links': 1, 'tags': 0, 'documents': {'pdf': 1, 'notebook': 2}, 'markdown': 1, 'pages': pages,
                              'ink': strokes, 'sticky': notes, 'highlight': highlights, 'resources': 1, 'images': 0}
    assert (pages, strokes, notes, highlights) == (6, 6, 4, 1)
    assert [item['seq'] for item in plan['units']] == list(range(5))
    assert [item['unitKind'] for item in plan['units']] == ['document', 'document', 'document', 'markdown', 'library']
    # The Library: ids are the content ids; title, folder, link as the rows say; read false and no metadata (J3 (a)).
    library = plan['units'][-1]['payload']
    assert library['id'] == library_id and library['deletions'] == []
    by_title = {item['title']: item for item in library['items']}
    assert sorted(by_title) == ['Synthetic PDF', 'Synthetic memo', 'Synthetic notebook A', 'Synthetic notebook B']
    assert all(item['read'] is False and item['metadata'] == {} and item['tags'] == [] and item['ownerId'] is None for item in library['items'])
    folders = {item['title']: item for item in library['folders']}
    assert sorted(folders) == ['Folder', 'Sub'] and folders['Sub']['parentId'] == folders['Folder']['id'] and folders['Folder']['parentId'] is None
    assert by_title['Synthetic PDF']['folderId'] == folders['Folder']['id'] and by_title['Synthetic notebook B']['folderId'] == folders['Sub']['id']
    assert by_title['Synthetic memo']['folderId'] is None and by_title['Synthetic notebook A']['folderId'] is None
    assert library['links'] == [{'pdfId': by_title['Synthetic PDF']['id'], 'noteId': by_title['Synthetic notebook A']['id']}]
    assert by_title['Synthetic PDF']['resourceId'] == data['resources'][0]['resourceId'] and 'resourceId' not in by_title['Synthetic memo']
    # The ids the converters made follow the DESIGN 3.4 table, written out here with edit_content_hash (and none depends on the run).
    ids = {(item['kind'], tuple(item['source'])): item['targetId'] for item in plan['ids']}
    assert ids[('pdf-document', (p,))] == stable_id(library_id, 'pdf-document', [p]) == by_title['Synthetic PDF']['id']
    assert ids[('pdf-page', (p, '1'))] == stable_id(library_id, 'pdf-page', [p, '1'])
    assert ids[('markdown-document', (m,))] == stable_id(library_id, 'markdown-document', [m]) == by_title['Synthetic memo']['id']
    assert ids[('notebook-document', (a,))] == by_title['Synthetic notebook A']['id'] == stable_id(library_id, 'notebook-document', [a])
    assert ids[('library-folder', ('Folder / Sub',))] == folders['Sub']['id'] == stable_id(library_id, 'library-folder', ['Folder / Sub'])
    assert value['manifest']['runId'] not in json.dumps(plan) and value['manifest']['peerId'] not in json.dumps(plan)
    # The PDF: the resource the plan names is the real original.pdf (its sha256 is the row's), the page has the PyMuPDF size, the ink is at the row's fractions.
    pdf_row = data['rows']['pdfs'][0]
    document = next(item for item in plan['units'] if item['targetId'] == by_title['Synthetic PDF']['id'])['payload']
    assert pdf_row['file']['sha256'] == direct(root, 'SELECT sha256 FROM papers WHERE id = ?', p)[0][0] == data['resources'][0]['sha256']
    page = document['pages'][0]
    assert page['background'] == {'kind': 'pdf', 'resourceId': data['resources'][0]['resourceId'], 'sourceRevision': pdf_row['file']['sha256'], 'pdfPage': 1}
    assert (page['widthPt'], page['heightPt']) == (data['resources'][0]['pdfPages'][0]['widthPt'], data['resources'][0]['pdfPages'][0]['heightPt'])
    ink = next(item for item in page['annotations'] if item['kind'] == 'ink')
    assert ink['geometry']['points'] == [{'x': pytest.approx(.1 * page['widthPt']), 'y': pytest.approx(.2 * page['heightPt'])},
                                          {'x': pytest.approx(.3 * page['widthPt']), 'y': pytest.approx(.4 * page['heightPt'])}]
    assert ink['style']['widthPt'] == pytest.approx(.01 * page['widthPt'])
    sticky = next(item for item in page['annotations'] if item['kind'] == 'sticky')
    assert sticky['anchor'] == {'x': pytest.approx(.3 * page['widthPt']), 'y': pytest.approx(.2 * page['heightPt'])}      # anchor_x=.3, anchor_y=.2 in the fixture
    # What stays residual, and what the converter itself keeps alive.
    assert plan['notConverted'] == []
    assert plan['residualReasons'] == ['library-metadata-not-converted', 'page-text-not-converted']
    # Provenance: the row hashes the converter wrote are the Python extraction's own (it recomputed none of them), except the sets it re-derived and checked.
    rows = {item['id']: item for item in data['rows']['items']}
    by_target = {(item['targetKind'], item['targetId']): item for item in plan['provenance']}
    assert by_target[('library-item', by_title['Synthetic PDF']['id'])]['sourceSha256'] == rows[p]['sourceSha256']
    assert by_target[('library-item', by_title['Synthetic notebook B']['id'])]['sourceSha256'] == rows[b]['sourceSha256']
    assert by_target[('folder', folders['Sub']['id'])]['sourceSha256'] == next(item for item in data['rows']['folders'] if item['path'] == 'Folder / Sub')['sourceSha256']
    assert by_target[('page', page['id'])]['sourceKind'] == 'rows' and by_target[('page', page['id'])]['sourceSha256'] == pdf_row['annotationPages']['1']['sourceSha256']
    assert by_target[('markdown', by_title['Synthetic memo']['id'])]['sourceSha256'] == data['rows']['markdown'][0]['sourceSha256']
    assert by_target[('resource', data['resources'][0]['resourceId'])]['sourceSha256'] == data['resources'][0]['sha256']
    assert len(by_target) == len(plan['provenance'])


# B7-e Python 2 --------------------------------------------------------------------------------------------------------
def test_a_tampered_input_is_refused_with_a_closed_code(runtime):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        value = build(run_id, include_extractions=True)
        data = staging_input(root, value)
        assert converted(data)['units']                                        # control: the untouched input converts
        assert_no_working_copy(root)

    def refused(change, code):
        tampered = copy.deepcopy(data)
        change(tampered)
        status, stdout, stderr = run_bridge(tampered)
        assert status == 1 and stdout == '' and stderr == json.dumps({'error': code}, separators=(',', ':')), (stdout, stderr)

    # The independent counts (what the SQL counted) must agree with the rows the converter was given.
    refused(lambda d: d['rows']['pdfs'][0]['inkRows'][0]['strokes'].pop(), 'staging-conversion-input-mismatch')
    refused(lambda d: d['rows']['pdfs'][0]['counts']['bookmarks']['note'].update(original=2), 'staging-conversion-input-mismatch')
    refused(lambda d: d['rows']['pdfs'][0]['annotationPages']['1'].update(sourceSha256='0' * 64), 'staging-conversion-input-mismatch')
    refused(lambda d: d['rows']['markdown'][0].update(contentSha256='0' * 64), 'staging-conversion-input-mismatch')
    # The writer's resource must be the manifest's file under the stable ID of its source.
    refused(lambda d: d['resources'][0].update(sha256='0' * 64), 'staging-conversion-resource-mismatch')
    refused(lambda d: d['resources'][0].update(resourceId='00000000-0000-8000-8000-000000000000'), 'staging-conversion-resource-mismatch')
    # An unknown key and a Notebook the rows do not list are refused; a manifest that is not what it was sealed as is the existing B6 code.
    refused(lambda d: d['rows'].update(extra=[]), 'staging-conversion-input-invalid')
    refused(lambda d: d['rows']['notebooks'].pop(), 'staging-conversion-input-mismatch')
    refused(lambda d: d['manifest']['notebooks'][0].update(reason='x'), 'conversion-input-manifest-invalid')


# B7-e Python 3 --------------------------------------------------------------------------------------------------------
def test_a_note_with_a_capture_converts_to_a_canonical_image_reference(runtime):  # noqa: F811
    root, _device, _lock = runtime
    synthetic = prepared(runtime)
    m = synthetic.ids['M']
    content = '# memo\n![capture](media/ink-capture-1.png)\n'
    synthetic.sql(('UPDATE note_state SET content = ? WHERE id = ?', (content, m)))
    media = root / 'papers' / m / 'media'
    media.mkdir(parents=True, exist_ok=True)
    (media / 'ink-capture-1.png').write_bytes(PNG_BYTES)
    (root / 'papers' / m / 'note.md').write_bytes(content.encode('utf-8'))
    with TestClient(app) as client:
        run_id = capture_live(client)
        value = build(run_id, include_extractions=True)
        data = staging_input(root, value)
        assert_no_working_copy(root)
    note = data['rows']['markdown'][0]
    assert note['mirror'] == 'match' and note['media'] == [{'name': 'ink-capture-1.png', 'sha256': hashlib.sha256(PNG_BYTES).hexdigest(), 'byteLength': len(PNG_BYTES)}]
    image = next(item for item in data['resources'] if item['kind'] == 'image')
    plan = converted(data)
    snapshot_ = next(item for item in plan['units'] if item['unitKind'] == 'markdown')['payload']
    uri = f"papeer://resource/{image['resourceId']}?sha256={hashlib.sha256(PNG_BYTES).hexdigest()}"
    assert snapshot_['content'] == f'# memo\n![capture]({uri})\n'
    assert snapshot_['imageResources'] == [{'resourceId': image['resourceId'], 'sha256': hashlib.sha256(PNG_BYTES).hexdigest()}]
    assert plan['counts']['images'] == 1 and plan['counts']['resources'] == 2
    assert [item['resourceId'] for item in plan['resources']] == sorted(item['resourceId'] for item in data['resources'])

# B7-e Python 3b -------------------------------------------------------------------------------------------------------
def test_a_note_with_a_reference_that_cannot_be_verified_stays_out(runtime):  # noqa: F811
    root, _device, _lock = runtime
    synthetic = prepared(runtime)
    m = synthetic.ids['M']
    content = '# memo' + chr(10) + '![capture](media/missing.png)' + chr(10)
    synthetic.sql(('UPDATE note_state SET content = ? WHERE id = ?', (content, m)))
    (root / 'papers' / m / 'note.md').write_bytes(content.encode('utf-8'))
    with TestClient(app) as client:
        run_id = capture_live(client)
        value = build(run_id, include_extractions=True)
        plan = converted(staging_input(root, value))
        assert_no_working_copy(root)
    assert [(item['kind'], item['reason'], item['residual']) for item in plan['notConverted']] == [
        ('markdown', 'markdown-media-missing', 'markdown-not-converted')]
    assert not [item for item in plan['units'] if item['unitKind'] == 'markdown']
    assert 'markdown-not-converted' in plan['residualReasons'] and plan['counts']['markdown'] == 0 and plan['counts']['items'] == 3


# B7-e Python 4 --------------------------------------------------------------------------------------------------------
def test_a_web_annotation_ledger_withholds_the_pdf_annotations_and_keeps_the_pages(runtime):  # noqa: F811
    root, _device, _lock = runtime
    synthetic = prepared(runtime, glossary_tables=True)
    p = synthetic.ids['P']
    with TestClient(app) as client:
        run_id = capture_live(client)
        value = build(run_id, include_extractions=True)
        ledger = direct(root, 'SELECT count(*) FROM web_annotation_ops')[0][0]            # counted straight from SQLite
        assert ledger == 1
        plain = converted(staging_input(root, value, web_operations=0))
        withheld = converted(staging_input(root, value, web_operations=ledger))
        assert_no_working_copy(root)
    document = lambda plan: next(item for item in plan['units'] if item['sourceKind'] == 'pdf')['payload']      # noqa: E731
    assert [len(page['annotations']) for page in document(plain)['pages']] == [2]
    assert [len(page['annotations']) for page in document(withheld)['pages']] == [0]
    # The ledger holds strokes only (cloud_drive.py:186): the PDF's strokes cannot be told from the PC's, so its annotations (ink 1 row + note 1 row) are
    # withheld; both Notebooks have ink rows, so neither converts (the B6 projection converts a Notebook as a whole).
    assert sorted((item['kind'], item['reason'], item['residual'], item['count']) for item in withheld['notConverted']) == sorted([
        ('notebook', 'notebook-annotation-web-ops-present', 'notebook-projection-blocked', 1),
        ('notebook', 'notebook-annotation-web-ops-present', 'notebook-projection-blocked', 1),
        ('link', 'link-endpoint-not-converted', 'item-link-not-converted', 1),
        ('pdf-annotation', 'pdf-annotation-web-ops-present', 'pdf-annotation-not-converted', 2)])
    assert document(plain)['version'] != document(withheld)['version'] and p in json.dumps(withheld['coverage'])
    assert withheld['counts']['documents'] == {'pdf': 1, 'notebook': 0} and withheld['counts']['items'] == 2
    assert (withheld['counts']['ink'], withheld['counts']['sticky'], withheld['counts']['highlight']) == (0, 0, 0)
    assert {'notebook-projection-blocked', 'pdf-annotation-not-converted', 'item-link-not-converted'} <= set(withheld['residualReasons'])
