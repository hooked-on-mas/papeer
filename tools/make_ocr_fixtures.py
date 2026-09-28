"""Make the page images and the truth of the OCR tests (tests/fixtures/ocr).

    uv run python tools/make_ocr_fixtures.py [output folder]   (default: tests/fixtures/ocr)

Synthetic paper-like pages are typeset with PyMuPDF from made-up sentences (no real paper): English in two
columns, English with a display formula and a bar chart, and the same in Japanese. Each page is rendered at
300 dpi in grayscale, cut near the middle (a line the cut runs through is painted out and left out of the
truth, to keep the files small), and saved with four gray levels. truth.json holds, per page, its language,
the size of the cut page in points and its text lines ([x0, y0, x1, y1, text] in points, as PyMuPDF
extracts them from the typeset page).

The fonts are those of Windows (Times New Roman, Arial, Cambria, Yu Mincho and Yu Mincho Demibold: yumin.ttf
and yumindb.ttf), so the script runs on Windows only; the images show their glyphs, the fonts themselves are
not part of the output (docs/publication-risk-review.md). The random choices are seeded: the same fonts give the same pages.
Five pages are typeset, as when the fixtures were made, so that the seeded sentences stay the same; three
of them are kept.
"""
from __future__ import annotations

import json
from pathlib import Path
import random
import sys

import pymupdf
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
FONTS = Path("C:/Windows/Fonts")
DPI = 300
KEPT = ("synth_en_2col", "synth_en_2col_mathfig", "synth_ja_2col_mathfig")

EN = [
    "We propose a simple yet effective method for robust estimation of latent structure in noisy observations.",
    "The proposed estimator converges at a rate of O(n^-1/2) under mild regularity conditions [12].",
    "Experiments on three benchmark datasets show that our approach reduces the mean absolute error by 17.4% compared with the strongest baseline.",
    "In contrast to prior work, we do not assume that the noise is Gaussian or that the samples are independent.",
    "Section 3 describes the model, and Section 4 reports the empirical evaluation on synthetic and real-world data.",
    "All hyper-parameters were selected by five-fold cross-validation on the training split.",
    "The computational cost grows linearly with the number of samples, which makes the method practical for large-scale problems.",
    "We further analyze the sensitivity of the results to the choice of the regularization weight lambda.",
    "A preliminary version of this work appeared at the International Conference on Machine Learning (ICML 2021).",
    "Table 2 summarizes the accuracy, precision, and recall of each method averaged over ten random seeds.",
    "These findings suggest that the inductive bias of the architecture matters more than the size of the training set.",
    "Our implementation is written in Python and runs on a single NVIDIA A100 GPU with 40 GB of memory.",
    "The residual error is dominated by outliers located near the boundary of the feasible region.",
    "Following Smith et al. [7], we normalize every feature to zero mean and unit variance before training.",
    "Nevertheless, the method fails when the signal-to-noise ratio drops below 3 dB, as illustrated in Fig. 4.",
    "We thank the anonymous reviewers for their constructive comments and suggestions.",
]
JA = [
    "本研究では、雑音を含む観測から潜在構造を頑健に推定する簡潔な手法を提案する。",
    "提案する推定量は、緩やかな正則性条件のもとで最適な収束速度を達成する［12］。",
    "三つのベンチマークデータセットを用いた実験により、平均絶対誤差が最良の比較手法より17.4％減少することを示した。",
    "先行研究とは異なり、本手法は雑音が正規分布に従うことや標本が独立であることを仮定しない。",
    "第3章でモデルを説明し、第4章で人工データと実データを用いた評価結果を報告する。",
    "すべてのハイパーパラメータは、学習データに対する5分割交差検証によって選択した。",
    "計算量は標本数に対して線形に増加するため、大規模な問題にも適用しやすい。",
    "さらに、正則化の重みの選び方に対する結果の感度を分析した。",
    "表2に、各手法の正解率、適合率、再現率を10回の試行で平均した値を示す。",
    "これらの結果は、学習データの量よりもモデルの構造による帰納バイアスの方が重要であることを示唆している。",
    "実装にはPythonを用い、メモリ40GBのGPU1台で実行した。",
    "残差の大部分は、実行可能領域の境界付近にある外れ値によって生じている。",
    "ただし、信号対雑音比が3dBを下回ると、図4に示すように推定が破綻する。",
    "貴重なご意見をいただいた査読者の皆様に感謝いたします。",
]


