"""Revision-checked operations shared by handwritten and Markdown notes."""
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from papeer.core import notes
from sidecar import deps
from sidecar.routes.notebooks import NotebookPaper

router = APIRouter(dependencies=[Depends(deps.verify_token)])


class NewNote(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: Literal['markdown', 'notebook'] = 'markdown'
    title: str = Field(min_length=1, max_length=200)
    content: str = ''
    parent_id: str | None = None
    collection: str = ''
    spec: NotebookPaper | None = None


class EditNote(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: str
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = None
    parent_id: str | None = None
    collection: str | None = None


class NoteOrder(BaseModel):
    ids: list[str] = Field(max_length=10000)


@router.get('/api/notes')
def list_notes():
    return notes.list_notes(deps.get_library())


@router.post('/api/notes')
def create_note(body: NewNote):
    values = body.model_dump(exclude={'spec'})
    row = notes.create(deps.get_library(), **values, spec=body.spec.model_dump() if body.spec else None)
    deps.library_changed()
    return row


@router.put('/api/notes/owners/{owner}/order')
def order_notes(owner: str, body: NoteOrder):
    notes.reorder(deps.get_library(), owner, body.ids)
    deps.library_changed()
    return {'status': 'updated'}


@router.get('/api/notes/{identity}')
def get_note(identity: str):
    return notes.read(deps.get_library(), identity)


@router.get('/api/notes/{identity}/document')
def note_document(identity: str):
    from papeer.core.cloud_notes import record
    return record(deps.get_library(), identity)


class NoteVersion(BaseModel):
    revision: str
    note: dict


@router.put('/api/notes/{identity}/document')
def put_document(identity: str, body: NoteVersion):
    import uuid
    from papeer.core import cloud_notes, notebook
    from papeer.core.errors import Conflict, Invalid
    lib = deps.get_library()
    cloud_notes.validate(body.note)
    if body.note['id'] != identity:
        raise Invalid('ノートIDが一致しません。')
    with notebook.lock(lib.root, 'placement'), notebook.lock(lib.root, identity):
        if cloud_notes.record(lib, identity)['revision'] != body.revision:
            raise Conflict('別の変更が保存されました。下書きを確認してください。')
        cloud_notes.apply(lib, {'id': str(uuid.uuid4()), 'note_id': identity, 'base': body.revision}, body.note)
    deps.library_changed()
    return cloud_notes.record(lib, identity)


@router.patch('/api/notes/{identity}')
def edit_note(identity: str, body: EditNote):
    changes = body.model_dump(exclude={'revision'}, exclude_unset=True)
    if any(value is None for key, value in changes.items() if key != 'parent_id'):
        from papeer.core.errors import Invalid
        raise Invalid('変更内容が不正です。')
    result = notes.update(deps.get_library(), identity, body.revision, **changes)
    deps.library_changed()
    return result


@router.delete('/api/notes/{identity}')
def delete_note(identity: str, revision: str, keep_notes: bool = False):
    from papeer.core.errors import Conflict
    lib = deps.get_library()
    from papeer.core.notebook import lock
    with lock(lib.root, 'placement'), lock(lib.root, identity):
        if notes.read(lib, identity)['revision'] != revision:
            raise Conflict('ノートが変更されています。再読み込みしてください。')
        lib.delete_paper(identity, keep_notebooks=keep_notes)
    deps.library_changed()
    return {'status': 'deleted'}
