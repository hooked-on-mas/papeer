from __future__ import annotations

import io
import json
import math
import threading

from fastapi.testclient import TestClient
from PIL import Image
import pymupdf as fitz
import pytest

from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.pdf.pdf_ink import annotated_pdf
from papeer.pdf.pdf_viewer import page_png
from sidecar.app import app


def stroke(identity="stroke-1", **kwargs):
    return {"id": identity, "color": "#dc2626", "width": 0.006,
            "points": [[0.2, 0.3], [0.7, 0.3], [0.7, 0.5]], **kwargs}


@pytest.fixture
def ink_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "library"))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    source = tmp_path / "sample.pdf"
    with fitz.open() as pdf:
        for _ in range(2):
            pdf.new_page(width=400, height=600).insert_text((40, 40), "Original paper")
        pdf.save(source)
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(source)
    return TestClient(app), lib, identity


def test_ink_persists_and_isolated_by_page_side_and_paper(ink_env):
    client, lib, identity = ink_env
    path = f"/api/papers/{identity}/ink-v2"
    assert client.get(path + "/original/1").json() == {"strokes": []}
    (lib.folder(identity) / "translated.pdf").write_bytes((lib.folder(identity) / "original.pdf").read_bytes())
    for side, page, value in [("original", 1, stroke()), ("original", 2, stroke("second")), ("translated", 1, stroke("translation"))]:
        assert client.put(f"{path}/{side}/{page}", json={"strokes": [value]}).status_code == 200
    reopened = Library(lib.root)
    assert reopened.ink(identity, "original", 1) == [stroke()]
    assert reopened.ink(identity, "original", 2)[0]["id"] == "second"
    assert reopened.ink(identity, "translated", 1)[0]["id"] == "translation"
    assert reopened.ink("another-paper", "original", 1) == []
    assert client.put(path + "/original/1", json={"strokes": []}).status_code == 200
    assert client.get(path + "/original/1").json() == {"strokes": []}
    assert reopened.ink(identity, "original", 2)
    with lib.connection() as db:
        db.execute("DELETE FROM papers WHERE id=?", (identity,))
        assert db.execute("SELECT COUNT(*) FROM pdf_ink").fetchone()[0] == 0


@pytest.mark.parametrize("value", [stroke(points=[]), stroke(points=[[-0.1, 0.5]]),
    stroke(points=[[0.1, 1.01]]), stroke(color="red"), stroke(width=0), stroke(width=0.1)])
def test_invalid_ink_rejected_without_losing_saved_ink(ink_env, value):
    client, _, identity = ink_env
    path = f"/api/papers/{identity}/ink-v2/original/1"
    assert client.put(path, json={"strokes": [stroke()]}).status_code == 200
    assert client.put(path, json={"strokes": [value]}).status_code == 422
    assert client.get(path).json()["strokes"] == [stroke()]


