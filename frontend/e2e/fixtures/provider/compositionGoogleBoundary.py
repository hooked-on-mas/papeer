"""Owned fake Google HTTP/browser boundary. Production PKCE, DPAPI and authority stay intact."""
import base64
from email.message import Message
import hashlib
import http.client
import io
import json
import secrets
import threading
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import ProxyHandler, build_opener


def install(bridge_url: str, bridge_token: str):
    from papeer.core import cloud_drive_auth as auth
    from papeer.core.providers.drive import transport

    bridge = urlparse(bridge_url)
    if bridge.scheme != 'http' or bridge.hostname != '127.0.0.1' or not bridge.port or bridge.path != '/drive':
        raise ValueError('owned-composition-drive-bridge-required')
    lock = threading.RLock()
    codes = {}
    metrics = {'browserOpened': 0, 'forgedStateRefused': 0, 'callbackAccepted': 0, 'pkceVerified': 0,
               'refreshRequests': 0, 'driveRequests': 0, 'errors': []}

    class Response(io.BytesIO):
        def __init__(self, body, headers=None):
            super().__init__(body)
            self.headers = Message()
            for key, value in (headers or {}).items(): self.headers[key] = value
            self.status = 200

    def token_http(request):
        values = {key: value[0] for key, value in parse_qs(request.data.decode('ascii')).items()}
        with lock:
            if values.get('grant_type') == 'authorization_code':
                expected = codes.pop(values.get('code'), None)
                if expected is None: raise ValueError('fixture-code-not-issued')
                challenge = base64.urlsafe_b64encode(hashlib.sha256(values.get('code_verifier', '').encode('ascii')).digest()).decode('ascii').rstrip('=')
                if (values.get('client_id') != expected['client_id'] or values.get('redirect_uri') != expected['redirect_uri']
                        or challenge != expected['challenge']): raise ValueError('fixture-real-pkce-exchange-mismatch')
                metrics['pkceVerified'] += 1
            elif values.get('grant_type') == 'refresh_token':
                if values.get('refresh_token') != 'fixture-only-refresh': raise ValueError('fixture-refresh-not-issued')
                metrics['refreshRequests'] += 1
            else: raise ValueError('fixture-token-grant-type')
        return Response(json.dumps({'access_token': 'fixture-only-token', 'refresh_token': 'fixture-only-refresh',
                                    'expires_in': 3600, 'token_type': 'Bearer'}).encode('utf8'))

    def open_http(request, timeout=30):
        parsed = urlparse(request.full_url)
        if request.full_url == auth.TOKEN_URL: return token_http(request)
        transport._google_url(request.full_url)
        ticket = getattr(request, '_papeer_request_ticket', None)
        if ticket is not None: ticket.check()
        payload = json.dumps({'url': request.full_url, 'method': request.get_method(),
                              'headers': dict(request.header_items()), 'bodyBase64': base64.b64encode(request.data or b'').decode('ascii')}).encode('utf8')
        connection = http.client.HTTPConnection(bridge.hostname, bridge.port,
                                                 timeout=min(timeout, ticket.remaining()) if ticket is not None else timeout)
        if ticket is not None: ticket.register(connection)
        try:
            connection.connect()
            if ticket is not None:
                ticket.register(connection.sock, connection.sock)
                ticket.check()
            connection.request('POST', bridge.path, body=payload, headers={'Authorization': 'Bearer ' + bridge_token, 'Content-Type': 'application/json'})
            reply = connection.getresponse()
            if reply.status != 200: raise ValueError('fixture-loopback-bridge-failed')
            envelope = json.loads(reply.read(64 * 1024 * 1024))
            if ticket is not None: ticket.check()
        finally: connection.close()
        body = base64.b64decode(envelope['bodyBase64'], validate=True)
        headers = Message()
        for key, value in envelope['headers'].items(): headers[key] = value
        with lock: metrics['driveRequests'] += 1
        if not 200 <= envelope['status'] < 300:
            raise HTTPError(request.full_url, envelope['status'], 'fixture Google HTTP status', headers, io.BytesIO(body))
        return Response(body, envelope['headers'])

    def open_browser(url):
        parsed = urlparse(url)
        if parsed.scheme != 'https' or parsed.hostname != 'accounts.google.com' or parsed.path != '/o/oauth2/v2/auth':
            raise ValueError('fixture-authorize-origin')
        params = {key: value[0] for key, value in parse_qs(parsed.query).items()}
        redirect = urlparse(params['redirect_uri'])
        if redirect.scheme != 'http' or redirect.hostname != '127.0.0.1' or not redirect.port or params.get('code_challenge_method') != 'S256':
            raise ValueError('fixture-generated-loopback-pkce-required')
        code = secrets.token_hex(16)
        with lock:
            codes[code] = {'client_id': params['client_id'], 'redirect_uri': params['redirect_uri'], 'challenge': params['code_challenge']}
            metrics['browserOpened'] += 1

        def callback():
            # Exercise the actual production state guard before delivering the legitimate
            # generated state. This is a fake provider callback, never real Google OAuth.
            opener = build_opener(ProxyHandler({}))
            try:
                try:
                    opener.open(params['redirect_uri'] + '?' + urlencode({'state': 'fixture-forged-state', 'code': 'not-issued'}), timeout=5)
                    raise ValueError('fixture-forged-state-accepted')
                except HTTPError as error:
                    if error.code != 400: raise ValueError('fixture-forged-state-not-refused') from None
                    error.close()
                with lock: metrics['forgedStateRefused'] += 1
                with opener.open(params['redirect_uri'] + '?' + urlencode({'state': params['state'], 'code': code}), timeout=10): pass
                with lock: metrics['callbackAccepted'] += 1
            except Exception:  # noqa: BLE001 - retain fixed worker evidence without authorization URL/token details
                with lock: metrics['errors'].append('fixture-authorization-callback-failed')
        threading.Thread(target=callback, name='fixture-google-callback', daemon=True).start()
        return True

    # Only browser/network calls are substituted. No credential store, generation,
    # completed handle, authority, owner, hub or verifier is supplied or modified.
    auth.urlopen = open_http
    auth.webbrowser.open = open_browser
    transport._open = open_http

    def evidence():
        with lock: return json.loads(json.dumps(metrics))
    return evidence


