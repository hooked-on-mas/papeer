"""Non-empty Notebook: real Python extraction -> real HTTP route -> TypeScript -> static render.

The Notebook is built from synthetic files in an isolated copy (real SQLite, real backup objects).
The two route responses are handed to ``frontend/tests/migrations/notebookPreviewBridge.mjs``, which
runs the real desktop driver, the real preview controller / ``projectNotebookPreview`` and the real
``NotebookPreviewPages`` component, and reports what was drawn. The counts are then compared with
counts that this test derives independently from the source SQLite file and notebook.json.
"""
from contextlib import closing
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess

from fastapi.testclient import TestClient
import pytest

from test_native_maintenance_entry import runtime  # noqa: F401 - existing controlled-copy fixture
from test_native_notebook_preview import (  # noqa: F401 - autouse gate fixture is shared on purpose
    backup_root, capture_live, fresh_gate, post, settle, tree_hashes, untouched,
)
from papeer.core import notebook
from papeer.core.storage import Library
from sidecar.app import app

FRONTEND = Path(__file__).resolve().parents[3] / 'frontend'
BRIDGE = FRONTEND / 'tests' / 'migrations' / 'notebookPreviewBridge.mjs'
TIMEOUT = 60


def stroke(name, points):
    return {'id': name, 'color': '#000000', 'width': .01, 'points': points}


def build(root, pages, ink_by_page, notes_by_page):
    """Create a Notebook with ``pages`` pages; ``ink_by_page`` maps page -> strokes, ``notes_by_page`` page -> note count."""
    library = Library(root)
    note = notebook.create(library, 'Synthetic render', {})
    for _ in range(pages - 1):
        notebook.change(library, note, notebook.read(library, note)['revision'], 'append')
    with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
        for page, strokes in ink_by_page.items():
            db.execute("INSERT INTO pdf_ink VALUES(?, 'original', ?, ?)", (note, page, json.dumps(strokes)))
        for page, count in notes_by_page.items():
            for index in range(count):
                db.execute("INSERT INTO bookmarks(paper_id,page,side,quote,label,note,anchor_y,anchor_x,kind,color,rects)"
                           " VALUES(?,?,'original','synthetic',?,'note',?,?,'note','','[]')",
                           (note, page, f'label {page}-{index}', .2 + index * .1, .3))
        db.commit()
    return note


def source_counts(root, note):
    """What the source files say, read straight from SQLite and notebook.json (not from the route)."""
    with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
        ink_rows = db.execute("SELECT page, strokes FROM pdf_ink WHERE paper_id=? AND side='original'", (note,)).fetchall()
        notes = db.execute("SELECT count(*) FROM bookmarks WHERE paper_id=? AND kind='note'", (note,)).fetchone()[0]
        others = db.execute("SELECT count(*) FROM bookmarks WHERE paper_id=? AND kind!='note'", (note,)).fetchone()[0]
    pages = len(json.loads((root / 'papers' / note / 'notebook.json').read_bytes())['pages'])
    return {'pages': pages, 'inkRows': len(ink_rows), 'strokes': sum(len(json.loads(raw)) for _page, raw in ink_rows),
            'notes': notes, 'otherBookmarks': others}


def run_bridge(run_id, selector, listed, previewed):
    node = shutil.which('node')
    assert node, 'node is required for the TypeScript half of this test'
    payload = json.dumps({'runId': run_id, 'selector': selector,
                          'list': {'status': listed.status_code, 'body': listed.json()},
                          'preview': {'status': previewed.status_code, 'body': previewed.json()}})
    process = subprocess.Popen([node, str(BRIDGE)], cwd=FRONTEND, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
    try:
        stdout, stderr = process.communicate(payload, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        # The established policy is to leave a stuck child alone and report it, not to kill it.
        pytest.fail(f'node bridge did not finish within {TIMEOUT}s; left running as PID {process.pid}')
    assert process.returncode == 0, stderr[-3000:]
    return json.loads(stdout)


@pytest.mark.parametrize('pages, ink_by_page, notes_by_page', [
    (2, {2: [stroke('a', [[.1, .2], [.3, .4]])]}, {1: 1}),
    (3, {1: [stroke('a', [[.1, .1], [.2, .2]]), stroke('b', [[.5, .5], [.6, .7]])], 3: [stroke('c', [[.2, .3], [.4, .5]])]}, {1: 2, 2: 1}),
], ids=['two-pages-1-ink-1-note', 'three-pages-3-ink-3-notes'])
def test_nonempty_notebook_extract_http_typescript_render(runtime, pages, ink_by_page, notes_by_page):  # noqa: F811
    root, _device, _lock = runtime
    note = build(root, pages, ink_by_page, notes_by_page)
    settle(root)
    assert not (root / 'library.sqlite3-wal').exists() and not (root / 'library.sqlite3-shm').exists()
    expected = source_counts(root, note)
    original = tree_hashes(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        objects = tree_hashes(backup_root(root) / 'objects')
        listed = post(client, run_id)
        previewed = post(client, run_id, note)
        assert listed.status_code == 200 and previewed.status_code == 200
        drawn = run_bridge(run_id, note, listed, previewed)
        untouched(root, original, objects)

    # The independent source counts match the route's claim, and the claim matches what was drawn.
    assert expected['pages'] == pages and expected['notes'] == sum(notes_by_page.values()) and expected['otherBookmarks'] == 0
    wire = previewed.json()['coverage']
    assert wire == {'pageRows': expected['pages'], 'inkRows': expected['inkRows'], 'bookmarkRows': expected['notes']}
    assert drawn['selectors'] == [note]
    assert drawn['pages'] == expected['pages'] == len(drawn['pageLabels'])
    assert drawn['pageLabels'] == [f'ページ {index}' for index in range(1, pages + 1)]
    assert drawn['inkRows'] == expected['inkRows'] and drawn['bookmarkRows'] == expected['notes']
    assert drawn['inkElements'] == expected['strokes'], drawn['annotationKinds']
    assert drawn['bookmarkElements'] == expected['notes'] and drawn['highlightElements'] == 0
    # Annotations land on the page that the source rows named.
    for page, strokes in ink_by_page.items():
        assert drawn['annotationKinds'][page - 1].count('ink') == len(strokes)
    for page, count in notes_by_page.items():
        assert drawn['annotationKinds'][page - 1].count('sticky') == count
    # Exactly the two preview routes were called, with exactly the documented body keys.
    assert drawn['requests'] == [{'path': '/api/edits/legacy-maintenance/notebooks', 'keys': ['runId']},
                                 {'path': '/api/edits/legacy-maintenance/notebook-preview', 'keys': ['runId', 'selector']}]
