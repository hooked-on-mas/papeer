"""Build compact TrueType faces readable by both MuPDF and PDFium.

The bundled CID-keyed CFF (OTF) faces are converted to TrueType once per PC and kept in a cache
folder (font_cache_directory); each translated page then only subsets that converted face, which
takes a fraction of a second instead of re-reading and converting the 10 MB of OTF every time.
"""
from __future__ import annotations

from array import array
import hashlib
import io
from pathlib import Path
import sys
import threading
import time

import fontTools
from fontTools import subset
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

from papeer.core.fileio import atomic_write_bytes, is_temporary
from papeer.core.paths import app_env, device_directory

# Raise when truetype_font changes its output, so that every PC converts the faces again.
CONVERSION_REVISION = 1
# The whole-file checksum a complete TrueType file sums to (OpenType spec, 'head' checkSumAdjustment).
_TRUETYPE_CHECKSUM = 0xB1B0AFBA
# Temporary files of a conversion that a forced exit interrupted are removed after this long.
_STALE_TEMPORARY_SECONDS = 3600

_GENERATION = threading.Lock()
# Converted faces already read and verified in this process, by cache file.
_LOADED: dict[Path, bytes] = {}
_SOURCE_KEYS: dict[tuple[Path, int, int], str] = {}
# A cache folder that refuses writes is reported once per process, not once per face.
_STORE_WARNED = False


def truetype_font(font: TTFont, family: str, style: str) -> bytes:
    # The CID-keyed CFF assets render incorrectly in a fresh MuPDF process,
    # even with glyph IDs retained. Convert the outlines to TrueType.
    # One font unit of curve approximation error is < .02pt at reading sizes.
    glyph_set = font.getGlyphSet()
    glyphs = {}
    for name in font.getGlyphOrder():
        pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(Cu2QuPen(pen, max_err=1, reverse_direction=True))
        glyphs[name] = pen.glyph()
    builder = FontBuilder(font["head"].unitsPerEm, isTTF=True)
    builder.setupGlyphOrder(font.getGlyphOrder())
    builder.setupCharacterMap(font.getBestCmap())
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics(font["hmtx"].metrics)
    builder.setupHorizontalHeader(ascent=font["hhea"].ascent, descent=font["hhea"].descent,
                                  lineGap=font["hhea"].lineGap)
    builder.font["OS/2"] = font["OS/2"]
    # Keep copyright/license metadata; derivatives must not use reserved names.
    names = {0: font["name"].getDebugName(0) or "",
             1: family, 2: style, 3: f"Papeer:{family}-{style}",
             4: f"{family} {style}", 6: f"{family}-{style}",
             13: font["name"].getDebugName(13) or "SIL Open Font License 1.1",
             14: font["name"].getDebugName(14) or "https://openfontlicense.org"}
    builder.setupNameTable(names)
    builder.setupPost()
    builder.font["head"].macStyle = font["head"].macStyle
    # The source's dates, not the time of conversion: the same face converts to the same bytes,
    # so a face converted again (a damaged cache, another PC) embeds exactly as before.
    builder.font["head"].created = font["head"].created
    builder.font["head"].modified = font["head"].modified
    for tag in ("GSUB", "GPOS", "GDEF"):
        if tag in font:
            builder.font[tag] = font[tag]
    data = io.BytesIO()
    builder.save(data)
    return data.getvalue()


def subset_truetype(data: bytes, characters: str) -> bytes:
    """The glyphs of `characters` (and what their layout features reach) from a converted face.

    Safe to call from several threads at once: every call parses its own copy of the face.
    """
    # Glyph boxes were computed at conversion; not recomputing them keeps the untouched glyphs'
    # compiled data as it is (a stale font-wide box only ever encloses the subset).
    with TTFont(io.BytesIO(data), lazy=True, recalcBBoxes=False, recalcTimestamp=False) as font:
        options = subset.Options()
        options.layout_features = ["*"]
        # The name table truetype_font wrote (license, both platforms) stays whole.
        options.name_IDs = ["*"]
        options.name_languages = ["*"]
        options.name_legacy = True
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(text=characters)
        subsetter.subset(font)
        output = io.BytesIO()
        font.save(output)
        return output.getvalue()


