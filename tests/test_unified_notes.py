import uuid

import pytest

from papeer.core import cloud_notes, notes, notebook
from papeer.core.backup import validate_library
from papeer.core.errors import Conflict, Invalid
from papeer.core.storage import Library


@pytest.fixture
def lib(tmp_path):
    return Library(tmp_path / 'library')


def test_markdown_revision_placement_and_restart(lib):
    owner = notebook.create(lib, 'Owner', {})
    row = notes.create(lib, 'Markdown', content='# Hello', parent_id=owner)
    assert row['id'] in lib.owned_notebooks(owner)
    updated = notes.update(lib, row['id'], row['revision'], content='Saved')
    with pytest.raises(Conflict):
        notes.update(lib, row['id'], row['revision'], content='stale')
    notes.update(lib, row['id'], updated['revision'], parent_id=None, collection='研究/メモ')
    reopened = Library(lib.root)
    assert notes.read(reopened, row['id'])['content'] == 'Saved'
    assert (reopened.folder(row['id']) / 'note.md').read_text('utf-8') == 'Saved'
    validate_library(reopened.root)


def test_ink_only_document_save_preserves_paper_resource_and_rebuilds_a_missing_pdf(lib, monkeypatch):
    identity = notebook.create(lib, 'Shared central and panel', {})
    original = cloud_notes.record(lib, identity)
    folder = lib.folder(identity)
    paper, configuration = folder / 'original.pdf', folder / 'notebook.json'
    before = paper.read_bytes(), paper.stat().st_mtime_ns, configuration.stat().st_mtime_ns
    real_pdf, calls = notebook.pdf, []
    monkeypatch.setattr(notebook, 'pdf', lambda value: (calls.append(value), real_pdf(value))[1])
    page_id = original['document']['pages'][0]['id']
    payload = {**original, 'ink': {page_id: [{'id': 'shared-ink', 'points': [[.1, .2], [.2, .3]], 'color': '#000000', 'width': .003}]}}
    cloud_notes.apply(lib, {'id': str(uuid.uuid4()), 'note_id': identity, 'base': original['revision']}, payload)
    assert calls == []
    assert (paper.read_bytes(), paper.stat().st_mtime_ns, configuration.stat().st_mtime_ns) == before
    accepted = cloud_notes.record(lib, identity)
    assert accepted['ink'][page_id] == payload['ink'][page_id]
    assert accepted['revision'] != original['revision']
    paper.unlink()
    cloud_notes.apply(lib, {'id': str(uuid.uuid4()), 'note_id': identity, 'base': accepted['revision']}, accepted)
    assert len(calls) == 1 and paper.is_file()


def test_holding_is_one_level_and_delete_can_keep_markdown(lib):
    owner = notebook.create(lib, 'Owner', {})
    row = notes.create(lib, 'Child', parent_id=owner)
    with pytest.raises(Invalid):
        notes.create(lib, 'Grandchild', parent_id=row['id'])
    lib.delete_paper(owner, keep_notebooks=True)
    assert notes.read(lib, row['id'])['parent_id'] is None


def test_capture_image_survives_detach_and_owner_deletion(lib):
    owner = notebook.create(lib, 'Owner', {})
    media = lib.folder(owner) / 'media'
    media.mkdir()
    (media / 'capture.png').write_bytes(b'image')
    row = notes.create(lib, 'Capture', parent_id=owner)
    updated = notes.update(lib, row['id'], row['revision'], content='![capture](media/capture.png)')
    assert updated['content'] == f'![capture](media/{owner}-capture.png)'
    notes.update(lib, row['id'], updated['revision'], parent_id=None, collection='Notes')
    lib.delete_paper(owner)
    assert (lib.folder(row['id']) / 'media' / (owner + '-capture.png')).read_bytes() == b'image'


def test_api_revision_checks_and_body_search(lib, monkeypatch):
    from fastapi.testclient import TestClient
    from papeer.core.library_search import library_search
    from sidecar.app import app
    monkeypatch.setenv('PAPEER_DATA_DIR', str(lib.root))
    monkeypatch.setenv('PAPEER_DEV_NO_AUTH', '1')
    with TestClient(app) as client:
        created = client.post('/api/notes', json={'kind': 'markdown', 'title': 'API', 'content': 'uniquelysearchable'}).json()
        assert created['id'] in {item['id'] for item in client.get('/api/notes').json()}
        path = '/api/notes/' + created['id']
        assert client.patch(path, json={'revision': created['revision'], 'content': 'changed'}).status_code == 200
        assert client.patch(path, json={'revision': created['revision'], 'content': 'lost'}).status_code == 409
        assert client.delete(path, params={'revision': created['revision']}).status_code == 409
    row = notes.create(lib, 'Search', content='uniquelysearchable')
    assert row['id'] in {hit['paper_id'] for hit in library_search(lib, 'uniquelysearchable')['results']}