def test_ink_api_auth_and_missing_pages(ink_env, monkeypatch):
    client, _, identity = ink_env
    path = f"/api/papers/{identity}"
    for side, page, status in [("original", 0, 400), ("original", 3, 400), ("translated", 1, 400), ("wrong", 1, 422)]:
        assert client.put(f"{path}/ink-v2/{side}/{page}", json={"strokes": []}).status_code == status
    assert client.get("/api/papers/missing/ink-v2/original/1").status_code == 404
    monkeypatch.setenv("PAPEER_TOKEN", "ink-secret")
    assert client.get(path + "/ink-v2/original/1").status_code == 401
    assert client.put(path + "/ink-v2/original/1", json={"strokes": []}).status_code == 401
    assert client.post(path + "/ink-export", json={"side": "original"}).status_code == 401


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_export_renders_same_coordinates_on_rotated_cropped_pages(ink_env, tmp_path, rotation):
    _, lib, identity = ink_env
    source = tmp_path / f"crop-{rotation}.pdf"
    with fitz.open() as pdf:
        page = pdf.new_page(width=500, height=700)
        page.set_cropbox(fitz.Rect(50, 50, 450, 650))
        page.set_rotation(rotation)
        pdf.save(source)
    before = source.read_bytes()
    lib.save_ink(identity, "original", 1, [stroke(), stroke("dot", points=[[0.5, 0.7]])])
    result = tmp_path / f"ink-{rotation}.pdf"
    result.write_bytes(annotated_pdf(source, lib.ink_by_page(identity, "original")))
    assert source.read_bytes() == before
    png = page_png(result, 0, 800)
    assert png
    image = Image.open(io.BytesIO(png)).convert("RGB")
    for x, y in [(0.3, 0.3), (0.7, 0.4), (0.5, 0.7)]:
        red, green, blue = image.getpixel((round(x * image.width), round(y * image.height)))
        assert red > 180 and green < 90 and blue < 90
    # The open polyline must not be closed into a triangle.
    assert min(image.getpixel((round(0.45 * image.width), round(0.4 * image.height)))) > 240


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_export_paints_highlights_under_the_ink_where_the_reader_showed_them(ink_env, tmp_path, rotation):
    _, lib, identity = ink_env
    source = tmp_path / f"highlight-{rotation}.pdf"
    with fitz.open() as pdf:
        page = pdf.new_page(width=500, height=700)
        page.set_cropbox(fitz.Rect(50, 50, 450, 650))
        page.set_rotation(rotation)
        pdf.save(source)
    lib.add_bookmark(identity, 1, "original", "passage", "", kind="highlight", color="blue", rects=[[.1, .6, .4, .1]])
    lib.save_ink(identity, "original", 1, [stroke()])
    result = tmp_path / f"highlighted-{rotation}.pdf"
    result.write_bytes(annotated_pdf(source, lib.ink_by_page(identity, "original"), lib.highlights_by_page(identity, "original")))
    image = Image.open(io.BytesIO(page_png(result, 0, 800))).convert("RGB")
    at = lambda x, y: image.getpixel((round(x * image.width), round(y * image.height)))
    # Translucent blue inside the rectangle, white paper around it, the ink as before.
    red, green, blue = at(.3, .65)
    assert blue > 230 and red < 225 and blue - red > 25
    assert min(at(.3, .75)) > 240 and min(at(.6, .65)) > 240
    red, green, blue = at(.3, .3)
    assert red > 180 and green < 90 and blue < 90


def test_export_all_pages_preserves_sources_and_blocks_library_overwrite(ink_env, tmp_path):
    client, lib, identity = ink_env
    folder = lib.folder(identity)
    original = (folder / "original.pdf").read_bytes()
    (folder / "translated.pdf").write_bytes(original)
    lib.save_ink(identity, "original", 2, [stroke()])
    lib.save_ink(identity, "translated", 1, [stroke("translation", color="#2563eb")])
    # A page with only a highlight of selected text is painted too, on its own side.
    lib.add_bookmark(identity, 1, "original", "Original paper", "", kind="highlight", color="yellow", rects=[[.1, .05, .3, .03]])
    path = f"/api/papers/{identity}/ink-export"
    for side in ["original", "translated"]:
        response = client.post(path, json={"side": side})
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"
        with fitz.open(stream=response.content, filetype="pdf") as pdf:
            assert len(pdf) == 2
            assert all("Original paper" in page.get_text() for page in pdf)
            assert bool(pdf[0].get_drawings())
            assert bool(pdf[1].get_drawings()) == (side == "original")
            fills = [drawing["fill"] for drawing in pdf[0].get_drawings() if drawing.get("fill")]
            assert any(abs(r - 0xfa / 255) < .01 and abs(b - 0x15 / 255) < .01 for r, _, b in fills) == (side == "original")
    dest = tmp_path / "exports" / "ink.pdf"
    assert client.post(path, json={"side": "original", "destination": str(dest)}).status_code == 200
    assert dest.read_bytes().startswith(b"%PDF-")
    assert client.post(path, json={"side": "original", "destination": str(folder / "original.pdf")}).status_code == 400
    long_form = "\\\\?\\" + str(lib.root.resolve())
    for inside in (str(lib.root / "ink.pdf"), long_form + "\\ink.pdf", str(lib.root) + " \\ink.pdf"):
        assert client.post(path, json={"side": "original", "destination": inside}).status_code == 400
    assert not (lib.root / "ink.pdf").exists()
    assert (folder / "original.pdf").read_bytes() == original
    assert (folder / "translated.pdf").read_bytes() == original
    (folder / "translation-preview.json").write_text(json.dumps({"run_id": "a" * 32, "complete": False}))
    assert client.post(path, json={"side": "translated"}).status_code == 400


