from __future__ import annotations

from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, Field

from paperdesk.core import reading_tools as tools


class TemplateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    content: str = Field(min_length=1, max_length=50000)


class TagRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


def register_reading_api(app, verify_token):
    # Resolve the runtime on each call so app settings, tests and API keys share one source.
    from sidecar import app as runtime

    @app.get("/api/tags", dependencies=[Depends(verify_token)])
    def tags():
        lib = runtime.get_library()
        with lib.connection() as db:
            names = {row[0] for row in db.execute("SELECT name FROM tag_choices WHERE kind='paper'")}
        return sorted(names | {tag for paper in lib.papers() for tag in paper["tags"]}, key=str.casefold)

    @app.post("/api/tags", dependencies=[Depends(verify_token)])
    def add_tag(body: TagRequest):
        return save_choice("paper", body.name)

    def save_choice(kind, value):
        name = value.strip()
        if not name or (kind == "sticky" and len(name) > 40):
            raise HTTPException(status_code=400, detail="名前を入力してください（付箋の分類は40文字まで）。")
        with runtime.get_library().connection() as db:
            if kind == "status":
                db.execute("INSERT OR IGNORE INTO reading_status_choices VALUES(?)", (name,))
            else:
                db.execute("INSERT OR IGNORE INTO tag_choices VALUES(?,?)", (kind, name))
        return {"name": name}

    @app.get("/api/reading-statuses", dependencies=[Depends(verify_token)])
    def reading_statuses():
        with runtime.get_library().connection() as db:
            return [row[0] for row in db.execute("SELECT name FROM reading_status_choices ORDER BY rowid")]

    @app.post("/api/reading-statuses", dependencies=[Depends(verify_token)])
    def add_reading_status(body: TagRequest):
        return save_choice("status", body.name)

    @app.delete("/api/reading-statuses", dependencies=[Depends(verify_token)])
    def delete_reading_status(name: str = Query(min_length=1, max_length=80)):
        with runtime.get_library().connection() as db:
            db.execute("DELETE FROM reading_status_choices WHERE name=?", (name,))
        return {"status": "deleted"}

    @app.get("/api/sticky-labels", dependencies=[Depends(verify_token)])
    def sticky_labels():
        with runtime.get_library().connection() as db:
            return [row[0] for row in db.execute("SELECT name FROM tag_choices WHERE kind='sticky' ORDER BY rowid")]

    @app.post("/api/sticky-labels", dependencies=[Depends(verify_token)])
    def add_sticky_label(body: TagRequest):
        return save_choice("sticky", body.name)

    @app.delete("/api/sticky-labels", dependencies=[Depends(verify_token)])
    def delete_sticky_label(name: str = Query(min_length=1, max_length=40)):
        with runtime.get_library().connection() as db:
            db.execute("DELETE FROM tag_choices WHERE kind='sticky' AND name=?", (name,))
        return {"status": "deleted"}

    @app.delete("/api/tags", dependencies=[Depends(verify_token)])
    def delete_tag(name: str = Query(min_length=1, max_length=80)):
        try:
            affected = runtime.get_library().remove_tag(name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        runtime.job_manager.broadcast({"type": "library.changed"})
        return {"affected": affected}

    @app.get("/api/note-templates", dependencies=[Depends(verify_token)])
    def templates():
        with runtime.get_library().connection() as db:
            return [{"name": "読書メモ", "content": tools.DEFAULT_TEMPLATE, "builtin": True},
                    *[dict(row, builtin=False) for row in db.execute("SELECT * FROM note_templates ORDER BY name")]]

    @app.put("/api/note-templates", dependencies=[Depends(verify_token)])
    def save_template(body: TemplateRequest):
        name = body.name.strip()
        if not name or name == "読書メモ" or not body.content.strip():
            raise HTTPException(status_code=400, detail="テンプレート名と本文を入力してください。標準名は変更できません。")
        with runtime.get_library().connection() as db:
            db.execute("INSERT OR REPLACE INTO note_templates(name,content) VALUES(?,?)", (name, body.content))
        return {"status": "saved"}

    @app.delete("/api/note-templates/{name}", dependencies=[Depends(verify_token)])
    def delete_template(name: str):
        with runtime.get_library().connection() as db:
            db.execute("DELETE FROM note_templates WHERE name=?", (name,))
        return {"status": "deleted"}

    @app.get("/api/library-search", dependencies=[Depends(verify_token)])
    def search(q: str = ""):
        try:
            return tools.library_search(runtime.get_library(), q)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
