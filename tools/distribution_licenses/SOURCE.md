# Papeer source and redistribution

Papeer is free software under the GNU Affero General Public License, version 3
or (at your option) any later version. It is provided WITHOUT ANY WARRANTY,
including merchantability or fitness for a particular purpose. See AGPL-3.0.txt.
Third-party components retain the licenses reproduced in this directory.

The source repository, build instructions, dependency locks and build scripts are:
https://github.com/hooked-on-mas/papeer

For an official release, use the matching version tag and source archive linked
beside the installers at https://github.com/hooked-on-mas/papeer/releases .
The repository README describes `just setup` and `just build`; `sidecar.spec`,
`justfile`, the Vite/Tauri configuration, and all three lock files are part of the
corresponding source. A distributor of a locally modified build must also supply
those modifications and the corresponding build instructions with that build.
Do not point recipients of a modified build only to the unmodified upstream tag.

`manifest.json` lists exact versions and source downloads for Python packages
and Rust crates (including MPL-covered files). These packages include their own
copyright notices and terms. The PyMuPDF source distribution and its build
instructions identify the matching MuPDF source; PyMuPDF/MuPDF are used under
the AGPL option, not under an Artifex commercial license.

The PDF.js Liberation fonts have their editable sources, build instructions and
licenses beside them in `pdfjs/standard_fonts/` in the frontend distribution.
The Source Han fonts retain their OFL notices beside the sidecar font assets.
