"""Papeer: an independent desktop paper reader for Windows."""

import os

# Suppress PyMuPDF's optional layout-package recommendation during table detection.
os.environ["PYMUPDF_SUGGEST_LAYOUT_ANALYZER"] = "0"

__version__ = "0.2.0"
