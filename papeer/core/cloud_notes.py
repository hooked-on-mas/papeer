"""Immutable note versions shared with Web clients; conflicts retain both documents."""
from __future__ import annotations

import hashlib
import json
import re
import uuid

from papeer.core import notes, notebook
from papeer.core.fileio import atomic_write_bytes, atomic_write_text
from papeer.core.ink_model import InkStroke
from papeer.providers import check_cancel


def record(lib, identity):
    row = notes.read(lib, identity)
    value = {key: row[key] for key in ('id', 'kind', 'title', 'parent_id', 'collection_name', 'note_position')}
    if row['kind'] == 'markdown':
        value['content'] = row['content']
    else:
        value['document'] = notebook.read(lib, identity)
        strokes = lib.ink_by_page(identity, 'original')
        value['ink'] = {page['id']: strokes.get(number, []) for number, page in enumerate(value['document']['pages'], 1)}
    value['revision'] = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return value


def validate(value):
    from sidecar.routes.notebooks import NotebookDocument
    if not isinstance(value, dict) or not re.fullmatch(r'[0-9a-f]{32}', value.get('id', '')):
        raise ValueError('ノートIDが不正です。')
    if value.get('kind') not in ('markdown', 'notebook') or not isinstance(value.get('title'), str) or not value['title'].strip() or len(value['title']) > 200:
        raise ValueError('ノートの形式が不正です。')
    if value.get('parent_id') is not None and not re.fullmatch(r'[0-9a-f]{32}', value['parent_id']):
        raise ValueError('持ち主IDが不正です。')
    if not isinstance(value.get('collection_name'), str) or not isinstance(value.get('note_position'), int) or value['note_position'] < 0:
        raise ValueError('ノートの配置が不正です。')
    if value['kind'] == 'markdown':
        if not isinstance(value.get('content'), str):
            raise ValueError('Markdown本文が不正です。')
    else:
        document = NotebookDocument.model_validate(value.get('document')).model_dump()
        if not 1 <= len(document['pages']) <= 500 or len({p['id'] for p in document['pages']}) != len(document['pages']):
            raise ValueError('ノートのページが不正です。')
        for page in document['pages']:
            if not re.fullmatch(r'[0-9a-f]{32}', page['id']):
                raise ValueError('ページIDが不正です。')
            expected = notebook.page_spec(**{k: page[k] for k in ('size', 'orientation', 'template', 'color')}, identity=page['id'])
            if page != expected:
                raise ValueError('用紙の寸法が不正です。')
        ink = value.get('ink')
        if not isinstance(ink, dict) or set(ink) - {p['id'] for p in document['pages']}:
            raise ValueError('描画ページが不正です。')
        for strokes in ink.values():
            for stroke in strokes:
                InkStroke.model_validate(stroke)
    return value


