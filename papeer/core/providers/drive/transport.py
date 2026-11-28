"""Fixed Google HTTP receiver using the existing configured PKCE/DPAPI credential lifetime.

No UI input selects the token, principal, origin, fetch client or permission evidence.
"""
from contextlib import contextmanager, nullcontext
import json
import http.client
import secrets
import socket
import ssl
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import BaseHandler, HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from papeer.core import cloud_drive_auth
from papeer.core.cloud_drive import Drive

API = 'https://www.googleapis.com/drive/v3'
UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'


class DriveProviderHttpError(ValueError):
    def __init__(self, status, acknowledged_range=None):
        self.status = status
        self.acknowledged_range = acknowledged_range
        super().__init__(f'drive-provider-http-{status}')


def _google_url(url):
    parsed = urlparse(url)
    if (parsed.scheme != 'https' or parsed.hostname != 'www.googleapis.com' or parsed.username or parsed.password
            or parsed.port not in (None, 443) or not parsed.path.startswith(('/drive/v3/', '/upload/drive/v3/'))):
        raise ValueError('drive-provider-origin')


class _GoogleRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _google_url(newurl)
        raise ValueError('drive-provider-redirect')


class _TrackedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, *, ticket, **kwargs):
        super().__init__(host, **kwargs)
        self._ticket = ticket; ticket.register(self)

    def connect(self):
        self._ticket.check()
        # The OS DNS resolver is not cancellable. TCP/TLS is separately bounded;
        # a socket created after cancellation is rejected and closed immediately.
        self.timeout = min(self.timeout if self.timeout is not None else 60, 10, self._ticket.remaining())
        super().connect()
        try:
            self._ticket.check()
            sock = self.sock
            if sock is None: raise ValueError('drive-provider-connect-failed')
            # Blocking socket reads are interrupted by group socket.shutdown.
            # Windows timed-select can defer shutdown until its read timeout;
            # the group's single absolute timer bounds the whole pass instead.
            sock.settimeout(None)
            # urllib may close/detach the original socket while HTTPResponse
            # retains its makefile. Keep an independently owned shutdown handle.
            # It never reads/writes plaintext or bypasses the verified TLS stream.
            duplicate = socket.socket(sock.family, sock.type, sock.proto, fileno=socket.dup(sock.fileno()))
            self._ticket.register(duplicate, duplicate)
        except (OSError, ValueError):
            self.close(); raise

    def getresponse(self):
        sock = self.sock
        response = super().getresponse()
        # urllib detaches/closes its connection socket after headers. Retain the
        # actual socket for shutdown while HTTPResponse's makefile owns the body.
        self._ticket.register(response, sock)
        return response


def _make_scoped_connection(host, *, ticket, **kwargs):
    return _TrackedHTTPSConnection(host, ticket=ticket, **kwargs)


class _ScopedHTTPSHandler(HTTPSHandler):
    def __init__(self, ticket):
        self._verified_context = ssl.create_default_context()
        super().__init__(context=self._verified_context); self._ticket = ticket

    def https_open(self, req):
        return self.do_open(lambda host, **kwargs: _make_scoped_connection(host, ticket=self._ticket, **kwargs), req, context=self._verified_context)


def _open(request, timeout):
    # Fixed origin and verified default TLS context remain unchanged. No caller
    # can select a connector; tests replace this private network boundary only.
    ticket = getattr(request, '_papeer_request_ticket', None)
    handlers: list[BaseHandler] = [_GoogleRedirect()]
    if ticket is not None: handlers.append(_ScopedHTTPSHandler(ticket))
    return build_opener(*handlers).open(request, timeout=timeout)


