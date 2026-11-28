"""Isolated native edit API process for restart/HTTP-loss acceptance tests."""
from contextlib import asynccontextmanager, contextmanager, closing
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import time

# Startup timing observation only (PAPEER_COMPOSITION_STARTUP_TIMING=1): one stderr line per step; never changes the startup order.
_TIMING = os.environ.get("PAPEER_COMPOSITION_STARTUP_TIMING") == "1"


def _mark(step: str) -> None:
    if _TIMING:
        print("composition-sidecar-timing: " + json.dumps({"step": step, "epochMs": round(time.time() * 1000, 1)}), file=sys.stderr, flush=True)


_mark("entry")
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
database, token = Path(sys.argv[1]).resolve(), sys.argv[2]
provider_composition = len(sys.argv) > 3 and sys.argv[3] == "provider-composition"
temporary = Path(tempfile.gettempdir()).resolve()
scope_root = next((parent for parent in (database.parent, *database.parent.parents)
                   if parent.parent == temporary and parent.name.startswith("papeer-intent-http-")), None)
if scope_root is None:
    raise ValueError("not-an-isolated-fixture-directory")
os.environ["PAPEER_TOKEN"] = token
os.environ["PAPEER_DATA_DIR"] = str(database.parent)
from papeer.core import paths
_mark("papeer-paths-imported")
device_root = Path(sys.argv[5]).resolve() if len(sys.argv) > 5 else scope_root / "device-state-fixture"
if not device_root.is_relative_to(scope_root):
    raise ValueError("not-an-isolated-device-fixture")
paths.device_directory = lambda: device_root

provider_evidence = None
if provider_composition:
    # This selected canonical root is fresh. The legacy sentinel belongs to a
    # different, unselected directory and is never offered to bootstrap.
    if database.exists():
        raise ValueError("provider-composition-selected-root-must-be-fresh")
    device_root.mkdir(parents=True, exist_ok=True)
    config = scope_root / "synthetic-desktop-oauth.json"
    config.write_text(json.dumps({"client_id": "composition-fixture.apps.googleusercontent.com"}), encoding="utf8")
    os.environ["PAPEER_GOOGLE_OAUTH_CONFIG_FILE"] = str(config)
    _mark("provider-install-start")
    from provider.compositionGoogleBoundary import install
    provider_evidence = install(sys.argv[4], token)
    _mark("provider-install-done")

from fastapi import Header, HTTPException
import uvicorn
_mark("sidecar-app-import-start")
from sidecar.app import app
_mark("sidecar-app-import-done")
if provider_composition and os.environ.get('PAPEER_COMPOSITION_STARTUP_DIAGNOSTICS') == '1':
    from provider.compositionGoogleBoundary import install_native_timings
    install_native_timings()
from sidecar import deps
from sidecar.routes import edits
from papeer.core.migrations.legacy_drive import LegacyDriveRead
from tools.legacy_drive_fixture import FixtureLegacyDrive


class FixtureLibrary:
    @contextmanager
    def connection(self):
        with closing(sqlite3.connect(database)) as db, db:
            yield db


def verify_fixture(authorization: str | None = Header(default=None)):
    if authorization != "Bearer " + token:
        raise HTTPException(401, "fixture-token")


@asynccontextmanager
async def isolated_lifespan(_app):
    yield  # No startup AI/jobs or cleanup; requests use the temporary fixture library.


deps.get_data_dir = lambda: database.parent
if not provider_composition and (len(sys.argv) <= 3 or sys.argv[3] != "separate-edits"):
    deps.get_library = lambda: FixtureLibrary()
    deps.get_edit_connection = lambda: FixtureLibrary().connection
if not provider_composition and len(sys.argv) > 4 and sys.argv[4] != "-":
    drive_fixture = json.loads(Path(sys.argv[4]).read_text("utf-8"))
    fixture_drive = FixtureLegacyDrive(drive_fixture)
    edits.legacy_drive_storage = lambda: LegacyDriveRead(fixture_drive)
app.dependency_overrides[deps.verify_token] = verify_fixture
app.router.lifespan_context = isolated_lifespan
if provider_evidence is not None:
    from fastapi import Depends

    @app.get("/composition/auth-evidence", dependencies=[Depends(verify_fixture)])
    def composition_auth_evidence():
        return provider_evidence()
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
_mark("before-port-line")
print(json.dumps({"port": sock.getsockname()[1]}), flush=True)
_mark("before-uvicorn-run")
uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(sockets=[sock])
