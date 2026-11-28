"""Work B6-d: Python conversion input -> TypeScript conversion and count check (synthetic, isolated data only).

The real `conversion_input.build(include_extractions=True)` result of the synthetic Library is handed to
``frontend/tests/migrations/conversionInputBridge.ts``, which runs the real `projectConversionInputNotebooks`
(strict manifest check, the existing `projectLegacyNotebookEntry`, and the count check) under plain node
(``--experimental-transform-types``, no Vite). The counts that come back are compared with counts this test
derives straight from SQLite and notebook.json (``Synthetic.expected``), never from the manifest.
"""
import base64
import copy
import json
from pathlib import Path
import shutil
import subprocess

from fastapi.testclient import TestClient
import pytest

from test_native_conversion_input import (  # noqa: F401 - the autouse gate fixture and the controlled-copy fixture are shared on purpose
    assert_no_working_copy, build, capture_live, fresh_gate, prepared, runtime, snapshot,
)
from papeer.core.edit_content_hash import edit_content_hash
from sidecar.app import app

FRONTEND = Path(__file__).resolve().parents[3] / 'frontend'
BRIDGE = FRONTEND / 'tests' / 'migrations' / 'conversionInputBridge.ts'
TIMEOUT = 60


def payload(value):
    """The bridge's stdin: the manifest and, per extracted Notebook, the verified entry bytes and the original-page rows."""
    return {'manifest': value['manifest'],
            'extractions': [{'libraryId': item['libraryId'], 'sourceDocumentId': item['sourceDocumentId'], 'entry': item['entry'],
                             'bytesBase64': base64.b64encode(item['bytes']).decode('ascii'), 'annotations': item['annotations']}
                            for item in value['extractions'].values()]}


