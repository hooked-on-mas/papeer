"""Where the user may save a copy (exports, backups, glossaries): anywhere but inside the library."""
from __future__ import annotations

import os
from pathlib import Path


def inside_library(destination: Path, library_root: Path) -> bool:
    r"""Whether `destination` (which need not exist yet) lies in the library folder or is that folder.

    Comparing the path text is not enough on Windows: the same folder is also reachable as
    \\?\C:\..., through an admin share (\\127.0.0.1\C$\...), a junction, an 8.3 short name, or with
    a trailing space or dot that Windows drops. So every ancestor that exists is also compared with
    the library folder by identity (volume and file index), as os.path.samestat does.
    """
    try:
        destination = Path(destination).resolve()
    except (OSError, ValueError):
        destination = Path(os.path.abspath(destination))
    try:
        root = Path(library_root).resolve()
    except (OSError, ValueError):
        root = Path(os.path.abspath(library_root))
    # The path text is compared first, and even when the library cannot be looked at: an error must
    # never let a copy into it. (Windows paths compare case-insensitively.)
    if destination.is_relative_to(root):
        return True
    try:
        root_stat = os.stat(root)
    except (OSError, ValueError):
        return False
    # Some file systems (FAT, some network shares) report no file index; identity means nothing there.
    if not root_stat.st_ino:
        return False
    for ancestor in (destination, *destination.parents):
        try:
            if os.path.samestat(os.stat(ancestor), root_stat):
                return True
        except (OSError, ValueError):
            continue
    return False
