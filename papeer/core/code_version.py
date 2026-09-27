"""Content hash of the code that draws translated PDFs, also embedded into Windows builds.

It no longer decides whether a translation is reused: translations are keyed by what the
model receives (papeer.translation.translation.TranslationKey), so editing this code only
redraws PDFs from the saved translations. The hash is recorded in translation reports and
shown in the status bar, and `just build-app` checks it against the bundled sidecar.
"""
from __future__ import annotations

import functools
import hashlib
from pathlib import Path
import re
import sys


# Explicit scope: extraction, layout and PDF drawing. UI, viewing, Windows integration,
# library management and AI communication are left out. Every module in RENDER_DIRECTORIES
# must be listed here or in RENDER_EXCLUDED (tests/test_code_version.py checks it).
RENDER_SOURCES = (
    "core/service.py",
    "layout/algorithm_layout.py", "layout/figure_layout.py", "layout/math_layout.py",
    "layout/reading_flow.py", "layout/reference_layout.py", "layout/table_layout.py",
    "pdf/pdf_engine.py", "pdf/pdf_fonts.py", "pdf/pdf_math_crops.py", "pdf/pdf_typography.py",
)
RENDER_DIRECTORIES = ("layout", "pdf", "translation", "providers")
RENDER_EXCLUDED = {
    "layout/__init__.py": "パッケージ定義のみ",
    "layout/page_selection.py": "入力されたページ範囲の解釈",
    "pdf/__init__.py": "パッケージ定義のみ",
    "pdf/pdf_capture.py": "読書メモ用の切り抜き画像",
    "pdf/pdf_ink.py": "書き込みの保存と書き出し",
    "pdf/pdf_viewer.py": "ビューアーのページ画像",
    "translation/__init__.py": "パッケージ定義のみ",
    # Translation inputs are keyed by TranslationKey (units, prompt, provider/model and the
    # hand-maintained TRANSLATION_PROTOCOL), not by these files.
    "translation/translation.py": "翻訳の依頼と検証（翻訳キャッシュは TRANSLATION_PROTOCOL で管理）",
    "translation/translation_context.py": "依頼にだけ添える前後の文脈",
    "translation/translation_preview.py": "翻訳中のページ表示の置き場所",
    "providers/__init__.py": "AI 接続（翻訳キャッシュは接続先・モデルで区別）",
    "providers/antigravity.py": "AI 接続（翻訳キャッシュは接続先・モデルで区別）",
    "providers/base.py": "AI 接続（翻訳キャッシュは接続先・モデルで区別）",
    "providers/claude_code.py": "AI 接続（翻訳キャッシュは接続先・モデルで区別）",
    "providers/codex.py": "AI 接続（翻訳キャッシュは接続先・モデルで区別）",
    "providers/common.py": "AI 接続（翻訳キャッシュは接続先・モデルで区別）",
    "providers/openai_compat.py": "AI 接続（翻訳キャッシュは接続先・モデルで区別）",
    "providers/registry.py": "接続先の一覧",
}
SIDECAR_BINARY = Path("frontend/src-tauri/sidecar-x86_64-pc-windows-msvc.exe")
# What PyInstaller bundles from the source tree (sidecar.spec) and the dependencies it installs.
_BUNDLED = ("papeer", "sidecar", "sidecar.spec", "pyproject.toml", "uv.lock")


def _digest(root: Path, paths) -> str:
    digest = hashlib.sha256()
    for path in paths:
        name = path.relative_to(root).as_posix().encode("utf-8")
        # Windows checkout line endings do not change the application identity.
        content = path.read_bytes().replace(b"\r\n", b"\n")
        for value in (name, content):
            digest.update(len(value).to_bytes(8, "big"))
            digest.update(value)
    return digest.hexdigest()


def source_version(root: Path) -> str:
    return "code-sha256-" + _digest(root, [root / "papeer" / name for name in sorted(RENDER_SOURCES)])


def bundle_version(root: Path) -> str:
    """Content hash of everything the sidecar is built from; file times (a git checkout) do not count."""
    paths = [path for name in _BUNDLED
             for path in ((root / name).rglob("*") if (root / name).is_dir() else [root / name])
             if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"]
    return "bundle-sha256-" + _digest(root, sorted(paths, key=lambda path: path.relative_to(root).as_posix()))


def application_version() -> str:
    if getattr(sys, "frozen", False):
        value = (Path(sys._MEIPASS) / "code-version.txt").read_text("utf-8").strip()
        if not re.fullmatch(r"code-sha256-[0-9a-f]{64}", value):
            raise ValueError("アプリのコードバージョンが不正です。再ビルドしてください。")
        return value
    return source_version(Path(__file__).resolve().parent.parent.parent)


@functools.lru_cache(maxsize=1)
def loaded_version() -> str:
    """application_version() at first use: code edited while the app runs applies after a restart."""
    return application_version()


def check_build(root: Path, record: Path, bundle: Path) -> list[str]:
    """Why the sidecar next to the Tauri app is not built from the current source (empty when it is).

    `bundle` holds bundle_version() as `just build-sidecar` wrote it after copying the sidecar.
    """
    problems = []
    if not record.is_file() or record.read_text("utf-8").strip() != source_version(root):
        problems.append(f"{record.name} が現在のソースと一致しません。")
    if not (root / SIDECAR_BINARY).is_file():
        problems.append(f"{SIDECAR_BINARY.as_posix()} がありません。")
    if not bundle.is_file() or bundle.read_text("utf-8").strip() != bundle_version(root):
        problems.append(f"sidecar のビルド後にソースまたは依存関係が変更されています（{bundle.name} と不一致）。")
    return problems


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent.parent
    if sys.argv[1] == "--check":
        found = check_build(root, root / sys.argv[2], root / sys.argv[3])
        if found:
            print("\n".join(found) + "\n先に just build-sidecar を実行してください。", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)
    if sys.argv[1] == "--record-bundle":
        (root / sys.argv[2]).write_text(bundle_version(root) + "\n", encoding="utf-8")
        sys.exit(0)
    output = Path(sys.argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(application_version() + "\n", encoding="utf-8")