def _install(lib, journal, path):
    target, payload, operation = journal['target'], journal['payload'], journal['operation']
    folder = lib.folder(target)
    if payload is not None:
        folder.mkdir(parents=True, exist_ok=True)
        import shutil
        source_media = lib.folder(operation['note_id']) / 'media'
        if target != operation['note_id'] and source_media.exists():
            shutil.copytree(source_media, folder / 'media', dirs_exist_ok=True)
        if payload['kind'] == 'notebook':
            document_path = folder / 'notebook.json'
            # Ink-only revision writes share the document session with the PDF surface.
            # Its paper resource is unchanged: do not regenerate/reload it for every stroke.
            previous = json.loads(document_path.read_text('utf-8')) if document_path.is_file() else None
            if previous != payload['document']:
                atomic_write_text(document_path, json.dumps(payload['document']))
            if previous != payload['document'] or not (folder / 'original.pdf').is_file():
                atomic_write_bytes(folder / 'original.pdf', notebook.pdf(payload['document']))
        else:
            atomic_write_text(folder / 'note.md', payload['content'])
    with lib.connection() as db:
        db.execute('BEGIN IMMEDIATE')
        if payload is not None:
            parent = payload.get('parent_id')
            if parent and not db.execute('SELECT 1 FROM papers WHERE id=? AND parent_id IS NULL', (parent,)).fetchone():
                parent = None
            destination = notes.validate_placement(db, target, parent, payload['collection_name'])
            page_count = len(payload['document']['pages']) if payload['kind'] == 'notebook' else 0
            marker = payload['kind'] + ':' + target + ':' + operation['id']
            db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,status,kind,parent_id,collection_name,note_position) VALUES(?,?,?,?,?,'not_translated',?,?,?,?) ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256,title=excluded.title,original_name=excluded.original_name,pages=excluded.pages,parent_id=excluded.parent_id,collection_name=excluded.collection_name,note_position=excluded.note_position", (target, marker, payload['title'], payload['title'], page_count, payload['kind'], parent, destination, payload['note_position']))
            db.execute("INSERT INTO note_state(id,revision,content) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content=excluded.content,updated_at=CURRENT_TIMESTAMP", (target, operation['id'], payload.get('content', '')))
            if payload['kind'] == 'notebook':
                db.execute('DELETE FROM pages WHERE paper_id=?', (target,))
                db.execute('DELETE FROM pdf_ink WHERE paper_id=?', (target,))
                db.execute('DELETE FROM bookmarks WHERE paper_id=?', (target,))
                for number, page in enumerate(payload['document']['pages'], 1):
                    db.execute("INSERT INTO pages VALUES(?,?,'')", (target, number))
                    for entry in journal.get('bookmarks', []):
                        if entry['page_id'] != page['id']:
                            continue
                        mark = {k: v for k, v in entry['mark'].items() if k != 'id' or target == operation['note_id']}
                        mark.update(paper_id=target, page=number)
                        db.execute(f"INSERT INTO bookmarks({','.join(mark)}) VALUES({','.join('?' for _ in mark)})", list(mark.values()))
                    strokes = payload['ink'].get(page['id'], [])
                    if strokes:
                        db.execute("INSERT INTO pdf_ink(paper_id,side,page,strokes) VALUES(?,'original',?,?)", (target, number, json.dumps(strokes)))
        # The operation ledger is committed after all files and rows agree.
    if payload is not None:
        operation = {**operation, 'result_revision': record(lib, target)['revision']}
    with lib.connection() as db:
        db.execute('INSERT OR IGNORE INTO note_operations VALUES(?,?)', (operation['id'], json.dumps(operation)))
    path.unlink(missing_ok=True)


def recover(lib):
    for path in (lib.root / '.note-imports').glob('*.json'):
        journal = json.loads(path.read_text('utf-8'))
        with lib.connection() as db:
            done = db.execute('SELECT 1 FROM note_operations WHERE id=?', (journal['operation']['id'],)).fetchone()
        if done:
            path.unlink()
        else:
            _install(lib, journal, path)


