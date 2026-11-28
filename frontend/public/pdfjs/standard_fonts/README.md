# PDF.js standard fonts and corresponding sources

The Foxit PFB files retain the terms in [LICENSE_FOXIT](LICENSE_FOXIT).
The four Liberation Sans TTF files are copied unchanged from `pdfjs-dist 6.3.289`
and retain GPL version 2 with the Liberation font exceptions in
[LICENSE_LIBERATION](LICENSE_LIBERATION). They are version 1.07.4, not OFL fonts.

The editable sources are supplied **in this same directory**, including on the
website and in the desktop frontend bundle:

- [Exact bundled-font TTX sources](liberation-pdfjs-ttx-source.tar.gz): complete
  XML representations of every table in the four fonts. This is the editable
  format used to maintain these copies. It preserves glyph order, outlines,
  hints, OpenType tables, metrics and original copyright/license metadata.
- [Upstream 1.07.4 source](liberation-fonts-1.07.4-source.tar.gz): the complete
  upstream release commit, including the original FontForge SFD files,
  Makefile, scripts, copyright notices and license texts.
- [Rebuild script](rebuild-liberation.py) for the exact-font TTX sources. Install
  Python and FontTools (`python -m pip install fonttools==4.65.0`), then run
  `python rebuild-liberation.py`. The result is written to `rebuilt-liberation/`.
  FontTools may change binary table offsets/padding; the test verifies the
  glyphs, metrics and other font tables, rather than claiming byte identity.
  To edit these fonts, unpack the TTX archive, modify its XML, and use FontTools
  `ttx` to compile it. Retain the license and observe its modified-font naming
  conditions before redistributing a modified font.

For the original SFD build, unpack the upstream archive, install FontForge and
GNU Make, and run `make` in its root. Its README and Makefile contain the build
instructions. That old FontForge build is not claimed to reproduce the PDF.js
binaries byte for byte. PDF.js relies on the existing glyph order and advance
widths: do not replace these fonts with another build or Liberation 2.x without
also regenerating and testing PDF.js's width and scaling tables.

Provenance:

- [PDF.js 6.3.289 font documentation](https://github.com/mozilla/pdf.js/blob/v6.3.289/external/standard_fonts/README.md).
- [Official Liberation release commit dbeb786b4ede1eaec2ec5cb8d3b75d21641e2a35](https://github.com/liberationfonts/liberation-1.7-fonts/commit/dbeb786b4ede1eaec2ec5cb8d3b75d21641e2a35)
  ("Commit for 1.07.4 release"). Downloaded unchanged from GitHub's archive of
  that commit; SHA-256 `05a8cc739f41d33fbc6d18f83f597cbebb91725bba028d7f1e36f7a211173abd`.
- Exact TTF/source hashes are recorded in [source-manifest.json](source-manifest.json).

The upstream project's old Pagure download URLs currently return 404, so this
distribution does not rely on recipients retrieving the sources from them.
The Liberation license includes an exception for embedding the fonts in
documents; it does not require those documents to be GPL-licensed solely
because they embed these fonts.
