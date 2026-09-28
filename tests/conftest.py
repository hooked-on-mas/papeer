"""Keep every test away from the user's real library and device settings.

papeer reads %LOCALAPPDATA%\\Papeer (prompts, settings, papers) and %LOCALAPPDATA%\\PapeerSync
(folder-sync state, this PC's CLI paths and API URL: paths.device_directory()),
so the environment is pointed at a temporary folder before any papeer module is imported,
and again for each test. An audit hook (tests/_isolation.py) refuses file access under the
real folders and fails the test even when the code under test swallows the error.

Known gaps: os.stat and friends (Path.exists, is_dir, ...) raise no audit event, so existence
checks are not caught; C extensions that open files themselves (PyMuPDF, pypdfium2, fontTools'
native parts) bypass the hook; subprocesses are protected only by the environment they inherit.

The bundled fonts converted to TrueType (pdf_fonts.cached_truetype, some 30 seconds to make) would be
made again under every test's fresh LOCALAPPDATA, so PAPEER_FONT_CACHE_DIR points at pytest's own cache
folder instead: converted once, then reused by later runs, and never the real one.

The Tesseract language data the OCR tests read (tessdata_fast eng and jpn, some 6.5 MB, not in the
repository) is kept there too ("papeer-tessdata"), or taken from PAPEER_TEST_TESSDATA. It is downloaded
(once, with papeer's own download, checked by SHA-256) only when PAPEER_TEST_DOWNLOAD_TESSDATA=1; without
it those tests are skipped, and with it a failed download fails them (CI sets it).
"""
from __future__ import annotations

import atexit
import os
from pathlib import Path
import shutil
import sys
import tempfile

import pytest

# Must come before the environment changes below: it records the real folders.
from _isolation import audit_hook, take_violations
from _frozen_documents import frozen_view
from _tessdata import prepare_tessdata

pytest_plugins = ["pytester"]


def _point_environment_at(base: Path, setenv) -> None:
    setenv("LOCALAPPDATA", str(base))
    setenv("PAPEER_DATA_DIR", str(base / "Papeer"))


# Before collection imports papeer: modules that read the data folder at import time get a temporary one.
_session_base = Path(tempfile.mkdtemp(prefix="papeer-test-appdata-"))
atexit.register(shutil.rmtree, _session_base, ignore_errors=True)
_point_environment_at(_session_base, os.environ.__setitem__)
os.environ.pop("PAPERDESK_DATA_DIR", None)
sys.addaudithook(audit_hook)


_tessdata_base: Path = _session_base / "tessdata"


def pytest_configure(config):
    global _tessdata_base
    cache = getattr(config, "cache", None)  # None with -p no:cacheprovider
    fonts = cache.mkdir("papeer-font-cache") if cache is not None else _session_base / "font-cache"
    os.environ["PAPEER_FONT_CACHE_DIR"] = str(fonts)
    if cache is not None:
        _tessdata_base = cache.mkdir("papeer-tessdata")


@pytest.fixture(scope="session")
def tessdata():
    """A folder with the Tesseract language data of every OCR language (tests/_tessdata.py)."""
    return prepare_tessdata(_tessdata_base, os.environ)


@pytest.fixture(autouse=True)
def isolated_app_data(tmp_path_factory, monkeypatch):
    """A fresh, empty LOCALAPPDATA and data folder for every test; fail on any real-data access."""
    # Accesses swallowed outside a test (at import or collection) fail the next test instead of vanishing.
    earlier = take_violations()
    if earlier:
        pytest.fail("テスト開始前に実データへのアクセスがありました:\n" + "\n".join(earlier), pytrace=False)
    base = tmp_path_factory.mktemp("appdata")
    _point_environment_at(base, monkeypatch.setenv)
    monkeypatch.delenv("PAPERDESK_DATA_DIR", raising=False)
    # The sidecar's token or no-auth flag from the developer's shell must not decide what a test sees.
    for name in ("PAPEER_TOKEN", "PAPERDESK_TOKEN", "PAPEER_DEV_NO_AUTH"):
        monkeypatch.delenv(name, raising=False)
    # The Codex connection reads the MCP servers in the developer's ~/.codex/config.toml.
    monkeypatch.setenv("CODEX_HOME", str(base / "codex-home"))
    yield base
    found = take_violations()
    if found:
        pytest.fail("\n".join(found), pytrace=False)


@pytest.fixture(autouse=True)
def frozen_shared_documents(monkeypatch):
    """Library.document gives every caller the same value until document.json changes: changing it
    in place (instead of a copy) raises in tests (tests/_frozen_documents.py)."""
    try:
        from papeer.core.storage import Library
    except ModuleNotFoundError:  # A pytester run of this conftest outside the repository (test_isolation).
        return
    monkeypatch.setattr(Library, "document", frozen_view(Library.document))


def pytest_sessionfinish(session):
    found = take_violations()
    if found:
        sys.stderr.write("\n実データへのアクセスがありました:\n" + "\n".join(found) + "\n")
        session.exitstatus = 1
