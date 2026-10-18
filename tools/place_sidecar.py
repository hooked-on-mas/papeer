"""Put the smoke-tested onedir sidecar where Tauri bundles it from (`just build-sidecar`).

Copies dist/sidecar (PyInstaller's COLLECT output, sidecar.spec) to frontend/src-tauri/sidecar, which
tauri.conf.json's bundle.resources takes into the installers. The copy is made beside the target and
swapped in by renaming, so an interrupted copy never leaves a half-filled folder behind: the justfile
writes sidecar-sources.txt only after this succeeds, and an older record must not vouch for a partial
folder (`just check-sidecar` looks at the launcher and _internal/code-version.txt only, not every file).
A rename is tried a few times, and if the new folder cannot be moved in, the previous one is put back.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import sys
import time
from typing import Sequence

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))

from papeer.core.code_version import LAUNCHERS, SIDECAR_DIR  # noqa: E402

SOURCE = ROOT / "dist" / SIDECAR_DIR.name


# A folder just written or scanned can be held open for a moment (antivirus, the search indexer), and
# renaming it fails meanwhile.
RENAME_ATTEMPTS = 5
RENAME_DELAY = 0.5


def _rename(source: Path, target: Path) -> None:
    for attempt in range(RENAME_ATTEMPTS):
        try:
            os.replace(source, target)
            return
        except OSError:
            if attempt == RENAME_ATTEMPTS - 1:
                raise
            time.sleep(RENAME_DELAY)


def place(source: Path, target: Path, launchers: str | Sequence[str]) -> None:
    """Replace `target` with a copy of `source`, which must hold every one of `launchers` (names)."""
    for launcher in [launchers] if isinstance(launchers, str) else launchers:
        if not (source / launcher).is_file():
            raise FileNotFoundError(f"{source / launcher} がありません。先に PyInstaller で sidecar.spec をビルドしてください。")
    staging = target.with_name(target.name + ".new")
    previous = target.with_name(target.name + ".old")
    # Left by an interrupted run; copytree fails below if they cannot be removed.
    for leftover in (staging, previous):
        shutil.rmtree(leftover, ignore_errors=True)
    shutil.copytree(source, staging)
    moved = target.exists()
    if moved:
        _rename(target, previous)
    try:
        _rename(staging, target)
    except OSError:
        # Put the previous folder back: it is still the one sidecar-sources.txt describes.
        if moved:
            _rename(previous, target)
        raise
    shutil.rmtree(previous, ignore_errors=True)


def main() -> int:
    try:
        place(SOURCE, ROOT / SIDECAR_DIR, [launcher.name for launcher in LAUNCHERS])
    except OSError as exc:
        print(f"sidecar を配置できませんでした: {exc}", file=sys.stderr)
        return 1
    print(f"{SOURCE.relative_to(ROOT).as_posix()} を {SIDECAR_DIR.as_posix()} に配置しました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