def font_cache_directory() -> Path:
    """This PC's converted faces: rebuilt from the bundled fonts, so never backed up or synced."""
    override = app_env("FONT_CACHE_DIR")
    return Path(override).expanduser() if override else device_directory() / "font-cache"


def cached_truetype(source: Path, family: str, style: str) -> bytes:
    """The whole face `source` converted by truetype_font, from the cache or converted now.

    The cache file is named after the source's content, the converter revision and the fontTools
    version, so an updated font or converter never reuses an old conversion. A damaged file is
    converted again. Threads of one process convert a face once; separate processes may convert
    it at the same time, and each replaces the file whole (fileio), so a reader never sees a torn one.
    A cache folder that cannot be written only costs every process its own conversion (_store).
    """
    path = font_cache_directory() / f"{family}-{style}-{_source_key(source)}.ttf"
    data = _LOADED.get(path)
    if data is not None:
        return data
    with _GENERATION:
        data = _LOADED.get(path)
        if data is not None:
            return data
        data = _read_intact(path)
        if data is None:
            with TTFont(source, recalcTimestamp=False) as font:
                data = truetype_font(font, family, style)
            _store(path, data)
        # Once per face and process: earlier conversions, and temporaries an interrupted one left.
        _remove_stale(path, f"{family}-{style}-")
        _LOADED[path] = data
        return data


def cache_ready(source: Path, family: str, style: str) -> bool:
    """Whether cached_truetype has the face at hand (in memory or a cache file) rather than converting it.

    Only looks for the file; a damaged one is found out, and converted again, by cached_truetype.
    """
    try:
        path = font_cache_directory() / f"{family}-{style}-{_source_key(source)}.ttf"
        return path in _LOADED or path.is_file()
    except OSError:
        return True  # No bundled font to convert: the page that needs it reports that.


def _store(path: Path, data: bytes) -> None:
    """Keep a conversion for later processes. Failing to only costs the next process the conversion."""
    global _STORE_WARNED
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(path, data)
    except OSError as error:
        if not _STORE_WARNED:
            _STORE_WARNED = True
            print(f"警告: 日本語フォントの変換結果を保存できませんでした（次回も変換します）: {error!r}",
                  file=sys.stderr)


def _source_key(source: Path) -> str:
    status = source.stat()
    memo = (source.resolve(), status.st_size, status.st_mtime_ns)
    key = _SOURCE_KEYS.get(memo)
    if key is None:
        digest = hashlib.sha256(f"{CONVERSION_REVISION}\0{fontTools.version}\0".encode())
        digest.update(source.read_bytes())
        key = _SOURCE_KEYS[memo] = digest.hexdigest()[:20]
    return key


def _read_intact(path: Path) -> bytes | None:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    return data if truetype_intact(data) else None


def truetype_intact(data: bytes) -> bool:
    """Whether data is a whole TrueType file: 4-byte aligned tables summing to the spec's checksum."""
    if len(data) < 12 or len(data) % 4 or data[:4] != b"\x00\x01\x00\x00":
        return False
    words = array("I", data)  # 32-bit on every supported platform
    if sys.byteorder == "little":
        words.byteswap()
    return sum(words) & 0xFFFFFFFF == _TRUETYPE_CHECKSUM


def _remove_stale(current: Path, prefix: str) -> None:
    """Earlier conversions of the same face, and temporaries a forced exit left behind."""
    now = time.time()
    try:
        others = list(current.parent.iterdir())
    except OSError:
        return  # No cache folder (the conversion could not be kept) or no access to it.
    for other in others:
        try:
            if other.name.startswith(prefix) and other.suffix == ".ttf" and other != current:
                other.unlink()
            elif is_temporary(other) and now - other.stat().st_mtime > _STALE_TEMPORARY_SECONDS:
                other.unlink()
        except OSError:
            # Another process may be reading or writing it; the next process tries again.
            pass
