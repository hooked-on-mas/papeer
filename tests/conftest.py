"""Keep every test away from the user's real library and device settings.

papeer reads %LOCALAPPDATA%\\Papeer (prompts, settings, papers) and %LOCALAPPDATA%\\PapeerSync
(folder-sync state, this PC's CLI paths and API URL: paths.device_directory()),
so the environment is pointed at a temporary folder before any papeer module is imported,
and again for each test. An audit hook (tests/_isolation.py) refuses file access under the
real folders and fails the test even when the code under test swallows the error.

Known gaps: os.stat and friends (Path.exists, is_dir, ...) raise no audit event, so existence
checks are not caught; C extensions that open files themselves (PyMuPDF, pypdfium2, fontTools'
native parts) bypass the hook; subprocesses are protected only by the environment they inherit.
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
    yield base
    found = take_violations()
    if found:
        pytest.fail("\n".join(found), pytrace=False)


def pytest_sessionfinish(session):
    found = take_violations()
    if found:
        sys.stderr.write("\n実データへのアクセスがありました:\n" + "\n".join(found) + "\n")
        session.exitstatus = 1