def _id(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 200 or any(not (char.isascii() and (char.isalnum() or char in '_-')) for char in value):
        raise ValueError('invalid-drive-id')
    return value


class GoogleDriveProviderTransport(Drive):
    """Host-private collaborator. The production host constructs this itself; tests patch HTTP, never owner booleans."""
    def __init__(self, assert_host, guard_host, denied, request_group=lambda: None):
        super().__init__()
        self._assert_host = assert_host
        self._guard_host = guard_host
        self._denied = denied
        self._request_group = request_group

    def assert_current(self):
        self._assert_host()
        super().assert_current()

    @contextmanager
    def request(self, url, *, method='GET', data=None, headers=None):
        _google_url(url)
        group = self._request_group()
        with group.request() if group is not None else nullcontext(None) as ticket:
            self.assert_current()
            try:
                with self._guard_host():
                    request = Request(url, method=method, data=data, headers={**(headers or {}), 'Authorization': 'Bearer ' + cloud_drive_auth.capture_provider_access_token(self.generation, group)})
                    if ticket is not None:
                        ticket.check(); setattr(request, '_papeer_request_ticket', ticket)
                    with _open(request, timeout=min(60, ticket.remaining()) if ticket is not None else 60) as response:
                        self.assert_current()
                        yield response
                        self.assert_current()
                        if ticket is not None: ticket.check()
            except HTTPError as error:
                if ticket is not None: ticket.check()
                if error.code == 401 or (error.code == 403 and urlparse(url).path == '/drive/v3/about'):
                    self.assert_current()
                    self._denied()
                raise DriveProviderHttpError(error.code, error.headers.get('Range') if error.code == 308 else None) from None
            except (URLError, TimeoutError, OSError, http.client.HTTPException):
                if ticket is not None: ticket.check()
                raise ValueError('drive-provider-network') from None
            except ValueError:
                if ticket is not None: ticket.check()
                raise

    def json(self, url, *, method='GET', value=None):
        with self.request(url, method=method, data=None if value is None else json.dumps(value, ensure_ascii=False).encode('utf8'),
                          headers={'Content-Type': 'application/json'}) as response:
            data = response.read(512 * 1024 + 1)
        if len(data) > 512 * 1024:
            raise ValueError('drive-provider-metadata-size')
        try:
            return json.loads(data.decode('utf8', errors='strict'))
        except (ValueError, UnicodeError):
            raise ValueError('drive-provider-metadata-json') from None

    def about(self):
        return self.json(API + '/about?fields=user(permissionId)')

    def metadata(self, file_id, fields):
        return self.json(API + '/files/' + _id(file_id) + '?' + urlencode({'fields': fields, 'supportsAllDrives': 'true'}))

    def bytes(self, file_id, limit):
        if not isinstance(limit, int) or not 1 <= limit <= 16 * 1024 * 1024:
            raise ValueError('drive-provider-body-limit')
        with self.request(API + '/files/' + _id(file_id) + '?alt=media&supportsAllDrives=true') as response:
            raw = response.read(limit + 1)
        if len(raw) > limit:
            raise ValueError('drive-provider-body-too-large')
        return raw

    def list_files(self, query, fields):
        result, seen, token = [], set(), None
        while True:
            params = {'q': query, 'fields': f'nextPageToken,incompleteSearch,files({fields})', 'pageSize': '1000', 'corpora': 'user', 'spaces': 'drive'}
            if token:
                params['pageToken'] = token
            page = self.json(API + '/files?' + urlencode(params))
            if not isinstance(page.get('files'), list) or page.get('incompleteSearch') or len(result) + len(page['files']) > 50_000:
                raise ValueError('drive-list-incomplete')
            result.extend(page['files'])
            token = page.get('nextPageToken')
            if token is None:
                return result
            if not isinstance(token, str) or not token or token in seen:
                raise ValueError('drive-list-pagination')
            seen.add(token)

    def allocate_file_ids(self, count):
        if type(count) is not int or not 1 <= count <= 100:
            raise ValueError('drive-id-count')
        value = self.json(API + '/files/generateIds?' + urlencode({'count': count, 'space': 'drive', 'type': 'files'}))
        ids = value.get('ids')
        if not isinstance(ids, list) or len(ids) != count or len(set(ids)) != count:
            raise ValueError('drive-generated-ids')
        return [_id(value) for value in ids]

    def create_metadata(self, value):
        return self.json(API + '/files?fields=id', method='POST', value=value)

    def create_json(self, metadata, raw):
        boundary = 'papeer_provider_' + secrets.token_hex(16)
        body = (f'--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'.encode()
                + json.dumps(metadata, ensure_ascii=False).encode('utf8')
                + f'\r\n--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'.encode()
                + bytes(raw) + f'\r\n--{boundary}--'.encode())
        with self.request(UPLOAD + '?uploadType=multipart&fields=id', method='POST', data=body,
                          headers={'Content-Type': f'multipart/related; boundary={boundary}'}) as response:
            result = response.read(65537)
        if len(result) > 65536:
            raise ValueError('drive-create-response-size')
        try:
            return json.loads(result)
        except (ValueError, UnicodeError):
            raise ValueError('drive-create-response-json') from None

    def resource_bytes(self, file_id, expected_length):
        if type(expected_length) is not int or not 1 <= expected_length <= 128 * 1024 * 1024:
            raise ValueError('drive-provider-resource-limit')
        result = bytearray()
        with self.request(API + '/files/' + _id(file_id) + '?alt=media&supportsAllDrives=true') as response:
            while len(result) <= expected_length:
                chunk = response.read(min(1024 * 1024, expected_length + 1 - len(result)))
                if not chunk: break
                result.extend(chunk); self.assert_current()
        if len(result) != expected_length: raise ValueError('resource-hash')
        return bytes(result)

    def create_binary(self, metadata, raw, media_type):
        if not 1 <= len(raw) <= 128 * 1024 * 1024: raise ValueError('drive-provider-resource-limit')
        if media_type == 'application/json': return self.create_json(metadata, raw)
        # Same fixed-origin, bounded-chunk resumable protocol as existing Drive.upload;
        # all requests additionally retain host generation and reject redirects.
        with self.request(UPLOAD + '?uploadType=resumable&fields=id', method='POST', data=json.dumps(metadata, ensure_ascii=False).encode('utf8'),
                          headers={'Content-Type': 'application/json', 'X-Upload-Content-Length': str(len(raw)), 'X-Upload-Content-Type': media_type}) as response:
            location = response.headers.get('Location')
        if not isinstance(location, str): raise ValueError('drive-upload-session')
        _google_url(location)
        offset = 0
        while offset < len(raw):
            chunk = raw[offset:offset + 8 * 1024 * 1024]; end = offset + len(chunk)
            try:
                with self.request(location, method='PUT', data=chunk,
                                  headers={'Content-Type': media_type, 'Content-Length': str(len(chunk)), 'Content-Range': f'bytes {offset}-{end - 1}/{len(raw)}'}) as response:
                    result = response.read(65537)
                if end != len(raw) or len(result) > 65536: raise ValueError('drive-upload-incomplete')
                value = json.loads(result.decode('utf8', errors='strict'))
                if value.get('id') != metadata['id']: raise ValueError('drive-upload-id')
                return value
            except DriveProviderHttpError as error:
                if error.status != 308: raise
                if error.acknowledged_range != f'bytes=0-{end - 1}' or end >= len(raw): raise ValueError('drive-upload-range') from error
            offset = end
        raise ValueError('drive-upload-incomplete')
