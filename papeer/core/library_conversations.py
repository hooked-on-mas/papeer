"""Library's chat messages about a paper, a folder or the library (the messages table)."""
from __future__ import annotations

import json

from papeer.core.library_base import LibraryBase


class Conversations(LibraryBase):
    """The questions and answers of each paper and scope."""

    def messages(self, paper_id: str, with_usage: bool = False, scope: str | None = None) -> list[dict]:
        with self.connection() as db:
            condition = " WHERE paper_id=?" + (" AND scope=?" if scope is not None else "")
            values = (paper_id, scope) if scope is not None else (paper_id,)
            rows = db.execute("SELECT role,content,usage,attachments,research FROM messages" + condition + " ORDER BY id", values)
            result = []
            for row in rows:
                item = {"role": row["role"], "content": row["content"]}
                if row["attachments"]:
                    item["attachments"] = json.loads(row["attachments"])
                if with_usage:
                    item["usage"] = json.loads(row["usage"]) if row["usage"] else None
                    if row["research"]:
                        item["research"] = json.loads(row["research"])
                result.append(item)
            return result

    def add_exchange(self, paper_id: str, question: str, answer: str, usage: dict | None = None,
                     scope: str = "paper", attachments: list[dict] | None = None, research: dict | None = None) -> None:
        with self.connection() as db:
            db.executemany("INSERT INTO messages(paper_id,role,content,usage,scope,attachments,research) VALUES(?,?,?,?,?,?,?)",
                           [(paper_id, "user", question, None, scope,
                             json.dumps(attachments, ensure_ascii=False) if attachments else None,
                             json.dumps(research, ensure_ascii=False) if research else None),
                            (paper_id, "assistant", answer, json.dumps(usage) if usage else None, scope, None,
                             json.dumps(research, ensure_ascii=False) if research else None)])
