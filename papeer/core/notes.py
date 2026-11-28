"""Shared note records. SQLite commits the version; note.md is a recoverable file mirror."""
from __future__ import annotations

import json
import hashlib
from datetime import datetime, timezone
import re
import shutil
import uuid

from papeer.core.collection_paths import normalize_collection_name
from papeer.core.errors import Conflict, Invalid, NotFound
from papeer.core.fileio import atomic_write_text


def migrate(db, root):
    db.execute("ALTER TABLE papers ADD COLUMN note_position INTEGER NOT NULL DEFAULT 0")
    db.execute("CREATE TABLE note_state (id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE, revision TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'user', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    db.execute("CREATE TABLE note_legacy (id TEXT PRIMARY KEY, note_id TEXT NOT NULL)")
    db.execute("CREATE TABLE note_operations (id TEXT PRIMARY KEY, operation TEXT NOT NULL)")
    migrate_legacy(db, root)


def migrate_legacy(db, root):
    for identity, owner, title, position, created, updated, source_kind in db.execute(
            "SELECT id,owner_id,title,position,created_at,updated_at,source FROM attachments WHERE format='md'").fetchall():
        source = root / 'papers' / owner / 'attachments' / (identity + '.md')
        content = source.read_text('utf-8')  # Missing input aborts migration, preserving the previous schema.
        folder = root / 'papers' / identity
        folder.mkdir(parents=True, exist_ok=True)
        media = root / 'papers' / owner / 'media'
        if media.exists():
            shutil.copytree(media, folder / 'media', dirs_exist_ok=True)
        content = re.sub(r'(?:file:///[^\s)]+/)?papers/' + owner + r'/media/', 'media/', content)
        content = content.replace('/api/papers/' + owner + '/media/', 'media/')
        atomic_write_text(folder / 'note.md', content)
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,status,kind,parent_id,created_at,note_position) VALUES(?,?,?,?,0,'not_translated','markdown',?,?,?)",
                   (identity, 'markdown:' + identity, title, title, owner, created, position))
        # The same archive is migrated during sync validation and again after
        # installation. Both must have the same fingerprint and note revision.
        revision = uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(
            ['papeer:legacy-note', identity, content, source_kind, updated], ensure_ascii=False)).hex
        db.execute("INSERT INTO note_state VALUES(?,?,?,?,?)", (identity, revision, content, source_kind, updated))
        db.execute("INSERT INTO note_legacy VALUES(?,?)", (identity, identity))
        db.execute("DELETE FROM attachments WHERE id=?", (identity,))


def attachment(row):
    return dict(id=row['id'], owner_id=row['parent_id'], format='md', title=row['title'],
                source=row.get('source', 'user'), position=row['note_position'], created_at=row['created_at'], updated_at=row['updated_at'])


def own_media(lib, identity, parent, content):
    """Capture references belong to the note, including after it is detached from its owner."""
    pattern = r'(?:/api/papers/([0-9a-f]{32})/)?media/([A-Za-z0-9_.-]+\.png)'

    def copy(match):
        owner, name = match.groups()
        if not owner and (lib.folder(identity) / 'media' / name).is_file():
            return match.group(0)
        owner = owner or parent
        if not owner:
            return match.group(0)
        source = lib.folder(owner) / 'media' / name
        if not source.is_file():
            return match.group(0)
        target_name = owner + '-' + name
        target = lib.folder(identity) / 'media' / target_name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        return 'media/' + target_name

    return re.sub(pattern, copy, content)


def list_notes(lib):
    with lib.connection() as db:
        ids = [r[0] for r in db.execute("SELECT id FROM papers WHERE kind IN ('markdown','notebook') ORDER BY note_position,created_at,id")]
    return [read(lib, identity) for identity in ids]


def read(lib, identity):
    from papeer.core.notebook import lock
    with lock(lib.root, identity):
        return _read(lib, identity)


def _read(lib, identity):
    row = lib.paper(identity)
    if row['kind'] not in ('markdown', 'notebook'):
        raise NotFound('ノートが見つかりません。')
    with lib.connection() as db:
        state = db.execute('SELECT * FROM note_state WHERE id=?', (identity,)).fetchone()
    version = state['revision'] if state else row['sha256']
    revision = hashlib.sha256(json.dumps([version, row['title'], row['parent_id'], row['collection_name'], row['note_position']]).encode()).hexdigest()
    result = {**row, 'revision': revision}
    if row['kind'] == 'notebook':
        with lib.connection() as db:
            ink = [tuple(r) for r in db.execute("SELECT page,strokes FROM pdf_ink WHERE paper_id=? AND side='original' ORDER BY page", (identity,))]
        result['revision'] = hashlib.sha256(json.dumps([row['sha256'], result['revision'], ink]).encode()).hexdigest()
    if row['kind'] == 'markdown':
        if state is None:
            raise Invalid('ノートの本文を読み込めません。')
        result.update(content=state['content'], source=state['source'], updated_at=state['updated_at'])
        path = lib.folder(identity) / 'note.md'
        if not path.exists() or path.read_text('utf-8') != state['content']:
            atomic_write_text(path, state['content'])
    return result


