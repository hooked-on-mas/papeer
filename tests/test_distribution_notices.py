import hashlib
import json
from pathlib import Path
import tarfile

import pytest
from fontTools.ttLib import TTFont

from tools.distribution_notices import PDFIUM_LICENSES, check, license_file

ROOT = Path(__file__).resolve().parents[1]
FONTS = ROOT / "frontend/public/pdfjs/standard_fonts"


def test_nested_pdfium_notices_are_not_lost_by_filename_filter():
    assert license_file(Path("x.dist-info/licenses/data/windows_x64/BUILD_LICENSES/agg23.txt"))
    assert license_file(Path("x.dist-info/licenses/LICENSES/Apache-2.0.txt"))
    assert license_file(Path("COPYING.txt"))
    assert license_file(Path("LICENCE"))
    assert not license_file(Path("package/example.py"))


def notice_fixture(root):
    directory = root / "_internal/licenses"
    directory.mkdir(parents=True)
    names = ["AGPL-3.0.txt", "SOURCE.md", "README.txt", "python-runtime/LICENSE.txt"]
    names += [f"python/pypdfium2/BUILD_LICENSES/{name}" for name in PDFIUM_LICENSES]
    for name in names:
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"license text")
    manifest = {"schemaVersion": 1, "packages": [{"name": "pypdfium2", "licenses": names}],
                "files": {name: hashlib.sha256(b"license text").hexdigest() for name in names}}
    (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return directory, manifest


def test_installed_bundle_missing_or_changed_pdfium_notice_fails(tmp_path):
    directory, _ = notice_fixture(tmp_path)
    check(tmp_path)
    target = directory / "python/pypdfium2/BUILD_LICENSES/icu.txt"
    target.write_bytes(b"truncated")
    with pytest.raises(ValueError, match="Changed notice"):
        check(tmp_path)
    target.unlink()
    with pytest.raises(ValueError, match="Missing/invalid notice"):
        check(tmp_path)


def test_manifest_cannot_hide_missing_pdfium_notice(tmp_path):
    directory, manifest = notice_fixture(tmp_path)
    name = "python/pypdfium2/BUILD_LICENSES/pdfium.txt"
    del manifest["files"][name]
    manifest["packages"][0]["licenses"].remove(name)
    (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="Missing PDFium licenses"):
        check(tmp_path)


def test_liberation_sources_match_distributed_fonts_and_rebuild(tmp_path):
    manifest = json.loads((FONTS / "source-manifest.json").read_text("utf-8"))
    for name, digest in manifest.items():
        assert hashlib.sha256((FONTS / name).read_bytes()).hexdigest() == digest
    with tarfile.open(FONTS / "liberation-fonts-1.07.4-source.tar.gz", "r:gz") as archive:
        members = archive.getmembers()
        assert len([item for item in members if item.name.endswith(".sfd")]) == 16
        makefile = archive.extractfile(next(item for item in members if item.name.endswith("/Makefile"))).read()
        assert b"VER          = 1.07.4" in makefile
    # Do not create __pycache__ inside Vite's public assets.
    namespace = {"__name__": "rebuild_fonts"}
    script = FONTS / "rebuild-liberation.py"
    exec(compile(script.read_text("utf-8"), str(script), "exec"), namespace)
    namespace["rebuild"](FONTS, tmp_path)
    for original in FONTS.glob("*.ttf"):
        with TTFont(original, recalcBBoxes=False, recalcTimestamp=False) as expected:
            with TTFont(tmp_path / original.name, recalcBBoxes=False, recalcTimestamp=False) as rebuilt:
                assert expected.getGlyphOrder() == rebuilt.getGlyphOrder()
                assert expected.getBestCmap() == rebuilt.getBestCmap()
                assert expected["hmtx"].metrics == rebuilt["hmtx"].metrics
                # Compile both the same way: the binary loca offsets can differ with padding,
                # while outlines, instructions and every substantive table remain identical.
                for tag in expected.reader.keys():
                    expected[tag]
                    rebuilt[tag]
                for glyph_name in expected.getGlyphOrder():
                    before = expected["glyf"][glyph_name]
                    after = rebuilt["glyf"][glyph_name]
                    assert before.getCoordinates(expected["glyf"]) == after.getCoordinates(rebuilt["glyf"])
                    assert (before.program.getBytecode() if hasattr(before, "program") else b"") == (
                        after.program.getBytecode() if hasattr(after, "program") else b"")
                for tag in expected.reader.keys():
                    if tag not in ("head", "loca", "glyf"):
                        assert expected.getTableData(tag) == rebuilt.getTableData(tag), (original.name, tag)
