"""macOS: sign every Mach-O file of the onedir sidecar ad hoc, then verify them (`just build-sidecar`).

Papeer is not signed with an Apple Developer ID (it is not notarized either): the app, and each program and
library it runs, carry an ad-hoc signature (`codesign --sign -`), without which Apple Silicon refuses to run
arm64 code. tauri.macos.conf.json signs the app itself ad hoc; the sidecar's folder is one of its resources,
which Tauri copies as it is, so its launcher and the libraries in _internal (Python, the extension modules,
the .dylib files of PyMuPDF, pypdfium2...) are signed here. PyInstaller signs what it collects ad hoc as
well; signing again after it makes sure of every file, and the verification fails the build if one is not.

  uv run python tools/sign_sidecar.py                       # dist/sidecar: sign, then verify
  uv run python tools/sign_sidecar.py --verify <folder>     # verify only (release.yml: the folder in Papeer.app)

Does nothing on Windows and Linux.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FOLDER = ROOT / "dist" / "sidecar"
LAUNCHER = "papeer-sidecar"

# The first four bytes of a Mach-O file: 32/64-bit in either byte order, and a universal ("fat") binary.
# 0xcafebabe is also a Java class file's; the sidecar holds none, and codesign would refuse it loudly.
MACHO_MAGICS = {bytes.fromhex(value) for value in
                ("feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca")}
# Files per codesign call, well under the limit on the length of a command line.
BATCH = 100


def is_macho(path: Path) -> bool:
    try:
        with path.open("rb") as file:
            return file.read(4) in MACHO_MAGICS
    except OSError:
        return False


def macho_files(folder: Path) -> list[Path]:
    """The Mach-O files in `folder`, the launcher last (a link to a file is signed as that file)."""
    files = sorted(path for path in folder.rglob("*")
                   if path.is_file() and not path.is_symlink() and is_macho(path))
    return sorted(files, key=lambda path: path == folder / LAUNCHER)


def _codesign(arguments: list[str], files: list[Path]) -> None:
    for start in range(0, len(files), BATCH):
        subprocess.run(["codesign", *arguments, *(str(path) for path in files[start:start + BATCH])], check=True)


def sign(files: list[Path]) -> None:
    # --timestamp=none: an ad-hoc signature has no secure timestamp (and asking for one needs the network).
    _codesign(["--force", "--sign", "-", "--timestamp=none"], files)


def verify(files: list[Path]) -> None:
    _codesign(["--verify", "--strict"], files)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="macOS: sidecar の Mach-O ファイルに ad-hoc 署名する")
    parser.add_argument("folder", nargs="?", type=Path, default=DEFAULT_FOLDER, help="onedir の sidecar のフォルダー")
    parser.add_argument("--verify", action="store_true", help="署名せず、署名を確かめるだけにする")
    args = parser.parse_args(argv)
    if sys.platform != "darwin":
        print("macOS ではないため、sidecar には署名しません。")
        return 0
    files = macho_files(args.folder)
    if args.folder / LAUNCHER not in files:
        print(f"{args.folder / LAUNCHER} がありません。先に PyInstaller で sidecar.spec をビルドしてください。",
              file=sys.stderr)
        return 1
    try:
        if not args.verify:
            sign(files)
        verify(files)
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"sidecar の署名に失敗しました: {error}", file=sys.stderr)
        return 1
    print(f"{args.folder} の Mach-O ファイル {len(files)} 個の ad-hoc 署名を{'確かめました' if args.verify else '付けて確かめました'}。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