def test_ink_is_in_library_backup(ink_env, tmp_path):
    from papeer.core.reading_tools import create_backup, restore_backup
    _, lib, identity = ink_env
    lib.save_ink(identity, "original", 1, [stroke()])
    archive = tmp_path / "backup.zip"
    create_backup(lib, archive)
    lib.save_ink(identity, "original", 1, [])
    restore_backup(lib, archive)
    assert Library(lib.root).ink(identity, "original", 1) == [stroke()]


def test_new_objects_and_page_inventory(ink_env):
    client, lib, identity = ink_env
    path = f"/api/papers/{identity}"
    items = [stroke("highlight", kind="highlighter", width=0.025, color="#facc15"),
             stroke("text", kind="text", text="重要な結果\nResult", points=[[0.2, 0.5], [0.5, 0.5], [0.5, 0.6], [0.2, 0.6]])]
    assert client.put(path + "/ink-v2/original/1", json={"strokes": items}).status_code == 200
    assert client.get(path + "/ink-v2/original/1").json()["strokes"] == items
    assert client.get(path + "/ink-pages").json() == [{"side": "original", "page": 1, "count": 2}]
    assert client.put(path + "/ink-v2/original/2", json={"strokes": []}).status_code == 200
    assert len(client.get(path + "/ink-pages").json()) == 1
    invalid = [stroke(kind="text", text="text"), stroke(kind="wrong"), stroke(kind="text", text="", points=items[1]["points"])]
    for item in invalid:
        assert client.put(path + "/ink-v2/original/1", json={"strokes": [item]}).status_code == 422
    assert lib.ink(identity, "original", 1) == items