def run_bridge(data):
    """(exit code, stdout, stderr). A stuck child is left alone and reported, never killed (the established policy)."""
    node = shutil.which('node')
    assert node, 'node is required for the TypeScript half of this test'
    process = subprocess.Popen([node, '--experimental-transform-types', '--disable-warning=ExperimentalWarning', str(BRIDGE)], cwd=FRONTEND, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
    try:
        stdout, stderr = process.communicate(json.dumps(data), timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        pytest.fail(f'node bridge did not finish within {TIMEOUT}s; left running as PID {process.pid}')
    return process.returncode, stdout, stderr


def converted(data):
    code, stdout, stderr = run_bridge(data)
    assert code == 0, stderr[-3000:]
    return json.loads(stdout)


def expected_kinds(counts, pages):
    """Per page, the annotation kinds the source rows imply: ink, then the bookmarks in id order (note -> sticky)."""
    result = [[] for _ in range(pages)]
    for _side, page, strokes in counts['ink']:
        result[page - 1].extend(['ink'] * strokes)
    for page, kind in counts['marks']:            # bookmark id order, as the extraction lists them
        result[page - 1].append('sticky' if kind == 'note' else 'highlight')
    return result


# T-1 -------------------------------------------------------------------------------------
def test_main_fixture_round_trip_counts_equal_the_source_rows(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        settled = snapshot(root, device)
        value = build(run_id, include_extractions=True)
        result = converted(payload(value))
        assert snapshot(root, device) == settled          # reading, extracting and converting changed nothing
        assert_no_working_copy(root)
    manifest = value['manifest']
    a, b = synthetic.ids['A'], synthetic.ids['B']
    by_id = {item['sourceDocumentId']: item for item in result['notebooks']}
    assert sorted(by_id) == sorted([a, b]) and all(item['status'] == 'converted' for item in by_id.values()), result['notebooks']
    # The same numbers three ways: the source rows (Synthetic.expected), the hand-written figures of the fixture, the TypeScript output.
    assert by_id[a]['counts'] == {'pages': 2, 'ink': 2, 'sticky': 1, 'highlight': 1}
    assert by_id[b]['counts'] == {'pages': 3, 'ink': 3, 'sticky': 2, 'highlight': 0}
    for identifier, item in by_id.items():
        source = synthetic.expected['notebooks'][identifier]
        assert item['counts'] == {'pages': source['pages'], 'ink': source['strokes'], 'sticky': source['notes'], 'highlight': source['highlights']}
        assert [mapping['sourcePageId'] for mapping in item['pageMappings']] == source['pageIds'] == next(
            entry['pageIds'] for entry in manifest['notebooks'] if entry['sourceDocumentId'] == identifier)
        assert len({mapping['targetPageId'] for mapping in item['pageMappings']}) == len(source['pageIds'])
        assert item['pageAnnotationKinds'] == expected_kinds(source, source['pages'])
    assert result['wholeLibrary'] == manifest['wholeLibrary'] and result['wholeLibrary']['status'] == 'refused'
    assert 'uncollected-source' in result['wholeLibrary']['reasons']


# T-2 -------------------------------------------------------------------------------------
def test_notebook_journal_variant_converts_one_and_blocks_the_other(runtime):  # noqa: F811
    root, _device, _lock = runtime
    synthetic = prepared(runtime, notebook_journal=True)
    with TestClient(app) as client:
        run_id = capture_live(client)
        value = build(run_id, include_extractions=True)
        assert sorted(value['extractions']) == [synthetic.ids['A']]          # the blocked Notebook is never extracted
        result = converted(payload(value))
        assert_no_working_copy(root)
    a, b = synthetic.ids['A'], synthetic.ids['B']
    by_id = {item['sourceDocumentId']: item for item in result['notebooks']}
    assert by_id[a]['status'] == 'converted' and by_id[a]['counts'] == {'pages': 2, 'ink': 2, 'sticky': 1, 'highlight': 1}, by_id[a]
    assert by_id[b] == {'sourceDocumentId': b, 'status': 'blocked', 'reason': 'legacy-notebook-recovery-pending'}
    assert result['wholeLibrary']['status'] == 'refused'
    assert {'notebook-recovery-pending', 'notebook-extraction-blocked', 'uncollected-source'} <= set(result['wholeLibrary']['reasons'])


# T-3 -------------------------------------------------------------------------------------
def test_a_tampered_extraction_is_refused_with_a_count_mismatch(runtime):  # noqa: F811
    root, _device, _lock = runtime
    synthetic = prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        value = build(run_id, include_extractions=True)
        assert converted(payload(value))['notebooks']                       # control: the untouched result converts
        a = synthetic.ids['A']
        tampered = copy.deepcopy(value)
        removed = [page for page in tampered['extractions'][a]['annotations'] if page['bookmarks']][0]['bookmarks'].pop()
        assert removed['kind'] in ('note', 'highlight')
        code, stdout, stderr = run_bridge(payload(tampered))
        assert code == 1 and stdout == '', (stdout, stderr)
        assert stderr == '{"error":"conversion-input-count-mismatch"}', stderr
        # A stroke removed from the same extraction is refused the same way, and so are the entry bytes changed in place.
        stroke = copy.deepcopy(value)
        [page for page in stroke['extractions'][a]['annotations'] if page['ink']][0]['ink'].pop()
        code, _stdout, stderr = run_bridge(payload(stroke))
        assert code == 1 and stderr == '{"error":"conversion-input-count-mismatch"}', stderr
        altered = copy.deepcopy(value)
        data = bytearray(altered['extractions'][a]['bytes'])
        data[-3] ^= 1
        altered['extractions'][a]['bytes'] = bytes(data)
        code, _stdout, stderr = run_bridge(payload(altered))
        assert code == 1 and stderr == '{"error":"conversion-input-entry-mismatch"}', stderr
        # The manifest is sealed with Python's edit_content_hash and checked by TypeScript's editContentHash. A row edited
        # without re-sealing is a stale hash; a row edited and re-sealed is a well-formed manifest whose counts are wrong.
        edited = copy.deepcopy(value)
        row = next(item for item in next(entry for entry in edited['manifest']['notebooks'] if entry['sourceDocumentId'] == a)['rows']['bookmarks']
                   if item['kind'] == 'note')
        row['kind'] = 'highlight'
        code, _stdout, stderr = run_bridge(payload(edited))
        assert code == 1 and stderr == '{"error":"conversion-input-manifest-invalid"}', stderr
        edited['manifest']['manifestSha256'] = edit_content_hash({key: item for key, item in edited['manifest'].items() if key != 'manifestSha256'})
        code, _stdout, stderr = run_bridge(payload(edited))
        assert code == 1 and stderr == '{"error":"conversion-input-count-mismatch"}', stderr
        assert_no_working_copy(root)
