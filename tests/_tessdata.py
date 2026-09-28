"""The Tesseract language data for the OCR tests (the tessdata fixture of conftest.py).

Nothing is downloaded unless asked for (PAPEER_TEST_DOWNLOAD_TESSDATA=1): without it a missing file skips
the tests with how to get it; with it (CI) a failed download fails them instead of skipping them unnoticed.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path

import pytest

DOWNLOAD_VARIABLE = "PAPEER_TEST_DOWNLOAD_TESSDATA"
FOLDER_VARIABLE = "PAPEER_TEST_TESSDATA"


def prepare_tessdata(default: Path, environ: Mapping[str, str], download: Callable[..., Path] | None = None) -> Path:
    """The folder holding every OCR language's data; pytest.skip or pytest.fail when it cannot."""
    from papeer.layout.ocr_engines import TESSDATA, OcrError, download_tessdata, tessdata_ready

    directory = Path(environ.get(FOLDER_VARIABLE) or default)
    missing = [lang for lang in TESSDATA if not tessdata_ready(lang, directory)]
    if not missing:
        return directory
    if environ.get(DOWNLOAD_VARIABLE) != "1":
        pytest.skip(f"OCR の言語データ（{', '.join(TESSDATA[lang][0] for lang in missing)}）が {directory} にありません。"
                    f"{DOWNLOAD_VARIABLE}=1 を付けて pytest を実行するとダウンロードします（約 6.5MB、1 回だけ）。"
                    f"{FOLDER_VARIABLE} に置き場所を指定することもできます。")
    for lang in missing:
        try:
            (download or download_tessdata)(lang, lambda url, size: True, directory)
        except OcrError as error:
            pytest.fail(f"テスト用の OCR の言語データを用意できませんでした（{error}）", pytrace=False)
    return directory