class Fonts:
    def __init__(self):
        self.times = pymupdf.Font(fontfile=str(FONTS / "times.ttf"))
        self.times_bold = pymupdf.Font(fontfile=str(FONTS / "timesbd.ttf"))
        self.times_italic = pymupdf.Font(fontfile=str(FONTS / "timesi.ttf"))
        self.arial = pymupdf.Font(fontfile=str(FONTS / "arial.ttf"))
        self.cambria = pymupdf.Font(fontfile=str(FONTS / "cambria.ttc"))
        self.mincho = pymupdf.Font(fontfile=str(FONTS / "yumin.ttf"))
        self.gothic = pymupdf.Font(fontfile=str(FONTS / "yumindb.ttf"))  # Yu Mincho Demibold, for the headings


def wrap_en(text, font, size, width):
    lines, current = [], ""
    for word in text.split():
        candidate = (current + " " + word).strip()
        if font.text_length(candidate, size) > width and current:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def wrap_ja(text, font, size, width):
    lines, current = [], ""
    for char in text:
        if font.text_length(current + char, size) > width and current:
            lines.append(current)
            current = char
        else:
            current += char
    if current:
        lines.append(current)
    return lines


class Column:
    """A text column that writes lines top-down in reading order."""

    def __init__(self, page, x0, y0, x1, y1):
        self.page, self.x0, self.y, self.x1, self.y1 = page, x0, y0, x1, y1

    def para(self, text, font, size, ja=False, lead=1.25, gap=4, indent=0):
        lines = (wrap_ja if ja else wrap_en)(text, font, size, self.x1 - self.x0 - indent)
        for i, line in enumerate(lines):
            self.y += size * lead
            if self.y > self.y1:
                self.y = self.y1 + 1000
                return
            writer = pymupdf.TextWriter(self.page.rect)
            writer.append((self.x0 + (indent if i == 0 else 0), self.y), line, font=font, fontsize=size)
            writer.write_text(self.page)
        self.y += gap

    def room(self):
        return self.y1 - self.y


def body(rng, pool, n):
    return " ".join(rng.sample(pool, n)) if pool is EN else "".join(rng.sample(pool, n))


def figure(page, rect, labels_font, ja=False):
    """A small bar chart with axis tick labels and a legend (vector drawing and text)."""
    x0, y0, x1, y1 = rect
    shape = page.new_shape()
    ax0, ay0, ax1, ay1 = x0 + 30, y0 + 10, x1 - 10, y1 - 25
    shape.draw_line((ax0, ay1), (ax1, ay1))
    shape.draw_line((ax0, ay1), (ax0, ay0))
    shape.finish(color=(0, 0, 0), width=0.8)
    rng = random.Random(3)
    n = 6
    bw = (ax1 - ax0) / (n * 1.6)
    for i in range(n):
        h = (ay1 - ay0) * rng.uniform(0.2, 0.95)
        bx = ax0 + 8 + i * bw * 1.5
        shape.draw_rect(pymupdf.Rect(bx, ay1 - h, bx + bw, ay1))
        shape.finish(color=(0, 0, 0), fill=(0.3, 0.45, 0.8) if i % 2 else (0.85, 0.5, 0.2), width=0.3)
    shape.commit()
    writer = pymupdf.TextWriter(page.rect)
    for k, v in enumerate(["0", "20", "40", "60", "80"]):
        yy = ay1 - (ay1 - ay0) * k / 4
        writer.append((ax0 - 14, yy + 2), v, font=labels_font, fontsize=6)
    for i in range(n):
        bx = ax0 + 8 + i * bw * 1.5
        writer.append((bx, ay1 + 9), f"N={2 ** (i + 3)}", font=labels_font, fontsize=5.5)
    writer.append((ax0 + 5, ay0 + 6), "精度 (%)" if ja else "Accuracy (%)", font=labels_font, fontsize=6.5)
    writer.write_text(page)


