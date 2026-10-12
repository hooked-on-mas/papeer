"""Tests that exercise sync/history use an ordinary md attachment as their mutable content."""


def read_memo(lib, identity):
    rows = [row for row in lib.attachments(identity) if row["format"] == "md"]
    return lib.attachment_text(rows[0]["id"]) if rows else ""


def set_memo(lib, identity, *, note, **fields):
    if fields:
        lib.update(identity, **fields)
    rows = [row for row in lib.attachments(identity) if row["format"] == "md"]
    if rows:
        lib.update_attachment(identity, rows[0]["id"], content=note)
    else:
        lib.add_attachment(identity, "md", "メモ.md", note)
