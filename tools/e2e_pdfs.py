"""Make the PDFs the end-to-end tests import (frontend/e2e, `just e2e`).

`python tools/e2e_pdfs.py <folder>` writes two-column papers made with PyMuPDF: a title, authors and
a DOI on page 1, a numbered section heading on each page, a table of contents, an internal link and a
gradient "photo" on page 2. The words are drawn from a fixed seed, so every run makes the same files.
It prints the file names, one per line.
"""
from __future__ import annotations

from pathlib import Path
import random
import sys

import pymupdf

WORDS = ("adaptive control tracking error robust estimator gradient network stochastic convergence "
         "parameter observer feedback nonlinear system stability Lyapunov function bounded disturbance "
         "reference model estimation algorithm experiment baseline accuracy transformer attention").split()

# (file name, title, pages): the tests find the papers by these titles.
PAPERS = [
    ("twocol.pdf", "Adaptive Tracking Control with Two Columns", 6),
    ("observer.pdf", "Robust Observer Design", 3),
    ("gradient.pdf", "Stochastic Gradient Networks", 3),
    ("lyapunov.pdf", "Lyapunov Stability Notes", 3),
]
WIDTH, HEIGHT = 612, 792


def paragraph(rng: random.Random, sentences: int) -> str:
    out = []
    for _ in range(sentences):
        words = " ".join(rng.choice(WORDS) for _ in range(rng.randint(10, 18)))
        out.append(words[0].upper() + words[1:] + ".")
    return " ".join(out)


def photo(width: int = 120, height: int = 80) -> pymupdf.Pixmap:
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, width, height), False)
    for y in range(height):
        for x in range(width):
            pix.set_pixel(x, y, ((x * 255) // width, (y * 255) // height, 180 - (x + y) % 120))
    return pix


def two_column(path: Path, title: str, pages: int, seed: int) -> None:
    rng = random.Random(seed)
    doc = pymupdf.open()
    sections: list[tuple[str, int, float]] = []
    for p in range(pages):
        page = doc.new_page(width=WIDTH, height=HEIGHT)
        top = 60.0
        if p == 0:
            page.insert_textbox(pymupdf.Rect(60, 50, WIDTH - 60, 90), title, fontsize=18, fontname="tibo", align=1)
            page.insert_textbox(pymupdf.Rect(60, 92, WIDTH - 60, 110), "Taro Yamada, Hanako Suzuki", fontsize=11, align=1)
            page.insert_textbox(pymupdf.Rect(60, 110, WIDTH - 60, 124), "doi:10.1234/e2e.2026.001", fontsize=9, align=1)
            top = 140.0
        for column in range(2):
            x0 = 54 if column == 0 else WIDTH / 2 + 9
            x1 = WIDTH / 2 - 9 if column == 0 else WIDTH - 54
            y = top
            if column == 0:
                heading = f"{p + 1}. Section {p + 1}"
                page.insert_text((x0, y + 12), heading, fontsize=12, fontname="tibo")
                sections.append((heading, p, y))
                y += 22
            if p == 1 and column == 1:
                page.insert_image(pymupdf.Rect(x0, y, x1, y + 150), pixmap=photo())
                page.insert_text((x0, y + 164), "Fig. 1. A photo-like gradient image.", fontsize=8)
                y += 175
            text = paragraph(rng, 9) + "\n\n" + paragraph(rng, 7)
            page.insert_textbox(pymupdf.Rect(x0, y, x1, HEIGHT - 60), text, fontsize=9.5, fontname="tiro")
        page.insert_text((WIDTH / 2 - 5, HEIGHT - 30), str(p + 1), fontsize=9)
    if pages > 3:
        first = doc[0]
        first.insert_text((54, HEIGHT - 45), "See Section 4 for details.", fontsize=9, color=(0, 0, 0.8))
        first.insert_link({"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(54, HEIGHT - 55, 180, HEIGHT - 42),
                           "page": 3, "to": pymupdf.Point(54, 400), "zoom": 0})
    doc.set_toc([[1, h, p + 1, {"kind": pymupdf.LINK_GOTO, "page": p, "to": pymupdf.Point(54, y), "zoom": 0}]
                 for h, p, y in sections])
    doc.set_metadata({"title": title, "author": "Taro Yamada; Hanako Suzuki"})
    doc.save(path)
    doc.close()


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: python tools/e2e_pdfs.py <folder>", file=sys.stderr)
        return 2
    folder = Path(argv[0])
    folder.mkdir(parents=True, exist_ok=True)
    for seed, (name, title, pages) in enumerate(PAPERS):
        two_column(folder / name, title, pages, seed)
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
