"""Real loopback socket cancellation behind the fixed Google HTTP boundary.

TLS/real Google are NOT exercised: only the private connection factory is routed
onto a local HTTP server. Production URL/redirect policy remains fixed HTTPS.
"""
import hashlib
import sys
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
import socket
import threading
import time
from urllib.parse import parse_qs, urlparse
import pytest
from test_provider_data_plane import context as provider_context, google_http  # noqa: F401 - pytest fixture
from papeer.core.edit_drive import scope_namespace
from papeer.core.providers.drive import transport
from papeer.core.providers.drive.request_group import ProviderRequestCancelled, ProviderRequestGroup


class HeldServer:
    def __init__(self, mode):
        self.entered, self.release = threading.Event(), threading.Event()
        self.mode = mode; self.hold = True; self.data = b'x' * 100
        owner = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def handle(self):
                try: super().handle()
                except OSError: pass  # Expected owned client shutdown during cancellation.
            def do_GET(self):
                try:
                    if owner.hold and owner.mode == 'headers':
                        owner.entered.set(); owner.release.wait(4)
                    self.send_response(200); self.send_header('Content-Length', str(len(owner.data)))
                    if owner.mode == 'keepalive': self.send_header('Connection', 'keep-alive')
                    self.end_headers()
                    if owner.hold and owner.mode in ['body', 'keepalive']:
                        self.wfile.write(owner.data[:1]); self.wfile.flush()
                        owner.entered.set(); owner.release.wait(4)
                        self.wfile.write(owner.data[1:])
                    elif owner.hold and owner.mode == 'drip':
                        owner.entered.set()
                        for byte in owner.data:
                            self.wfile.write(bytes([byte])); self.wfile.flush()
                            if owner.release.wait(.025): break
                    else: self.wfile.write(owner.data)
                except OSError: pass  # Client-side cancellation is the expected test outcome.
            def log_message(self, _format, *_args): pass
        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True, name='synthetic-google-http')
        self.worker.start()

    def close(self):
        self.release.set(); self.server.shutdown(); self.server.server_close(); self.worker.join(timeout=2)
        assert not self.worker.is_alive()


def route_held_resource(monkeypatch, host, owner, http, server):
    folder = owner.live_evidence()['folderId']
    metadata = {'id': '00000000-0000-0000-0000-000000077777', 'mediaType': 'application/octet-stream',
                'sha256': hashlib.sha256(server.data).hexdigest(), 'byteLength': len(server.data)}
    http['files']['held-resource'] = {'metadata': http['metadata']('held-resource', mimeType='application/octet-stream', size=str(len(server.data)), parents=[folder],
        properties={'papeer': 'edits-resource-v1', 'scope': scope_namespace(owner.descriptor()['scope']), 'sha256': metadata['sha256']}), 'bytes': server.data}
    fake_open, real_open = transport._open, http['production_open']
    class LoopbackConnection(transport._TrackedHTTPSConnection):
        def connect(self):
            self._ticket.check()
            self.sock = socket.create_connection(server.server.server_address, timeout=min(2, self._ticket.remaining()))
            self.sock.settimeout(None)  # Mirror production group-timer/blocking-read cancellation.
            duplicate = socket.socket(self.sock.family, self.sock.type, self.sock.proto, fileno=socket.dup(self.sock.fileno()))
            self._ticket.register(duplicate, duplicate)
            try: self._ticket.check()
            except ValueError: self.close(); raise
    monkeypatch.setattr(transport, '_make_scoped_connection', lambda address, *, ticket, **kwargs: LoopbackConnection(address, ticket=ticket, **kwargs))
    def opened(request, timeout):
        url = urlparse(request.full_url)
        if url.path.endswith('/held-resource') and parse_qs(url.query).get('alt') == ['media']:
            assert request.get_header('Authorization') == 'Bearer synthetic-not-a-real-token'
            return real_open(request, timeout)
        return fake_open(request, timeout)
    monkeypatch.setattr(transport, '_open', opened)
    return metadata


