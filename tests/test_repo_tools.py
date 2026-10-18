import io
from pathlib import Path
import sys

import pytest

from tools.clean import TARGETS, clean

ROOT = Path(__file__).resolve().parents[1]


def make_tree(root: Path) -> None:
    for name in TARGETS:
        (root / name / "nested").mkdir(parents=True)
        (root / name / "nested" / "file.bin").write_bytes(b"x" * 10)
    (root / "papeer").mkdir()
    (root / "papeer" / "keep.py").write_text("kept", encoding="utf-8")
    (root / "frontend" / "dist").mkdir(parents=True)


def test_clean_without_confirmation_only_lists(tmp_path):
    make_tree(tmp_path)
    out = io.StringIO()
    found = clean(tmp_path, confirm=False, out=out)
    assert [p.name for p in found] == list(TARGETS)
    assert all((tmp_path / name / "nested" / "file.bin").exists() for name in TARGETS)
    text = out.getvalue()
    assert "まだ削除していません" in text and "just clean yes" in text
    assert "tmp/  1 ファイル, 10 B" in text


def test_clean_with_confirmation_removes_only_the_targets(tmp_path):
    make_tree(tmp_path)
    (tmp_path / "tmp" / "nested" / "file.bin").chmod(0o444)  # read-only files must not stop the clean
    clean(tmp_path, confirm=True, out=io.StringIO())
    assert not any((tmp_path / name).exists() for name in TARGETS)
    assert (tmp_path / "papeer" / "keep.py").read_text(encoding="utf-8") == "kept"
    assert (tmp_path / "frontend" / "dist").is_dir()  # only the repository-root folders are targets
    out = io.StringIO()
    assert clean(tmp_path, confirm=True, out=out) == []
    assert "削除対象はありません" in out.getvalue()


@pytest.mark.skipif(sys.platform != "win32", reason="directory junctions are Windows only")
def test_clean_unlinks_a_junction_without_deleting_its_target(tmp_path):
    import _winapi

    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "precious.txt").write_text("keep", encoding="utf-8")
    repo = tmp_path / "repo"
    repo.mkdir()
    _winapi.CreateJunction(str(outside), str(repo / "tmp"))
    out = io.StringIO()
    clean(repo, confirm=True, out=out)
    assert "リンク" in out.getvalue()
    assert not (repo / "tmp").exists()
    assert (outside / "precious.txt").read_text(encoding="utf-8") == "keep"


def test_build_recipe_installs_pyinstaller_from_the_build_group():
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")
    lines = [line.strip() for line in justfile.splitlines() if "pyinstaller" in line and not line.lstrip().startswith("#")]
    assert lines and all(line.startswith("uv run --group build pyinstaller") for line in lines)


@pytest.mark.skipif(sys.platform != "win32", reason="directory junctions are Windows only")
def test_clean_neither_counts_nor_deletes_what_a_nested_junction_points_to(tmp_path):
    import _winapi

    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "precious.bin").write_bytes(b"y" * 1000)
    repo = tmp_path / "repo"
    (repo / "output").mkdir(parents=True)
    (repo / "output" / "own.bin").write_bytes(b"x" * 10)
    _winapi.CreateJunction(str(outside), str(repo / "output" / "link"))
    out = io.StringIO()
    clean(repo, confirm=False, out=out)
    assert "output/  1 ファイル, 10 B" in out.getvalue()
    clean(repo, confirm=True, out=io.StringIO())
    assert not (repo / "output").exists()
    assert (outside / "precious.bin").read_bytes() == b"y" * 1000