@pytest.mark.parametrize("page_rotation", [0, 90, 180, 270])
def test_export_japanese_text_rotated_box_and_transparent_highlighter(ink_env, tmp_path, page_rotation):
    _, lib, identity = ink_env
    source = tmp_path / "text-source.pdf"
    with fitz.open() as pdf:
        page = pdf.new_page(width=500, height=700)
        page.set_cropbox(fitz.Rect(20, 30, 480, 660))
        page.set_rotation(page_rotation)
        width, height = page.rect.width, page.rect.height
        pdf.save(source)
    angle, ratio = math.pi / 6, height / width
    points = [[0.25, 0.3], [0.65, 0.3], [0.65, 0.42], [0.25, 0.42]]
    rotated = [[0.25 + (x - 0.25) * math.cos(angle) - (y - 0.3) * ratio * math.sin(angle),
                0.3 + (x - 0.25) * math.sin(angle) / ratio + (y - 0.3) * math.cos(angle)] for x, y in points]
    lib.save_ink(identity, "original", 1, [
        stroke("highlight", kind="highlighter", width=0.04, color="#facc15", points=[[0.1, 0.8], [0.8, 0.8]]),
        stroke("text", kind="text", text="日本語の注釈\nTest 123", color="#dc2626", points=rotated),
    ])
    output = tmp_path / "annotated-text.pdf"
    output.write_bytes(annotated_pdf(source, lib.ink_by_page(identity, "original")))
    with fitz.open(output) as pdf:
        assert "日本語の注釈" in pdf[0].get_text()
        assert "Test 123" in pdf[0].get_text()
        assert pdf[0].rotation == page_rotation
    image = Image.open(io.BytesIO(page_png(output, 0, 800))).convert("RGB")
    red, green, blue = image.getpixel((int(image.width * 0.4), int(image.height * 0.8)))
    assert red > 240 and green > 220 and 150 < blue < 210  # 30% opacity on white
    # Every red text pixel remains inside the expected transformed text box (with font overshoot tolerance).
    red_pixels = [(i % image.width / image.width, i // image.width / image.height)
                  for i, (r, g, b) in enumerate(image.get_flattened_data()) if r > 130 and g < 100 and b < 100]
    assert len(red_pixels) > 100
    assert min(x for x, _ in red_pixels) >= min(x for x, _ in rotated) - 0.015
    assert max(x for x, _ in red_pixels) <= max(x for x, _ in rotated) + 0.015
    assert min(y for _, y in red_pixels) >= min(y for _, y in rotated) - 0.015
    assert max(y for _, y in red_pixels) <= max(y for _, y in rotated) + 0.015


def test_capture_is_scoped_to_page_and_usable_as_note_media(ink_env, monkeypatch):
    client, _, identity = ink_env
    path = f"/api/papers/{identity}"
    body = {"side": "original", "page": 1, "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.2}
    response = client.post(path + "/ink-capture-v2", json=body)
    assert response.status_code == 200
    media = client.get(path + "/" + response.json()["file"])
    assert media.status_code == 200 and media.headers["content-type"] == "image/png"
    with Image.open(io.BytesIO(media.content)) as image:
        assert image.size == (900, 540)
    assert client.post(path + "/ink-capture-v2", json={**body, "x": 0.9}).status_code == 422
    assert client.post(path + "/ink-capture-v2", json={**body, "page": 100}).status_code == 400
    monkeypatch.setenv("PAPEER_TOKEN", "secret")
    assert client.post(path + "/ink-capture-v2", json=body).status_code == 401
    assert client.get(path + "/ink-pages").status_code == 401


@pytest.mark.parametrize("side", ["original", "translated"])
@pytest.mark.parametrize("rotation", [0, 90])
def test_capture_can_include_ink_on_rotated_and_preview_pages(ink_env, side, rotation):
    client, lib, identity = ink_env
    folder = lib.folder(identity)
    source = folder / "original.pdf"
    if side == "translated":
        run_id = "a" * 32
        preview_folder = folder / "translation-pages" / run_id
        preview_folder.mkdir(parents=True)
        source = preview_folder / "page-2.pdf"
        with fitz.open() as pdf:
            pdf.new_page(width=400, height=600).insert_text((40, 40), "Translated preview")
            pdf.save(source)
        (folder / "translation-preview.json").write_text(json.dumps({
            "run_id": run_id, "complete": False, "pages": [2], "total_pages": 2}))
    with fitz.open(source) as pdf:
        pdf[0 if side == "translated" else 1].set_rotation(rotation)
        pdf.saveIncr()
    before = source.read_bytes()
    lib.save_ink(identity, side, 2, [stroke(width=0.02), stroke("text", kind="text", color="#0000ff", text="確認",
        points=[[.2, .4], [.4, .4], [.4, .5], [.2, .5]])])
    base = f"/api/papers/{identity}"
    body = {"side": side, "page": 2, "x": .1, "y": .2, "width": .8, "height": .4}
    for include in [False, True]:
        response = client.post(base + "/ink-capture-v2", json={**body, "include_ink": include})
        assert response.status_code == 200
        data = client.get(base + "/" + response.json()["file"]).content
        with Image.open(io.BytesIO(data)).convert("RGB") as image:
            pixels = list(image.get_flattened_data())
            assert any(r > 130 and g < 100 and b < 100 for r, g, b in pixels) == include
            assert any(b > 130 and r < 100 and g < 100 for r, g, b in pixels) == include
    assert source.read_bytes() == before


class SummaryProvider:
    def __init__(self, fail=False):
        self.fail = fail

    def generate(self, instruction, data, schema=None):
        if self.fail:
            raise RuntimeError("summary failed")
        return "# サマリー\n\n" + data


def test_summary_regeneration_replaces_only_its_figures_and_keeps_note_captures(ink_env):
    client, lib, identity = ink_env
    body = {"side": "original", "page": 1, "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.2}
    file = client.post(f"/api/papers/{identity}/ink-capture-v2", json=body).json()["file"]
    files = PaperFiles(lib.folder(identity))
    capture = files.folder / file
    assert capture.parent == files.media and capture.name.startswith("ink-capture-")
    lib.update(identity, note=f"![切り抜き]({file})")
    stale = files.media / "p9i1.png"  # a figure of a previous summary that this PDF no longer yields
    stale.write_bytes(capture.read_bytes())
    assert files.summary_images() == [stale]
    with fitz.open(files.original_pdf) as pdf:  # one embedded raster figure on page 1
        pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 50, 40), False)
        pixmap.clear_with(128)
        pdf[0].insert_image(fitz.Rect(50, 100, 250, 260), pixmap=pixmap)
        pdf[0].insert_text((50, 278), "Figure 1: Controller architecture.", fontsize=9)
        pdf.saveIncr()
    figure = files.media / "p1i1.png"

    with pytest.raises(RuntimeError):
        PaperService(lib, SummaryProvider(fail=True), threading.Event()).article(identity)
    assert stale.is_file(), "the current summary keeps its images until a new one replaces it"
    for _ in range(2):
        article = PaperService(lib, SummaryProvider(), threading.Event()).article(identity)
        assert "(media/p1i1.png)" in article
    assert not stale.exists()
    assert files.summary_images() == [figure]
    assert capture.is_file() and client.get(f"/api/papers/{identity}/{file}").status_code == 200
    assert lib.paper(identity)["note"] == f"![切り抜き]({file})"


def test_locked_old_summary_figure_does_not_fail_the_summary(ink_env, monkeypatch):
    from pathlib import Path

    _, lib, identity = ink_env
    files = PaperFiles(lib.folder(identity))
    files.media.mkdir()
    stale = files.media / "p9i1.png"
    stale.write_bytes(b"old figure")
    unlink = Path.unlink

    def locked(path, *args, **kwargs):
        if path == stale:
            raise PermissionError("in use by another process")
        return unlink(path, *args, **kwargs)

    class MeteredProvider(SummaryProvider):
        def usage_report(self):
            return {"input_tokens": 10}

    monkeypatch.setattr(Path, "unlink", locked)
    PaperService(lib, MeteredProvider(), threading.Event()).article(identity)
    assert files.article_md.is_file() and stale.is_file()
    assert json.loads(files.article_usage.read_text("utf-8")) == {"input_tokens": 10}
    monkeypatch.setattr(Path, "unlink", unlink)
    PaperService(lib, SummaryProvider(), threading.Event()).article(identity)
    assert not stale.exists(), "the leftover goes with the next successful summary"


def test_ink_page_capture_and_export_rules_without_the_routes(ink_env, tmp_path):
    from papeer.core import ink
    from papeer.core.errors import Invalid, NotFound

    _, lib, identity = ink_env
    folder = lib.folder(identity)
    assert ink.check_page(lib, identity, "original", 2) == (PaperFiles(folder).original_pdf, 1)
    for side, page in (("original", 0), ("original", 3), ("translated", 1)):
        with pytest.raises(Invalid):
            ink.check_page(lib, identity, side, page)
    with pytest.raises(NotFound):
        ink.check_page(lib, "0" * 32, "original", 1)
    # Library.paper_folder, which the routes use too: NotFound also for an ID that is not one.
    assert lib.paper_folder(identity) == folder
    for unknown in ("0" * 32, "../papers", ""):
        with pytest.raises(NotFound, match="論文が見つかりません"):
            lib.paper_folder(unknown)

    lib.save_ink(identity, "original", 1, [stroke()])
    saved = ink.save_capture(lib, identity, "original", 1, (0.1, 0.1, 0.5, 0.5), include_ink=True)
    assert (saved["page"], saved["side"]) == (1, "original")
    assert (folder / saved["file"]).read_bytes().startswith(b"\x89PNG")

    data, written = ink.export_annotated(lib, identity, "original", None)
    assert written is None and data.startswith(b"%PDF")
    target = tmp_path / "exports" / "annotated.PDF"
    data, written = ink.export_annotated(lib, identity, "original", str(target))
    assert written == target.resolve() and target.read_bytes() == data
    for refused in (lib.root / "annotated.pdf", tmp_path / "annotated.png"):
        with pytest.raises(Invalid, match="ライブラリの外"):
            ink.export_annotated(lib, identity, "original", str(refused))
    with pytest.raises(Invalid, match="保存するPDF"):
        ink.export_annotated(lib, identity, "translated", None)
    assert not (lib.root / "annotated.pdf").exists()