def equation(page, fonts, x, y):
    """A display equation: scripts and Greek letters in Cambria."""
    writer = pymupdf.TextWriter(page.rect)
    s = 10
    parts = [("L(θ) = ", 0, s), ("∑", 2, s * 1.5), ("i=1", 7, s * 0.6), ("N", -9, s * 0.6),
             (" ‖y", 0, s), ("i", 3, s * 0.6), (" − f", 0, s), ("θ", 3, s * 0.6), ("(x", 0, s), ("i", 3, s * 0.6),
             (")‖", 0, s), ("2", -4, s * 0.6), (" + λ‖θ‖", 0, s), ("1", 3, s * 0.6), ("    (1)", 0, s)]
    cx = x
    for text, dy, size in parts:
        writer.append((cx, y + dy), text, font=fonts.cambria, fontsize=size)
        cx += fonts.cambria.text_length(text, size)
    writer.write_text(page)


def footnote(page, x0, x1, y, text, font, ja=False):
    page.draw_line((x0, y - 9), (x0 + 80, y - 9), width=0.4)
    Column(page, x0, y - 9, x1, 842).para(text, font, 7, ja=ja, lead=1.2)


def typeset(fonts: Fonts) -> tuple[pymupdf.Document, list[tuple[str, str]]]:
    """The five synthetic pages, in the order their sentences were drawn from one seeded generator."""
    f = fonts
    rng = random.Random(42)
    doc = pymupdf.open()
    meta = []

    p = doc.new_page(width=595, height=842)
    c = Column(p, 72, 60, 523, 760)
    c.para("Robust Estimation of Latent Structure in Noisy Observations", f.times_bold, 16, gap=6)
    c.para("Alice Johnson, Bob Tanaka, and Carol Martinez", f.times, 11, gap=8)
    c.para("Abstract", f.times_bold, 11)
    c.para(body(rng, EN, 5), f.times_italic, 10)
    c.para("1 Introduction", f.times_bold, 12)
    for _ in range(3):
        c.para(body(rng, EN, 4), f.times, 10, indent=12)
    c.para("2 Related Work", f.times_bold, 12)
    c.para(body(rng, EN, 4), f.times, 10, indent=12)
    footnote(p, 72, 523, 790, "* Corresponding author. E-mail: alice.johnson@example.edu. This work was supported by grant 21H04567.", f.times)
    meta.append(("synth_en_1col", "en"))

    p = doc.new_page(width=595, height=842)
    c = Column(p, 60, 50, 535, 120)
    c.para("Scalable Inference for Sparse Graphical Models", f.times_bold, 15, gap=4)
    c.para("David Lee and Emma Wilson", f.times, 10.5)
    left = Column(p, 50, c.y + 8, 290, 770)
    right = Column(p, 305, c.y + 8, 545, 770)
    left.para("Abstract", f.times_bold, 10)
    left.para(body(rng, EN, 4), f.times_italic, 9)
    left.para("1. Introduction", f.times_bold, 10)
    while left.room() > 70:
        left.para(body(rng, EN, 3), f.times, 9.5, indent=10)
    right.para("2. Method", f.times_bold, 10)
    while right.room() > 70:
        right.para(body(rng, EN, 3), f.times, 9.5, indent=10)
    footnote(p, 50, 290, 800, "1 Code is available at https://example.org/sparse-graph under the MIT license.", f.times)
    meta.append(("synth_en_2col", "en"))

    p = doc.new_page(width=595, height=842)
    left = Column(p, 50, 50, 290, 790)
    right = Column(p, 305, 50, 545, 790)
    left.para("3. Model", f.times_bold, 10)
    left.para(body(rng, EN, 3), f.times, 9.5, indent=10)
    left.para("We minimize the following objective:", f.times, 9.5)
    equation(p, f, 60, left.y + 22)
    left.y += 40
    left.para(body(rng, EN, 3), f.times, 9.5, indent=10)
    while left.room() > 60:
        left.para(body(rng, EN, 2), f.times, 9.5, indent=10)
    figure(p, (305, 55, 545, 215), f.arial)
    right.y = 225
    right.para("Figure 1. Accuracy of each method as a function of the sample size N.", f.times, 8.5, gap=10)
    right.para("4. Experiments", f.times_bold, 10)
    while right.room() > 60:
        right.para(body(rng, EN, 2), f.times, 9.5, indent=10)
    meta.append(("synth_en_2col_mathfig", "en"))

    p = doc.new_page(width=595, height=842)
    c = Column(p, 72, 60, 523, 760)
    c.para("雑音を含む観測からの潜在構造の頑健な推定", f.gothic, 15, ja=True, gap=6)
    c.para("山田 太郎　佐藤 花子　鈴木 一郎", f.mincho, 11, ja=True, gap=8)
    c.para("概要", f.gothic, 11, ja=True)
    c.para(body(rng, JA, 4), f.mincho, 10, ja=True)
    c.para("1. はじめに", f.gothic, 12, ja=True)
    for _ in range(3):
        c.para("　" + body(rng, JA, 4), f.mincho, 10, ja=True)
    c.para("2. 関連研究", f.gothic, 12, ja=True)
    c.para("　" + body(rng, JA, 5), f.mincho, 10, ja=True)
    footnote(p, 72, 523, 790, "＊連絡先：yamada@example.ac.jp。本研究は科研費21H04567の助成を受けた。", f.mincho, ja=True)
    meta.append(("synth_ja_1col", "ja"))

    p = doc.new_page(width=595, height=842)
    left = Column(p, 50, 50, 290, 790)
    right = Column(p, 305, 50, 545, 790)
    left.para("3. 提案手法", f.gothic, 10.5, ja=True)
    left.para("　" + body(rng, JA, 3), f.mincho, 9.5, ja=True)
    left.para("目的関数を次のように定める。", f.mincho, 9.5, ja=True)
    equation(p, f, 60, left.y + 22)
    left.y += 40
    while left.room() > 60:
        left.para("　" + body(rng, JA, 3), f.mincho, 9.5, ja=True)
    figure(p, (305, 55, 545, 215), f.gothic, ja=True)
    right.y = 225
    right.para("図1　標本数Nに対する各手法の精度", f.mincho, 8.5, ja=True, gap=10)
    right.para("4. 実験", f.gothic, 10.5, ja=True)
    while right.room() > 60:
        right.para("　" + body(rng, JA, 3), f.mincho, 9.5, ja=True)
    meta.append(("synth_ja_2col_mathfig", "ja"))

    for page in doc:
        page.clean_contents()
    return doc, meta


