"""Content-based translation identity, also embedded into Windows builds."""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
import sys


# Explicit scope: UI, viewing, Windows integration and library management must
# not invalidate translations. Add new translation pipeline modules here.
TRANSLATION_SOURCES = (
    "translation/translation.py", "translation/translation_context.py", "core/service.py",
    "providers/base.py", "providers/common.py",
    "providers/codex.py", "providers/claude_code.py", "providers/antigravity.py", "providers/openai_compat.py",
    "layout/reading_flow.py", "pdf/pdf_engine.py", "layout/math_layout.py", "layout/figure_layout.py",
    "layout/table_layout.py", "layout/algorithm_layout.py", "layout/reference_layout.py", "pdf/pdf_math_crops.py",
    "pdf/pdf_typography.py", "pdf/pdf_fonts.py", "core/terminology.py", "layout/ocr_pages.py",
)


def source_version(root: Path) -> str:
    paths = [root / "papeer" / name for name in sorted(TRANSLATION_SOURCES)]
    digest = hashlib.sha256()
    for path in paths:
        name = path.relative_to(root).as_posix().encode("utf-8")
        # Windows checkout line endings do not change the application identity.
        content = path.read_bytes().replace(b"\r\n", b"\n")
        for value in (name, content):
            digest.update(len(value).to_bytes(8, "big"))
            digest.update(value)
    return "code-sha256-" + digest.hexdigest()


def application_version() -> str:
    if getattr(sys, "frozen", False):
        value = (Path(sys._MEIPASS) / "code-version.txt").read_text("utf-8").strip()
        if not re.fullmatch(r"code-sha256-[0-9a-f]{64}", value):
            raise ValueError("アプリのコードバージョンが不正です。再ビルドしてください。")
        return value
    return source_version(Path(__file__).resolve().parent.parent.parent)


if __name__ == "__main__":
    output = Path(sys.argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(application_version() + "\n", encoding="utf-8")
