"""Generate the real PDF and its independent placement oracle. Never run from draft.

Uses the repository's existing PyMuPDF/fontTools and licensed repository fonts.
The oracle comes from authored Courier advances, baselines, drawn tick positions,
and MuPDF's independent page rotation matrix, never the implementation under test.
DOM selection rectangles are not glyph outlines: only horizontal advance/tick
positions and a generous baseline band are fixed for the browser acceptance.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
from pathlib import Path

import pymupdf as fitz
from fontTools import subset
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
LATIN = ROOT / "frontend/public/pdfjs/standard_fonts/LiberationSans-Regular.ttf"
JAPANESE = ROOT / "papeer/core/assets/fonts/SourceHanSerifJP-Regular.otf"
RESOURCE_ID = "00000000-0000-4000-8000-000000000110"


def require_font(path: Path, text: str) -> None:
    font = TTFont(path)
    cmap = font.getBestCmap() or {}
    missing = [f"U+{ord(char):04X}" for char in set(text) if ord(char) not in cmap]
    font.close()
    if missing:
        raise RuntimeError(f"required actual PDF glyphs unavailable in {path.name}: {missing}")


def fixture_font(path: Path, text: str) -> bytes:
    font = TTFont(path)
    options = subset.Options()
    options.retain_gids = True
    options.recalc_timestamp = False
    selector = subset.Subsetter(options=options)
    selector.populate(text=text)
    selector.subset(font)
    target = io.BytesIO()
    font.save(target)
    font.close()
    return target.getvalue()


def encode_nonbmp_destinations(document, font_xref: int) -> None:
    # Installed PyMuPDF 1.28.2 emits e.g. <CID> <20bb7>, which is not a
    # UTF-16BE ToUnicode destination. Correct the PDF authoring encoding using
    # the actual font cmap value, before any reader sees the document. This
    # changes neither glyph/CID nor the text asserted by browser extraction.
    kind, reference = document.xref_get_key(font_xref, "ToUnicode")
    if kind != "xref":
        raise RuntimeError("embedded fixture font requires a real ToUnicode stream")
    xref = int(reference.split()[0])
    source = document.xref_stream(xref).decode("ascii")

    def utf16(match):
        point = int(match[2], 16)
        return f"{match[1]} <{chr(point).encode('utf-16-be').hex()}>"

    encoded = re.sub(r"(?m)^(<[0-9a-fA-F]+>)[ \t]+<([0-9a-fA-F]{5,6})>[ \t]*$", utf16, source)
    expected = "\U00020bb7".encode("utf-16-be").hex()
    if expected not in encoded.lower():
        raise RuntimeError("actual non-BMP font mapping did not produce a UTF-16 surrogate destination")
    document.update_stream(xref, encoded.encode("ascii"))


def encode_cff_cids(document, font_xref: int, font_bytes: bytes, text: str) -> float:
    # SourceHan's CFF charset CID is not always its glyph-array index. Installed
    # PyMuPDF writes glyph-array indices into content with Identity-H. Supply a
    # real PDF code->CID CMap so the encoded glyph index reaches its actual CID,
    # and key widths by that CID. ToUnicode continues to map the original code.
    font = TTFont(io.BytesIO(font_bytes))
    cmap = font.getBestCmap() or {}
    units = font["head"].unitsPerEm
    rows = []
    for point in sorted(set(map(ord, text))):
        name = cmap[point]
        if not name.startswith("cid"):
            raise RuntimeError("fixture CFF font must expose its actual CID charset")
        rows.append((font.getGlyphID(name), int(name[3:]), font["hmtx"].metrics[name][0] * 1000 / units))
    advance_e = font["hmtx"].metrics[cmap[ord("e")]][0] * 1000 / units
    font.close()
    entries = "\n".join(f"<{code:04x}> {cid}" for code, cid, _ in rows)
    stream = f"""/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def
