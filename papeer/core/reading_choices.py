"""Reading metadata offered in the UI: the choices of paper tags, sticky-note labels and reading statuses,
and the note templates (the built-in one first)."""
from __future__ import annotations

from papeer.core.errors import Invalid
from papeer.core.storage import Library


DEFAULT_TEMPLATE = "\n\n".join("## " + heading for heading in (
    "何を解決する論文？", "新しい点", "主な結果", "前提・限界", "自分に使えそうな点", "疑問・次に調べること"))
# The built-in template's name: always offered first, and never saved over.
DEFAULT_TEMPLATE_NAME = "読書メモ"


# --- Choices offered in the UI: paper tags, sticky-note labels ("sticky"), reading statuses ("status") ---

def all_tags(lib: Library) -> list[str]:
    """Every paper tag the UI offers: the saved choices and the tags papers carry, in case-insensitive order."""
    names = set(lib.tag_choices("paper"))
    return sorted(names | {tag for paper in lib.papers() for tag in paper["tags"]}, key=str.casefold)


def choice_name(kind: str, value: str) -> str:
    """The name of a new choice of `kind` ("paper", "sticky" or "status"), trimmed; Invalid when unusable."""
    name = value.strip()
    if not name or (kind == "sticky" and len(name) > 40):
        raise Invalid("名前を入力してください（付箋の分類は40文字まで）。")
    return name


def add_choice(lib: Library, kind: str, name: str) -> None:
    """Offer `name` (checked by choice_name) among the choices of `kind`."""
    if kind == "status":
        lib.add_reading_status(name)
    else:
        lib.add_tag_choice(kind, name)


# --- Note templates ---

def note_templates(lib: Library) -> list[dict]:
    """The built-in template first, then the user's (by name); "builtin" tells them apart."""
    return [{"name": DEFAULT_TEMPLATE_NAME, "content": DEFAULT_TEMPLATE, "builtin": True},
            *[dict(row, builtin=False) for row in lib.note_templates()]]


def template_name(name: str, content: str) -> str:
    """The name a user's template is saved under, trimmed; Invalid when it is empty or the built-in one's,
    or when the template has no text."""
    name = name.strip()
    if not name or name == DEFAULT_TEMPLATE_NAME or not content.strip():
        raise Invalid("テンプレート名と本文を入力してください。標準名は変更できません。")
    return name
