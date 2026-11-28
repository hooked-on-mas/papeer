"""Actual desktop driver to actual FastAPI/SQLite, synthetic Google HTTP only."""
import os
import socket
import subprocess
import threading
import time
from pathlib import Path
import pytest
import uvicorn
from test_provider_data_plane import context  # noqa: F401
from test_provider_verifier import http as google_http  # noqa: F401
from sidecar.app import app
from sidecar.routes import provider_owner


def test_desktop_driver_to_native_owner_routes(context, monkeypatch):  # noqa: F811 - pytest fixture injection
    runner_env = os.environ.get('PAPEER_INTEROP_RUNNER')
    if not runner_env:
        pytest.skip('PAPEER_INTEROP_RUNNER is not set')
    _host, _owner, _plan, _admit, _put, _http = context
    # Use the real default hub factory and route singleton. Only the Google
    # transport/auth boundary and isolated data directory come from the fixture.
    monkeypatch.setattr(provider_owner, '_hub', None)
    monkeypatch.setattr(provider_owner, '_shutdown', False)
    listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(128)
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level='error', lifespan='off'))
    worker = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True); worker.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and worker.is_alive() and time.monotonic() < deadline: time.sleep(.02)
        assert server.started
        environment = os.environ.copy(); environment['PAPEER_INTEROP_PORT'] = str(port)
        runner = Path(runner_env)
        result = subprocess.run(['node', str(runner)], env=environment, capture_output=True, text=True, timeout=90)
        assert result.returncode == 0, result.stdout + '\n' + result.stderr
        assert result.stdout.strip() == 'desktop-wire-interop-pass'
    finally:
        if provider_owner._hub is not None: provider_owner._hub.close()
        server.should_exit = True; worker.join(10); listener.close()
        assert not worker.is_alive()