/CMapName /CanonicalFixtureGidToCid def
/CMapType 1 def
/WMode 0 def
1 begincodespacerange
<0000> <ffff>
endcodespacerange
{len(rows)} begincidchar
{entries}
endcidchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
"""
    encoding = document.get_new_xref()
    document.update_object(encoding, "<<>>")
    document.update_stream(encoding, stream.encode("ascii"))
    document.xref_set_key(font_xref, "Encoding", f"{encoding} 0 R")
    kind, descendants = document.xref_get_key(font_xref, "DescendantFonts")
    reference = re.fullmatch(r"\[\s*(\d+) 0 R\s*\]", descendants)
    if kind != "array" or not reference:
        raise RuntimeError("fixture CFF font must have one actual descendant")
    descendant = int(reference[1])
    widths = " ".join(f"{cid} [{width:.6f}]" for _, cid, width in rows)
    document.xref_set_key(descendant, "W", f"[{widths}]")
    return advance_e


def marked_text(page, point, text: str, pair_adjust: float | None = None, **kwargs) -> None:
    before = set(page.get_contents())
    page.insert_text(point, text, **kwargs)
    for xref in set(page.get_contents()) - before:
        # Each wrapper flushes PDF.js's current item. Moving to the next line
        # then produces a genuine empty hasEOL item, not a fabricated callback.
        stream = page.parent.xref_stream(xref)
        if pair_adjust is not None:
            # Place the actual zero-advance combining glyph over its base glyph.
            # Both encoded characters and their ToUnicode mappings remain real.
            stream, replaced = re.subn(rb"\[<([0-9a-fA-F]{4})([0-9a-fA-F]{4})>\]TJ",
                lambda match: b"[<" + match[1] + b"> " + f"{pair_adjust:.6f}".encode("ascii") + b" <" + match[2] + b">]TJ", stream)
            if replaced != 1:
                raise RuntimeError("combining fixture must contain exactly one encoded glyph pair")
        page.parent.update_stream(xref, b"/Span BMC\n" + stream + b"\nEMC\n")


def marker(page, baseline: float = 200) -> dict:
    # Base14 Courier has advance .6em, exactly 12pt at 20pt. Author visual ticks
    # around the selected substring [2, 6), independently of browser font layout.
    marked_text(page, (100, baseline), "MMMMMMMMMM", fontsize=20, fontname="cour")
    marked_text(page, (100, baseline + 50), "NEXT LINE", fontsize=20, fontname="cour")
    for x in (100, 124, 172, 220):
        page.draw_line((x, baseline - 30), (x, baseline + 10), color=(1, 0, 0), width=.4)
    page.draw_line((100, baseline + 10), (220, baseline + 10), color=(1, 0, 0), width=.4)
    return {"text": "MMMMMMMMMM", "start": 2, "end": 6, "sourceRect": [124, baseline - 30, 172, baseline + 10],
            "sourceAxis": [124, baseline, 172, baseline], "advancePt": 12, "baselinePt": baseline}


def main() -> None:
    require_font(LATIN, "fi\ufb01")
    require_font(JAPANESE, "e\u0301\U00020bb7")
    document = fitz.open()
    entries = []
    for number, rotation in enumerate((0, 0, 0, 90, 180, 270), 1):
        if number == 1:
            page = document.new_page(width=600, height=1600)
        elif number == 2:
            page = document.new_page(width=600, height=300)
        else:
            page = document.new_page(width=800, height=1000)
            page.set_cropbox(fitz.Rect(100, 200, 700, 1000))
        authored = marker(page, 100 if number == 2 else 200)
        page.set_rotation(rotation)
        source = fitz.Rect(authored["sourceRect"])
        band = source * page.rotation_matrix
        p1 = fitz.Point(authored["sourceAxis"][:2]) * page.rotation_matrix
        p2 = fitz.Point(authored["sourceAxis"][2:]) * page.rotation_matrix
        entries.append({"physicalPage": number, "rotation": rotation, "marker": authored,
                        "canonicalBand": list(band), "canonicalAxis": [p1.x, p1.y, p2.x, p2.y],
                        "cropBox": list(page.cropbox), "userUnit": 1})
    unicode_page = document.new_page(width=600, height=800)
    unicode_page.insert_font(fontname="FixtureLatin", fontbuffer=fixture_font(LATIN, "fi\ufb01"))
    japanese_bytes = fixture_font(JAPANESE, "e\u0301\U00020bb7")
    japanese_font = unicode_page.insert_font(fontname="FixtureJP", fontbuffer=japanese_bytes)
    marked_text(unicode_page, (100, 180), "e\u0301", pair_adjust=547, fontsize=24, fontname="FixtureJP")
    marked_text(unicode_page, (100, 240), "\ufb01", fontsize=24, fontname="FixtureLatin")
    marked_text(unicode_page, (100, 300), "\U00020bb7", fontsize=24, fontname="FixtureJP")
    entries.append({"physicalPage": 7, "rotation": 0, "userUnit": 1,
                    "requiredActualText": ["e\u0301", "fi", "\U00020bb7"],
                    "ligaturePdfText": "\ufb01", "note": "PDF.js intentionally normalizes the actual fi ligature to two UTF-16 units."})
    user_unit = document.new_page(width=300, height=400)
    marker(user_unit, 100)
    document.xref_set_key(user_unit.xref, "UserUnit", "2")
    entries.append({"physicalPage": 8, "rotation": 0, "userUnit": 2,
                    "layoutPolicy": "measure actual canvas/text/known-marker agreement; a mismatch must refuse"})
    advance_e = encode_cff_cids(document, japanese_font, japanese_bytes, "e\u0301\U00020bb7")
    if abs(advance_e - 547) > .001:
        raise RuntimeError("authored combining-glyph adjustment no longer matches the actual fixture font")
    encode_nonbmp_destinations(document, japanese_font)
    target = HERE / "canonical-highlight.pdf"
    document.save(target, garbage=4, deflate=True, no_new_id=True)
    document.close()
    # Verify actual bytes with an independent installed reader. This does not
    # replace browser TextContent checks or rendered page inspection.
    with fitz.open(target) as inspected:
        dimensions = [{"widthPt": page.rect.width, "heightPt": page.rect.height} for page in inspected]
        actual_unicode = inspected[6].get_text()
        for text in ("e\u0301", "\U00020bb7"):
            if text not in actual_unicode:
                raise RuntimeError(f"required Unicode did not survive actual PDF encoding: {text!r}")
    raw = target.read_bytes()
    oracle = {"version": 1, "file": target.name,
              "metadata": {"id": RESOURCE_ID, "sha256": hashlib.sha256(raw).hexdigest(), "mediaType": "application/pdf",
                           "byteLength": len(raw), "pdfPages": dimensions}, "pages": entries,
              "tolerances": {"advancePt": 1.25, "bandPt": 2, "overlayClientPx": 2},
              "fontSources": [str(LATIN.relative_to(ROOT)), str(JAPANESE.relative_to(ROOT))]}
    (HERE / "canonical-highlight.oracle.json").write_text(json.dumps(oracle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
