"""Rebuild the bundled Liberation fonts from the editable TTX sources.

Install fonttools (tested with 4.65.0), then run this script. Only the new
rebuilt-liberation/ directory is written; the fonts used by PDF.js are untouched.
"""
from pathlib import Path
import io
import tarfile

from fontTools.ttLib import TTFont


def rebuild(source_dir: Path, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    with tarfile.open(source_dir / "liberation-pdfjs-ttx-source.tar.gz", "r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile() or not member.name.endswith(".ttx"):
                continue
            # No archive path is extracted to the filesystem.
            font = TTFont(recalcBBoxes=False, recalcTimestamp=False)
            font.importXML(io.BytesIO(archive.extractfile(member).read()))
            font.save(output / (Path(member.name).stem + ".ttf"), reorderTables=False)


if __name__ == "__main__":
    directory = Path(__file__).resolve().parent
    rebuild(directory, directory / "rebuilt-liberation")