@pytest.mark.parametrize('mode', ['headers', 'body', 'keepalive'])
def test_owned_socket_cancel_interrupts_headers_or_body_and_keeps_principal(provider_context, monkeypatch, mode):  # noqa: F811 - pytest fixture injection
    host, owner, _plan, admit, _put, http = provider_context; admit(); storage = host.edit_storage(owner)
    server = HeldServer(mode); metadata = route_held_resource(monkeypatch, host, owner, http, server)
    errors = []; shutdowns = []; original_shutdown = socket.socket.shutdown
    def observed_shutdown(sock, how):
        before = (sock.fileno(), sock._closed, sock._io_refs)
        try:
            result = original_shutdown(sock, how); shutdowns.append((*before, 0)); return result
        except OSError as error:
            shutdowns.append((*before, error.errno)); raise
    monkeypatch.setattr(socket.socket, 'shutdown', observed_shutdown)
    def read():
        try:
            with storage.pass_scope(): storage.read_resource(metadata, 'held-resource')
        except Exception as error: errors.append(error)  # noqa: BLE001 - exact worker error asserted below.
    storage.renew(); worker = threading.Thread(target=read, name='synthetic-owned-read'); worker.start()
    try:
        assert server.entered.wait(3)
        started = time.monotonic(); assert host.health_current(owner._principal)
        assert time.monotonic() - started < .5  # Advisory health does not wait for held host/auth lock.
        diagnostic = []
        for current in tuple(storage._active_groups):
            with current._lock:
                diagnostic.append({'same_renewed':current is storage._io_group,'entries':[(type(target).__name__, getattr(getattr(target,'sock',None),'fileno',lambda:None)(), getattr(sock,'fileno',lambda:None)()) for target,sock in current._entries.values()]})
        storage.cancel(); worker.join(timeout=2)
        print('SHUTDOWN_TRACE',mode,shutdowns,flush=True)
        if worker.is_alive():
            print('CANCEL_DIAGNOSTIC', mode, diagnostic, ''.join(traceback.format_stack(sys._current_frames()[worker.ident])), flush=True)
        assert not worker.is_alive() and len(errors) == 1 and isinstance(errors[0], ProviderRequestCancelled)
        assert time.monotonic() - started < 2
        assert not server.release.is_set()  # The server was NOT released to manufacture drain.
        assert host.health_current(owner._principal)
        storage.finish(); server.hold = False; server.release.set()
        storage.renew()
        assert storage.read_resource(metadata, 'held-resource') == server.data
        storage.finish()
    finally:
        storage.cancel(); server.close(); worker.join(timeout=2); storage.finish()


def test_total_group_deadline_interrupts_slow_continuous_body(provider_context, monkeypatch):  # noqa: F811 - pytest fixture injection
    host, owner, _plan, admit, _put, http = provider_context; admit(); storage = host.edit_storage(owner)
    server = HeldServer('drip'); metadata = route_held_resource(monkeypatch, host, owner, http, server)
    monkeypatch.setattr(host, 'new_request_group', lambda: ProviderRequestGroup(.2))
    errors = []
    def read():
        try: storage.read_resource(metadata, 'held-resource')
        except Exception as error: errors.append(error)  # noqa: BLE001 - exact worker error asserted below.
    storage.renew(); worker = threading.Thread(target=read, name='synthetic-deadline-read'); started = time.monotonic(); worker.start()
    try:
        assert server.entered.wait(3); worker.join(timeout=2)
        assert not worker.is_alive() and len(errors) == 1 and isinstance(errors[0], ProviderRequestCancelled)
        assert str(errors[0]) == 'provider-io-deadline' and time.monotonic() - started < 2
        assert host.health_current(owner._principal)
    finally: server.close(); worker.join(timeout=2); storage.finish()


def test_cancel_between_request_start_and_connection_registration_never_connects():
    group = ProviderRequestGroup()
    try:
        with group.request() as ticket:
            group.cancel()
            with pytest.raises(ProviderRequestCancelled):
                transport._make_scoped_connection('www.googleapis.com', ticket=ticket, timeout=1)
    finally: group.close()


@pytest.mark.parametrize('change_generation', [False, True])
def test_provider_refresh_http_does_not_hold_commit_lock_and_old_reply_cannot_save(provider_context, monkeypatch, change_generation):  # noqa: F811 - pytest fixture injection
    from copy import deepcopy
    from papeer.core import cloud_drive_auth as auth
    host, owner, _plan, _admit, _put, _http = provider_context
    saved = {'access_token': 'synthetic-not-a-real-token', 'refresh_token': 'synthetic-refresh', 'client_id': 'synthetic.apps.googleusercontent.com', 'expires_at': 0}
    monkeypatch.setattr(auth, '_load', lambda: deepcopy(saved))
    writes = []
    def save(value): writes.append(deepcopy(value)); saved.clear(); saved.update(value)
    monkeypatch.setattr(auth, '_save', save)
    entered, release = threading.Event(), threading.Event()
    def token(_values, request_group=None):
        entered.set(); assert release.wait(3)
        return {'access_token': 'synthetic-not-a-real-token', 'expires_at': 9999999999}
    monkeypatch.setattr(auth, '_token', token)
    group = host.new_request_group(); results, errors = [], []
    def current():
        try:
            with host.io_scope(group): results.append(host.current())
        except Exception as error: errors.append(error)  # noqa: BLE001 - expected stale generation asserted below.
    worker = threading.Thread(target=current, name='synthetic-token-refresh'); worker.start()
    try:
        assert entered.wait(3); started = time.monotonic()
        # This is the same authoritative credential guard used by the SQLite
        # commit lease, not an optimistic reader check.
        with auth.transfer_guard(auth.generation()): pass
        assert time.monotonic() - started < .5
        if change_generation:
            with auth._change_credentials(): pass
        release.set(); worker.join(timeout=2); assert not worker.is_alive()
        if change_generation:
            assert writes == [] and results == [] and len(errors) == 1
        else:
            assert len(writes) == 1 and len(results) == 1 and errors == []
    finally: release.set(); worker.join(timeout=2); group.close()
