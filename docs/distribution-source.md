# Papeer source and third-party notices

Papeer is licensed under AGPL-3.0-or-later. The accompanying LICENSE contains the
license and warranty disclaimer. Third-party components retain their own licenses.

Source repository: https://github.com/hooked-on-mas/papeer

For an official release, use the source archive for the same `vX.Y.Z` tag as the
application version. The repository includes the locked dependency versions,
`justfile`, PyInstaller specification and Tauri configuration needed to build it.
Install the toolchains described in README.md, run `just setup`, then `just build`.
The sidecar's `code-version.txt` records a content hash of the PDF rendering code;
use the matching tag and source archive for the complete build source.
Distributors of modified builds must provide the corresponding source for their
own build, including changes and build instructions, rather than referring only
to an upstream version. Signing keys, OAuth credentials and user data are not
part of the corresponding source.

The web and desktop frontend builds include `licenses.md`, `geist-OFL.txt` and
this source notice. PDF.js font and CMap notices accompany those assets. The
sidecar includes third-party notices and license texts collected at build time.
ELK layouts are excluded from Papeer builds; use Mermaid's Dagre layout instead.
