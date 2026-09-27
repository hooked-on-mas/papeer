"""Remove local build and scratch folders (build, dist, output, tmp) after listing them.

Without --yes nothing is deleted: the folders and their sizes are only printed, so
`just clean` is a dry run and `just clean yes` deletes. Nothing outside these four
folders at the repository root is touched; a folder that is a symbolic link or a
junction is unlinked without following it.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import stat
import sys

ROOT = Path(__file__).resolve().parents[1]
# Generated or scratch folders only; all of them are ignored by .gitignore.
TARGETS = ("build", "dist", "output", "tmp")


def _is_link(path: Path) -> bool:
    return path.is_symlink() or path.is_junction()


def targets(root: Path = ROOT) -> list[Path]:
    """Existing clean targets directly under root, in TARGETS order."""
    return [root / name for name in TARGETS if _is_link(root / name) or (root / name).exists()]


def usage(path: Path) -> tuple[int, int]:
    """(file count, total bytes) of a target; a link counts as nothing because it is not followed."""
    if _is_link(path):
        return 0, 0
    if path.is_file():
        return 1, path.stat().st_size
    files = size = 0
    for folder, subfolders, names in os.walk(path):
        # os.walk does not follow symlinks, but it does enter junctions: skip them (rmtree only unlinks them).
        subfolders[:] = [name for name in subfolders if not (Path(folder) / name).is_junction()]
        for name in names:
            try:
                size += (Path(folder) / name).lstat().st_size
            except OSError:
                continue
            files += 1
    return files, size


def human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    value = size / 1024
    for unit in ("KB", "MB"):
        if value < 1024:
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def _retry_read_only(function, path, _error):
    # Windows refuses to delete read-only files (git objects, copied wheels): clear the flag and retry.
    os.chmod(path, stat.S_IWRITE)
    function(path)


def remove(path: Path) -> None:
    if _is_link(path):
        # Path.unlink removes a symlink to a folder on Windows; a junction needs os.rmdir.
        try:
            path.unlink()
        except (IsADirectoryError, PermissionError):
            os.rmdir(path)
    elif path.is_dir():
        shutil.rmtree(path, onexc=_retry_read_only)
    else:
        path.unlink()


def clean(root: Path = ROOT, confirm: bool = False, out=None) -> list[Path]:
    """List the targets and, only when confirm is true, delete them. Returns the targets."""
    out = sys.stdout if out is None else out
    found = targets(root)
    if not found:
        print("削除対象はありません (build, dist, output, tmp)。", file=out)
        return found
    print("削除対象:" if confirm else "削除対象 (まだ削除していません):", file=out)
    for path in found:
        if _is_link(path):
            print(f"  {path.name}/  (リンク。リンク先は削除しません)", file=out)
            continue
        files, size = usage(path)
        print(f"  {path.name}/  {files} ファイル, {human_size(size)}", file=out)
    if not confirm:
        print("削除するには `just clean yes` を実行してください。", file=out)
        return found
    for path in found:
        remove(path)
        print(f"削除しました: {path.name}/", file=out)
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="一覧を表示したうえで実際に削除する")
    args = parser.parse_args(argv)
    clean(confirm=args.yes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