def validate_placement(db, identity, parent_id, collection):
    if parent_id:
        parent = db.execute('SELECT parent_id,collection_name FROM papers WHERE id=?', (parent_id,)).fetchone()
        if parent is None:
            raise NotFound('持ち主が見つかりません。')
        if parent_id == identity or parent[0] is not None:
            raise Invalid('付属ノートの中にはノートを作れません。')
        if db.execute('SELECT 1 FROM papers WHERE parent_id=?', (identity,)).fetchone() or db.execute(
                'SELECT 1 FROM attachments WHERE owner_id=?', (identity,)).fetchone() or db.execute(
                'SELECT 1 FROM item_links WHERE a=? OR b=?', (identity, identity)).fetchone():
            raise Invalid('付属ノートや資料、関連付けを整理してから付属化してください。')
        return parent[1]
    return normalize_collection_name(collection)


def create(lib, title, *, kind='markdown', collection='', parent_id=None, content='', spec=None, identity=None):
    title = ' '.join(title.split())
    if not title or len(title) > 200:
        raise Invalid('ノート名は1〜200文字で入力してください。')
    if kind == 'notebook':
        from papeer.core import notebook
        return read(lib, notebook.create(lib, title, spec or {}, collection, parent_id))
    if kind != 'markdown':
        raise Invalid('ノートの種類が不正です。')
    identity = identity or uuid.uuid4().hex
    folder = lib.folder(identity)
    with lib.connection() as db:
        db.execute('BEGIN IMMEDIATE')
        destination = validate_placement(db, identity, parent_id, collection)
        content = own_media(lib, identity, parent_id, content)
        folder.mkdir(parents=True, exist_ok=True)
        atomic_write_text(folder / 'note.md', content)
        position = db.execute('SELECT COALESCE(MAX(position),-1)+1 FROM (SELECT note_position AS position FROM papers WHERE parent_id IS ? UNION ALL SELECT position FROM attachments WHERE owner_id IS ?)', (parent_id, parent_id)).fetchone()[0]
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,status,kind,parent_id,collection_name,note_position) VALUES(?,?,?,?,0,'not_translated','markdown',?,?,?)",
                   (identity, 'markdown:' + identity, title, title, parent_id, destination, position))
        db.execute('INSERT INTO note_state(id,revision,content) VALUES(?,?,?)', (identity, uuid.uuid4().hex, content))
    return read(lib, identity)


def update(lib, identity, revision, **changes):
    from papeer.core.notebook import lock
    with lock(lib.root, 'placement'), lock(lib.root, identity):
        before = read(lib, identity)
        with lib.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            current = before['revision']
            if current != revision:
                raise Conflict('別の変更が保存されました。再読み込みして確認してください。')
            if 'title' in changes:
                title = ' '.join(changes['title'].split())
                if not title or len(title) > 200:
                    raise Invalid('ノート名は1〜200文字で入力してください。')
                db.execute('UPDATE papers SET title=?,original_name=? WHERE id=?', (title, title, identity))
            if 'parent_id' in changes or 'collection' in changes:
                parent = changes.get('parent_id', before['parent_id'])
                destination = validate_placement(db, identity, parent, changes.get('collection', before['collection_name']))
                db.execute('UPDATE papers SET parent_id=?,collection_name=? WHERE id=?', (parent, destination, identity))
            content = changes.get('content', before.get('content', ''))
            if 'content' in changes and before['kind'] != 'markdown':
                raise Invalid('手書きノートにはMarkdown本文を保存できません。')
            if before['kind'] == 'markdown':
                content = own_media(lib, identity, before['parent_id'], content)
            db.execute("INSERT INTO note_state(id,revision,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content=excluded.content,updated_at=excluded.updated_at",
                       (identity, uuid.uuid4().hex, content, datetime.now(timezone.utc).isoformat()))
        return read(lib, identity)


def reorder(lib, owner, ids):
    with lib.connection() as db:
        db.execute('BEGIN IMMEDIATE')
        actual = {r[0] for r in db.execute('SELECT id FROM papers WHERE parent_id=?', (owner,))}
        if len(set(ids)) != len(ids) or set(ids) != actual:
            raise Conflict('付属ノートの一覧が変わりました。')
        db.executemany('UPDATE papers SET note_position=? WHERE id=?', enumerate(ids))