def test_web_replay_is_idempotent_and_conflicts_preserve_text(lib):
    row = notes.create(lib, 'Shared', content='Base')
    base = cloud_notes.record(lib, row['id'])
    first = {'id': str(uuid.uuid4()), 'note_id': row['id'], 'base': base['revision']}
    cloud_notes.apply(lib, first, {**base, 'content': 'Web A'})
    cloud_notes.apply(lib, first, {**base, 'content': 'Web A'})
    second = {'id': str(uuid.uuid4()), 'note_id': row['id'], 'base': base['revision']}
    cloud_notes.apply(lib, second, {**base, 'content': 'Web B'})
    assert notes.read(lib, row['id'])['content'] == 'Web A'
    assert notes.read(lib, uuid.UUID(second['id']).hex)['content'] == 'Web B'
    follow = {'id': str(uuid.uuid4()), 'note_id': row['id'], 'base': first['id']}
    cloud_notes.apply(lib, follow, {**base, 'content': 'Next'})
    assert notes.read(lib, row['id'])['content'] == 'Next'
    assert len(notes.list_notes(lib)) == 2


def test_interrupted_web_install_finishes_on_startup(lib, monkeypatch):
    row = notes.create(lib, 'Shared', content='Before')
    base = cloud_notes.record(lib, row['id'])
    op = {'id': str(uuid.uuid4()), 'note_id': row['id'], 'base': base['revision']}
    install = cloud_notes._install
    monkeypatch.setattr(cloud_notes, '_install', lambda *args: (_ for _ in ()).throw(OSError('interrupted')))
    with pytest.raises(OSError):
        cloud_notes.apply(lib, op, {**base, 'content': 'Recovered'})
    monkeypatch.setattr(cloud_notes, '_install', install)
    assert notes.read(Library(lib.root), row['id'])['content'] == 'Recovered'
    assert not list((lib.root / '.note-imports').glob('*.json'))


def test_handwriting_web_roundtrip_keeps_page_ids_and_ink(lib):
    identity = notebook.create(lib, 'Drawing', {})
    base = cloud_notes.record(lib, identity)
    page = notebook.page_spec(template='grid5')
    stroke = {'id': 'web-test', 'color': '#112233', 'width': .003, 'points': [[.1, .1], [.2, .2]]}
    payload = {**base, 'document': {**base['document'], 'pages': [page, *base['document']['pages']]}, 'ink': {page['id']: [stroke]}}
    cloud_notes.apply(lib, {'id': str(uuid.uuid4()), 'note_id': identity, 'base': base['revision']}, payload)
    after = cloud_notes.record(Library(lib.root), identity)
    assert after['document']['pages'][0]['id'] == page['id']
    assert after['ink'][page['id']] == [stroke]
    validate_library(lib.root)


def test_old_attachment_migration_keeps_media_and_legacy_identity(lib):
    from tests.test_schema_migration import set_version
    owner = notebook.create(lib, 'Owner', {})
    identity = uuid.uuid4().hex
    source = lib.folder(owner) / 'attachments' / (identity + '.md')
    source.parent.mkdir()
    source.write_text('![image](media/sample.png)', 'utf-8')
    media = lib.folder(owner) / 'media'
    media.mkdir()
    (media / 'sample.png').write_bytes(b'image')
    set_version(lib.root, 8)
    with lib.connection() as db:
        db.execute("INSERT INTO attachments(id,owner_id,format,title) VALUES(?,?,'md','Legacy')", (identity, owner))
    row = notes.read(Library(lib.root), identity)
    assert row['content'] == '![image](media/sample.png)'
    assert (lib.folder(identity) / 'media/sample.png').read_bytes() == b'image'
    assert source.exists()  # Rollback source stays available.
    assert (lib.root / 'before-unified-notes.sqlite3').exists()


@pytest.mark.parametrize('attached', [False, True])
def test_history_compares_and_restores_markdown_bodies(lib, tmp_path, attached):
    import threading
    from papeer.core import drive_sync, local_history, history_restore
    owner = notebook.create(lib, 'Owner', {}) if attached else None
    row = notes.create(lib, 'Text', content='Before 日本語', parent_id=owner)
    entry = local_history.record_folder(lib.root, lib.root, kind='publish',
                                        library_hash=drive_sync.fingerprint(lib),
                                        counts=drive_sync.library_counts(lib.root),
                                        cancel=threading.Event(), progress=lambda _: None)
    assert entry
    notes.update(lib, row['id'], row['revision'], content='After 日本語')
    diff = history_restore.difference(lib, entry)
    assert (diff['attachments'], diff['local_only'], diff['remote_only']) == (1, 0, 0)
    materialized = tmp_path / 'past'
    local_history.materialize(lib.root, entry, materialized)
    before = notes.read(Library(materialized), row['id'])
    assert (before['content'], before['parent_id']) == ('Before 日本語', owner)
    assert notes.read(Library(lib.root), row['id'])['content'] == 'After 日本語'

    history_restore.restore_entry(lib, entry, threading.Event(), lambda _: None, import_settings=False)
    restored = notes.read(Library(lib.root), row['id'])
    assert (restored['content'], restored['parent_id']) == ('Before 日本語', owner)
