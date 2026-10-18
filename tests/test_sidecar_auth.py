"""Every sidecar route except /health needs the launch token, and the sidecar will not run without one."""
from __future__ import annotations

import re
import sys

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
import pytest
from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocketDisconnect

from papeer.core import instance as instance_module
from sidecar import app as app_module
from sidecar import deps
from sidecar import instance as sidecar_instance
from sidecar.app import app
from sidecar.jobs import JobManager
from sidecar.routes import system

TOKEN = "correct-token"
# /html-view/<ticket> takes a ticket from the authenticated API instead of the token (tests/test_html_documents.py).
PUBLIC_PATHS = {"/health", "/html-view/1"}


def _flatten(routes):
    # FastAPI 0.141 keeps an included router as one wrapper route that points at the original router.
    for route in routes:
        inner = getattr(route, "original_router", None)
        if inner is not None:
            yield from _flatten(inner.routes)
        else:
            yield route


def http_routes() -> list[tuple[str, str]]:
    """(method, path) of every HTTP route, path parameters filled with a placeholder."""
    found = []
    for route in _flatten(app.routes):
        if not isinstance(route, APIRoute):
            continue
        path = re.sub(r"\{[^}]+\}", "1", route.path)
        found += [(method, path) for method in sorted(route.methods) if method != "HEAD"]
    return found


@pytest.fixture
def client(monkeypatch):
    # Should the check ever let /shutdown through, the test run must not exit with it, nor lose the
    # shared job manager (a shutdown refuses every later job).
    monkeypatch.setattr(system, "exit_process", lambda: None)
    monkeypatch.setattr(deps, "job_manager", JobManager())
    return TestClient(app)


def test_routes_are_enumerated():
    """The walk sees every route the schema lists, so a new router or prefix cannot slip past the tests."""
    routes = set(http_routes())
    schema = {(method.upper(), re.sub(r"\{[^}]+\}", "1", path))
              for path, operations in app.openapi()["paths"].items() for method in operations}
    assert schema <= routes
    assert {("GET", "/health"), ("POST", "/shutdown")} <= routes


