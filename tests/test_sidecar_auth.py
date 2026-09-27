"""Every sidecar route except /health needs the launch token, and the sidecar will not run without one."""
from __future__ import annotations

import re
import sys
from types import SimpleNamespace

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
import pytest
from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocketDisconnect

from sidecar import app as app_module
from sidecar.app import app
from sidecar.routes import system

TOKEN = "correct-token"
PUBLIC_PATHS = {"/health"}


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
    # Should the check ever let /shutdown through, the test run must not exit with it.
    monkeypatch.setattr(system, "threading", SimpleNamespace(Thread=lambda **_: SimpleNamespace(start=lambda: None)))
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


def test_sidecar_refuses_to_start_without_a_token(monkeypatch):
    ran = []
    monkeypatch.setattr("uvicorn.run", lambda *args, **kwargs: ran.append(kwargs))
    with pytest.raises(SystemExit) as stopped:
        app_module.main()
    assert "PAPEER_TOKEN" in str(stopped.value.code)
    assert ran == []


def test_sidecar_starts_with_a_token_and_keeps_it_out_of_the_access_log(monkeypatch):
    ran = []
    monkeypatch.setattr("uvicorn.run", lambda *args, **kwargs: ran.append(kwargs))
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    monkeypatch.setenv("PAPEER_PORT", "8123")
    app_module.main()
    assert ran == [{"host": "127.0.0.1", "port": 8123, "log_level": "info", "access_log": False}]


def test_sidecar_starts_without_auth_only_when_asked(monkeypatch, capsys):
    monkeypatch.setattr("uvicorn.run", lambda *args, **kwargs: None)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    app_module.main()
    assert "認証なし" in capsys.readouterr().err
    for value in ("0", "true", ""):
        monkeypatch.setenv("PAPEER_DEV_NO_AUTH", value)
        assert app_module.startup_error()
