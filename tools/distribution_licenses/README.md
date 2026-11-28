# Supplemental distribution notices

These are unmodified upstream license/notice copies for packages whose wheels
or crates omit their full license texts, and for native libraries embedded in
PyMuPDF. `distribution_notices.py` reads installed package notices first and
uses these copies for the explicitly recorded versions. No network request is
made by the build.

Adjacent `.source` files record immutable upstream revision URLs. The Rust
revisions come from the published crate's `.cargo_vcs_info.json`. The shared
UNIC and WebView2 crate licenses come from their respective monorepos.
PyWinRT uses the `wheels/v3.2.1` commit. The generic MPL-2.0 text for selectors
comes from Mozilla; the crate's own source and authors remain available at the
exact source URL in the generated manifest.

`mupdf-1.28.2/sources.json` records the MuPDF 1.28.2 release commit and its exact
native submodule commits. It conservatively includes notices for optional
components as well as required ones. The original MuPDF source includes build
options that determine which components are actually linked. Font, FreeType
subcomponent and Independent JPEG Group notices are retained as well.

`python-3.12/LICENSE.txt` is a fallback copy of the upstream interpreter's full
license collection for Python 3.12 installs that omit the file. When present,
the build uses the interpreter installation's own LICENSE.txt instead.

When updating a package with supplemental notices, inspect its exact new source
and refresh these files and the version mapping. License expressions in metadata
are not substitutes for their texts and copyright notices.