@pytest.mark.parametrize(("method", "path"), [r for r in http_routes() if r[1] not in PUBLIC_PATHS])
def test_every_route_but_health_needs_the_token(client, monkeypatch, method, path):
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    assert client.request(method, path).status_code == 401
    assert client.request(method, path, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.request(method, path, params={"token": "wrong"}).status_code == 401


def test_health_stays_open(client, monkeypatch):
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    assert client.get("/health").status_code == 200


def test_routes_are_closed_when_no_token_is_configured(client):
    """Without a token and without the development flag nothing is let through, not even an empty token."""
    assert client.get("/api/settings").status_code == 401
    assert client.get("/api/settings", headers={"Authorization": "Bearer "}).status_code == 401
    assert client.get("/api/settings?token=").status_code == 401


def test_token_comparison_accepts_only_the_exact_token(client, monkeypatch):
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    assert client.get("/api/settings", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200
    assert client.get("/api/settings", params={"token": TOKEN}).status_code == 200
    for wrong in (TOKEN[:-1], TOKEN + "x", TOKEN.upper(), "トークン"):
        assert client.get("/api/settings", params={"token": wrong}).status_code == 401


def test_development_flag_disables_auth_only_without_a_token(client, monkeypatch):
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    assert client.get("/api/settings").status_code == 200
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    assert client.get("/api/settings").status_code == 401


def test_packaged_sidecar_ignores_the_development_flag(client, monkeypatch):
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert client.get("/api/settings").status_code == 401
    assert app_module.startup_error()


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"])
def test_api_documentation_is_not_served(client, monkeypatch, path):
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    assert client.get(path, params={"token": TOKEN}).status_code == 404


def test_event_socket_needs_the_token(monkeypatch):
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    assert any(isinstance(r, WebSocketRoute) and r.path == "/ws/events" for r in _flatten(app.routes))
    with TestClient(app) as client:
        for url in ("/ws/events", "/ws/events?token=wrong", "/ws/events?token="):
            with pytest.raises(WebSocketDisconnect) as refused:
                with client.websocket_connect(url):
                    pass
            assert refused.value.code == 1008
        with client.websocket_connect(f"/ws/events?token={TOKEN}") as socket:
            socket.send_text("ping")


def test_event_socket_is_closed_when_no_token_is_configured():
    with TestClient(app) as client:
        for url in ("/ws/events", "/ws/events?token=", "/ws/events?token=anything"):
            with pytest.raises(WebSocketDisconnect) as refused:
                with client.websocket_connect(url):
                    pass
            assert refused.value.code == 1008


def test_event_socket_opens_without_a_token_under_the_development_flag(monkeypatch):
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    with TestClient(app) as client:
        with client.websocket_connect("/ws/events") as socket:
            socket.send_text("ping")


def test_development_flag_has_no_legacy_spelling(client, monkeypatch):
    monkeypatch.setenv("PAPERDESK_DEV_NO_AUTH", "1")
    assert client.get("/api/settings").status_code == 401
    assert app_module.startup_error()


class _FakeSocket:
    """What bind_socket gives main() instead of a real listening socket."""

    def __init__(self, port: int) -> None:
        self.port = port

    def getsockname(self) -> tuple[str, int]:
        return ("127.0.0.1", self.port or 54321)


def _no_server(monkeypatch, started: bool = True) -> list[dict]:
    """uvicorn's server and the socket replaced by recorders: what main() hands the server, and the
    discovery file as it was while the server ran."""
    ran: list[dict] = []

    class FakeServer:
        def __init__(self, config):
            self.config = config
            self.started = started

        def run(self, sockets=None):
            ran.append({"host": self.config.host, "port": self.config.port, "log_level": self.config.log_level,
                        "access_log": self.config.access_log,
                        "timeout_graceful_shutdown": self.config.timeout_graceful_shutdown,
                        "sockets": sockets, "advertised": instance_module.read_instance(deps.get_data_dir())})

    monkeypatch.setattr("uvicorn.Server", FakeServer)
    monkeypatch.setattr(app_module, "bind_socket", _FakeSocket)
    for name in ("_lock", "_root", "_info", "_idle_grace"):  # What main() sets; put back after the test.
        monkeypatch.setattr(sidecar_instance, name, None)
    return ran


def test_sidecar_refuses_to_start_without_a_token(monkeypatch):
    ran = _no_server(monkeypatch)
    with pytest.raises(SystemExit) as stopped:
        app_module.main()
    assert "PAPEER_TOKEN" in str(stopped.value.code)
    assert ran == []


def _ends_with_the_app(monkeypatch) -> list[str]:
    """What main() sets up to end with the app, recorded instead of done (the test run is not the app)."""
    calls: list[str] = []
    monkeypatch.setattr(system, "start_watching_stdin", lambda: calls.append("stdin"))
    monkeypatch.setattr(system, "stop_on_terminate", lambda: calls.append("sigterm"))
    return calls


def test_sidecar_starts_with_a_token_and_keeps_it_out_of_the_access_log(monkeypatch):
    ran = _no_server(monkeypatch)
    ends = _ends_with_the_app(monkeypatch)
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    monkeypatch.setenv("PAPEER_PORT", "8123")
    monkeypatch.setenv("PAPEER_LAUNCHER", "app")
    app_module.main()
    # After SIGTERM, requests still running get a few seconds before the jobs are stopped. The socket is
    # bound by main() (the server is given it), and the discovery file was written before the server ran.
    assert len(ran) == 1
    assert {key: value for key, value in ran[0].items() if key not in ("sockets", "advertised")} == {
        "host": "127.0.0.1", "port": 8123, "log_level": "info", "access_log": False,
        "timeout_graceful_shutdown": app_module.SIGTERM_REQUEST_TIMEOUT}
    assert len(ran[0]["sockets"]) == 1 and ran[0]["sockets"][0].port == 8123
    advertised = ran[0]["advertised"]
    assert (advertised.port, advertised.token, advertised.launcher) == (8123, TOKEN, "app")
    # Withdrawn and released once the server has stopped.
    assert instance_module.read_instance(deps.get_data_dir()) is None
    assert ends == ["stdin", "sigterm"]


def test_sidecar_that_could_not_start_its_server_exits_with_3_like_uvicorn_run(monkeypatch):
    _no_server(monkeypatch, started=False)
    _ends_with_the_app(monkeypatch)
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    with pytest.raises(SystemExit) as stopped:
        app_module.main()
    assert stopped.value.code == app_module.EXIT_PORT_TAKEN == 3


def test_sidecar_starts_without_auth_only_when_asked(monkeypatch, capsys):
    _no_server(monkeypatch)
    _ends_with_the_app(monkeypatch)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    app_module.main()
    assert "認証なし" in capsys.readouterr().err
    for value in ("0", "true", ""):
        monkeypatch.setenv("PAPEER_DEV_NO_AUTH", value)
        assert app_module.startup_error()


def preflight(client: TestClient, origin: str):
    return client.options("/api/settings", headers={"Origin": origin, "Access-Control-Request-Method": "GET",
                                                    "Access-Control-Request-Headers": "authorization"})


def test_only_a_development_sidecar_answers_the_vite_dev_server(client):
    """A page served from localhost:1420 or 5173 in a browser must not reach the packaged app's sidecar."""
    packaged = app_module.allowed_origins(packaged=True)
    assert "http://tauri.localhost" in packaged and "tauri://localhost" in packaged
    assert not any("localhost:" in origin or "127.0.0.1" in origin for origin in packaged)
    assert set(app_module.allowed_origins(packaged=False)) == set(packaged) | {
        "http://localhost:1420", "http://localhost:5173", "http://127.0.0.1:1420", "http://127.0.0.1:5173"}
    # The tests run from source, like `just dev-sidecar`.
    for origin in ("http://tauri.localhost", "http://localhost:1420"):
        answer = preflight(client, origin)
        assert answer.status_code == 200 and answer.headers["access-control-allow-origin"] == origin
    refused = preflight(client, "http://localhost:3000")
    assert "access-control-allow-origin" not in refused.headers
