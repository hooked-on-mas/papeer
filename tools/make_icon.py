r"""Generate the PaperDesk application icon (paperdesk.ico / paperdesk.png).

Run with the project virtual environment:
    .venv\Scripts\python.exe tools\make_icon.py
The generated files are committed, so this only needs to run when the artwork changes.
"""
from __future__ import annotations

from pathlib import Path
import struct
import sys

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QRectF, Qt
from PySide6.QtGui import QColor, QFont, QGuiApplication, QImage, QLinearGradient, QPainter, QPainterPath

ASSETS = Path(__file__).resolve().parent.parent / "paperdesk" / "assets"
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def draw(size: int) -> QImage:
    image = QImage(size, size, QImage.Format.Format_ARGB32_Premultiplied)
    image.fill(Qt.GlobalColor.transparent)
    painter = QPainter(image)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    unit = size / 256.0

    plate = QRectF(8 * unit, 8 * unit, 240 * unit, 240 * unit)
    gradient = QLinearGradient(plate.topLeft(), plate.bottomRight())
    gradient.setColorAt(0.0, QColor("#3f74f2"))
    gradient.setColorAt(1.0, QColor("#1d3fa8"))
    background = QPainterPath()
    background.addRoundedRect(plate, 54 * unit, 54 * unit)
    painter.fillPath(background, gradient)

    # Sheet of paper with a folded corner.
    fold = 46 * unit
    sheet = QRectF(66 * unit, 52 * unit, 124 * unit, 152 * unit)
    page = QPainterPath()
    page.moveTo(sheet.left(), sheet.top())
    page.lineTo(sheet.right() - fold, sheet.top())
    page.lineTo(sheet.right(), sheet.top() + fold)
    page.lineTo(sheet.right(), sheet.bottom())
    page.lineTo(sheet.left(), sheet.bottom())
    page.closeSubpath()
    painter.fillPath(page, QColor("#ffffff"))
    corner = QPainterPath()
    corner.moveTo(sheet.right() - fold, sheet.top())
    corner.lineTo(sheet.right(), sheet.top() + fold)
    corner.lineTo(sheet.right() - fold, sheet.top() + fold)
    corner.closeSubpath()
    painter.fillPath(corner, QColor("#c3d3f5"))

    # Source lines on top, translated lines below, split by an accent rule.
    painter.setPen(Qt.PenStyle.NoPen)
    for index in range(3):
        top = sheet.top() + (62 + index * 20) * unit
        width = (78 if index < 2 else 52) * unit
        painter.fillRect(QRectF(sheet.left() + 18 * unit, top, width, 9 * unit), QColor("#9fb3d9"))
    painter.fillRect(QRectF(sheet.left() + 18 * unit, sheet.top() + 122 * unit, 88 * unit, 10 * unit), QColor("#285ee6"))

    if size >= 48:
        painter.setPen(QColor("#ffffff"))
        font = QFont("Yu Gothic UI")
        font.setPixelSize(int(58 * unit))
        font.setBold(True)
        painter.setFont(font)
        badge = QRectF(140 * unit, 140 * unit, 84 * unit, 84 * unit)
        painter.setBrush(QColor("#f2b23c"))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawEllipse(badge)
        painter.setPen(QColor("#2a1c02"))
        painter.drawText(badge, Qt.AlignmentFlag.AlignCenter, "訳")
    painter.end()
    return image


def png_bytes(image: QImage) -> bytes:
    storage = QByteArray()
    buffer = QBuffer(storage)
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    image.save(buffer, "PNG")
    buffer.close()
    return bytes(storage)


def write_ico(path: Path, frames: list[tuple[int, bytes]]) -> None:
    # Vista+ ICO container: every frame is stored as an embedded PNG.
    header = struct.pack("<HHH", 0, 1, len(frames))
    offset = len(header) + 16 * len(frames)
    entries, payload = b"", b""
    for size, data in frames:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)
    path.write_bytes(header + entries + payload)


def main() -> int:
    QGuiApplication(sys.argv)
    ASSETS.mkdir(parents=True, exist_ok=True)
    frames = [(size, png_bytes(draw(size))) for size in SIZES]
    write_ico(ASSETS / "paperdesk.ico", frames)
    (ASSETS / "paperdesk.png").write_bytes(dict(frames)[256])
    print("wrote", ASSETS / "paperdesk.ico", "and", ASSETS / "paperdesk.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