def install_native_timings():
    """Owned selected fixture only. Delegate to the actual private sync receivers."""
    import functools
    import itertools
    import sys
    import time
    from papeer.core import cloud_drive_auth as auth
    from papeer.core.edit_repository import SqliteEditRepository
    from papeer.core.providers.drive import transport
    from papeer.core.providers.drive.data_plane import _ProviderDriveStorage
    from sidecar.provider import replication

    local, sequence = threading.local(), itertools.count(1)

    def measured(label, action, *args, **kwargs):
        state = getattr(local, 'state', None)
        if state is None: return action(*args, **kwargs)
        row = {'label': label, 'start': (time.perf_counter() - state['start']) * 1000}
        state['spans'].append(row)
        if len(state['spans']) > 256:
            state['spans'].pop(0); state['dropped'] += 1
        outcome = 'raised'
        try:
            result = action(*args, **kwargs)
            outcome = 'returned'
            return result
        finally:
            row['end'] = (time.perf_counter() - state['start']) * 1000
            row['outcome'] = outcome
            value = state['totals'].setdefault(label, {'count': 0, 'totalMs': 0, 'maxMs': 0, 'raised': 0})
            elapsed = row['end'] - row['start']; value['count'] += 1; value['totalMs'] += elapsed
            value['maxMs'] = max(value['maxMs'], elapsed); value['raised'] += outcome == 'raised'

    def union(rows, end):
        intervals = sorted((row['start'], row.get('end', end)) for row in rows)
        total = start = stop = 0
        for a, b in intervals:
            if a > stop: total += stop - start; start, stop = a, b
            else: stop = max(stop, b)
        return total + stop - start

    original_sync = replication.sync_once

    @functools.wraps(original_sync)
    def sync(*args, **kwargs):
        previous = getattr(local, 'state', None)
        state = {'start': time.perf_counter(), 'originEpochMs': time.time() * 1000, 'spans': [], 'totals': {}, 'dropped': 0}
        local.state = state; number = next(sequence); outcome = 'raised'
        try:
            result = original_sync(*args, **kwargs)
            outcome = 'returned'
            return result
        finally:
            end = (time.perf_counter() - state['start']) * 1000
            local.state = previous
            try:
                spans = state['spans']; ongoing = sum('end' not in row for row in spans)
                http_rows = [row for row in spans if row['label'].startswith('http.')]
                summary = {'pass': number, 'startEpochMs': state['originEpochMs'], 'endEpochMs': time.time() * 1000, 'syncMs': end, 'outcome': outcome, 'totals': state['totals'],
                           'retainedHttpSpans': [{'label': row['label'], 'startEpochMs': state['originEpochMs'] + row['start'], 'endEpochMs': state['originEpochMs'] + row['end'] if 'end' in row else None, 'outcome': row.get('outcome', 'ongoing')} for row in http_rows[-32:]],
                           'retainedHttpRowsTruncated': max(0, len(http_rows) - 32),
                           'retainedSpans': len(spans), 'dropped': state['dropped'], 'ongoing': ongoing,
                           'completeRetainedIntervals': not state['dropped'] and not ongoing,
                           'retainedUnionMs': union(spans, end),
                           'retainedHttpUnionMs': union([row for row in spans if row['label'].startswith('http.')], end),
                           'retainedPhaseUnionMs': {label: union([row for row in spans if row['label'] == label], end)
                                                    for label in state['totals']},
                           'scope': 'sync_once only; outer flush queue/drain excluded. Repository methods include proof/validation/SQLite; HTTP includes owned Python/Node bridge. Nested totals overlap; dropped interval unions are incomplete. Postfix location only, no before/after causal speed claim.'}
                print('composition-native-timing:' + json.dumps(summary, separators=(',', ':')), file=sys.stderr, flush=True)
            except Exception:  # noqa: BLE001, S110 - diagnostics must never replace the original sync result or exception
                pass

    def wrap(cls, method, label):
        original = getattr(cls, method)
        @functools.wraps(original)
        def observed(*args, **kwargs): return measured(label, original, *args, **kwargs)
        setattr(cls, method, observed)

    wrap(_ProviderDriveStorage, 'pull', 'storage.pull')
    wrap(SqliteEditRepository, 'receive_records', 'repository.receive_records')
    original_ack = SqliteEditRepository.acknowledge

    @functools.wraps(original_ack)
    def acknowledge(*args, **kwargs):
        peer = args[2] if len(args) > 2 else kwargs.get('peer_id')
        label = 'repository.acknowledge-import' if peer is not None else 'repository.acknowledge-upload'
        return measured(label, original_ack, *args, **kwargs)

    original_http = transport._open

    @functools.wraps(original_http)
    def http(*args, **kwargs):
        if getattr(local, 'state', None) is None: return original_http(*args, **kwargs)
        request = args[0] if args else kwargs['request']
        parsed = urlparse(request.full_url); method = request.get_method()
        method = method if method in {'GET', 'POST', 'PUT'} else 'other'
        kind = ('list-or-post' if parsed.path.endswith('/files') else 'about' if parsed.path.endswith('/about')
                else 'media' if parse_qs(parsed.query).get('alt') == ['media'] else 'metadata')
        return measured('http.' + method + '.' + kind, original_http, *args, **kwargs)

    SqliteEditRepository.acknowledge = acknowledge
    replication.sync_once = sync  # The real flush imports this alias; do not patch a dormant definition.
    auth.urlopen = http
    transport._open = http