def text_lines(page: pymupdf.Page) -> list[list]:
    lines = []
    for block in page.get_text("dict")["blocks"]:  # pyright: ignore[reportArgumentType, reportCallIssue, reportIndexIssue]
        for line in block.get("lines", []):
            text = "".join(span["text"] for span in line["spans"]).strip()
            if text:
                lines.append([*line["bbox"], text])
    return lines


def cut_page(page: pymupdf.Page, lang: str) -> tuple[Image.Image, dict]:
    """The top part of the page (image, truth): cut near the middle where the fewest lines are crossed."""
    lines = text_lines(page)
    height = page.rect.height
    cut = min((y / 2 for y in range(int(height * .9), int(height * 1.1))),
              key=lambda y: sum(line[1] < y < line[3] for line in lines))
    pixmap = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csGRAY, alpha=False)
    image = Image.frombytes("L", (pixmap.width, pixmap.height), pixmap.samples)
    k = DPI / 72
    draw = ImageDraw.Draw(image)
    for line in lines:
        if line[1] < cut < line[3] + 1:
            draw.rectangle((int((line[0] - 1) * k), int((line[1] - 1) * k), int((line[2] + 1) * k) + 1, int(cut * k) + 2),
                           fill=255)
    image = image.crop((0, 0, image.width, round(cut * k)))
    kept = [[round(v, 1) for v in line[:4]] + [line[4].replace("\xa0", " ")] for line in lines if line[3] + 1 <= cut]
    return image, {"lang": lang, "dpi": DPI, "size": [page.rect.width, cut], "lines": kept}


def main(argv: list[str]) -> int:
    if sys.platform != "win32":
        print("Windows のフォントを使うため、Windows で実行してください。", file=sys.stderr)
        return 1
    out = Path(argv[0]) if argv else ROOT / "tests" / "fixtures" / "ocr"
    out.mkdir(parents=True, exist_ok=True)
    doc, meta = typeset(Fonts())
    truth = {}
    for page, (name, lang) in zip(doc, meta):
        if name not in KEPT:
            continue
        image, truth[name] = cut_page(page, lang)
        quantized = image.quantize(4, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        quantized.save(out / f"{name}.png", optimize=True)
        print(out / f"{name}.png")
    with open(out / "truth.json", "w", encoding="utf-8", newline="\n") as stream:
        json.dump(truth, stream, ensure_ascii=False, indent=0)
    print(out / "truth.json")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