def apply(lib, operation, payload):
    identity = operation['note_id']
    with notebook.lock(lib.root, 'placement'), notebook.lock(lib.root, identity):
        with lib.connection() as db:
            if db.execute('SELECT 1 FROM note_operations WHERE id=?', (operation['id'],)).fetchone():
                return
            exists = db.execute('SELECT kind FROM papers WHERE id=?', (identity,)).fetchone()
        current = record(lib, identity) if exists else None
        conflict = (current or {}).get('revision') != operation['base']
        with lib.connection() as db:
            latest = db.execute('SELECT operation FROM note_operations').fetchall()
        for saved in latest:
            previous = json.loads(saved[0])
            if previous.get('note_id') == identity and previous.get('result_revision') == (current or {}).get('revision') and previous['id'] == operation['base']:
                conflict = False
        if payload is None:
            if current and not conflict:
                lib.delete_paper(identity, keep_notebooks=True)
            with lib.connection() as db:
                db.execute('INSERT OR IGNORE INTO note_operations VALUES(?,?)', (operation['id'], json.dumps(operation)))
            return
        validate(payload)
        if payload['id'] != identity or (current and current['kind'] != payload['kind']):
            raise ValueError('変更対象のノートの種類またはIDが一致しません。')
        target = uuid.UUID(operation['id']).hex if conflict else identity
        payload = {**payload, 'id': target}
        if conflict:
            from papeer.core.edit_model import conflict_title
            payload.update(title=conflict_title(payload['title']), parent_id=None)
        with lib.connection() as db:
            parent = payload.get('parent_id')
            if parent and not db.execute('SELECT 1 FROM papers WHERE id=? AND parent_id IS NULL', (parent,)).fetchone():
                payload['parent_id'] = None
            notes.validate_placement(db, target, payload.get('parent_id'), payload['collection_name'])
        # Intent is durable before replacing files. Startup completes an interrupted import.
        path = lib.root / '.note-imports' / (uuid.UUID(operation['id']).hex + '.json')
        path.parent.mkdir(exist_ok=True)
        marks = []
        if current and current['kind'] == 'notebook':
            with lib.connection() as db:
                old_pages = current['document']['pages']
                for mark in db.execute('SELECT * FROM bookmarks WHERE paper_id=?', (identity,)):
                    if 1 <= mark['page'] <= len(old_pages):
                        marks.append({'page_id': old_pages[mark['page'] - 1]['id'], 'mark': dict(mark)})
        journal = {'target': target, 'payload': payload, 'operation': operation, 'bookmarks': marks}
        atomic_write_text(path, json.dumps(journal, ensure_ascii=False))
        _install(lib, journal, path)


def import_operations(lib, drive, library_id, cancel):
    from papeer.core.cloud_drive import API
    remote = drive.list("properties has { key='papeer' and value='notes-v1' } and " + f"properties has {{ key='library' and value='{library_id}' }}")
    with lib.connection() as db:
        known = {r[0] for r in db.execute('SELECT id FROM note_operations')}
    pending = {}
    for file in remote:
        check_cancel(cancel)
        if not re.fullmatch(r'note-[a-f0-9-]{36}\.json', file.get('name', '')):
            continue
        if int(file.get('size', 0)) > 4096:
            raise ValueError('ノートの変更情報が大きすぎます。')
        op = drive.json(API + '/' + file['id'] + '?alt=media')
        if op.get('version') != 1 or op.get('library_id') != library_id:
            raise ValueError('別ライブラリのノート変更です。')
        uuid.UUID(op['id'])
        if op['id'] in known:
            continue
        if not re.fullmatch(r'[0-9a-f]{32}', op.get('note_id', '')):
            raise ValueError('ノートIDが不正です。')
        previous = pending.get(op['id'])
        if previous and (previous['note_id'], previous['base'], previous.get('blob', {}).get('sha256')) != (op['note_id'], op['base'], op.get('blob', {}).get('sha256')):
            raise ValueError('同じ変更IDの内容が一致しません。')
        pending[op['id']] = op
    while pending:
        ready = sorted(key for key, op in pending.items() if op['base'] not in pending)
        if not ready:
            raise ValueError('ノートの変更履歴が循環しています。')
        for key in ready:
            op = pending.pop(key)
            payload = None
            if op.get('blob'):
                blob = op['blob']
                if not re.fullmatch(r'[\w-]+', blob['id']) or not 0 < blob['size'] <= 20 * 1024 * 1024:
                    raise ValueError('ノート本文ファイルが不正です。')
                with drive.request(API + '/' + blob['id'] + '?alt=media') as response:
                    raw = response.read(20 * 1024 * 1024 + 1)
                if len(raw) != blob['size'] or hashlib.sha256(raw).hexdigest() != blob['sha256']:
                    raise ValueError('ノート本文のハッシュが一致しません。')
                data = json.loads(raw)
                payload = data
            apply(lib, op, payload)
