"""Synthetic OAuth completion + fake HTTP boundary, NOT real Google/PKCE/DPAPI validation."""
import hashlib
import io
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request
import uuid
import pytest

from papeer.core import cloud_drive_auth as auth
from papeer.core.edit_model import canonical_json
from papeer.core.providers.drive import transport
from papeer.core.providers.drive.principal import google_drive_principal_digest
from papeer.core.providers.drive.verifier import create_google_drive_provider_host


class Response(io.BytesIO):
    headers = {}


@pytest.fixture
def http(monkeypatch):
    monkeypatch.setattr(auth, '_generation', 'synthetic-auth-generation')
    monkeypatch.setattr(auth, '_attempt', None)
    monkeypatch.setattr(auth, '_completed_authorization_generation', None)
    monkeypatch.setattr(auth, '_load', lambda: {'access_token': 'synthetic-not-a-real-token', 'refresh_token': 'synthetic-refresh', 'client_id': 'synthetic.apps.googleusercontent.com', 'expires_at': 9999999999})
    monkeypatch.setattr(auth, 'status', lambda: {'connected': True, 'connecting': False, 'auth_error': None})
    def connect(capture=None):
        handle = object()
        with auth._change_credentials():
            if capture is not None and not capture(handle): return {'connecting': False}, handle
            auth._completed_authorization_handle = handle
            auth._completed_authorization_generation = auth._generation  # Synthetic successful code exchange, not a real OAuth run.
        return {'connecting': False}, handle
    monkeypatch.setattr(auth, 'connect_with_attempt', connect)
    monkeypatch.setattr(auth, 'disconnect', lambda: connect()[0])
    state = {'principal': 'fixture-permission-A', 'files': {}, 'requests': [], 'created': {}, 'lose': set(), 'denied': False, 'version_race': False, 'sessions': {}}
    def metadata(file_id, **extra):
        return {'id': file_id, 'name': 'Human Library 日本語', 'mimeType': 'application/json', 'version': '9007199254740993', 'size': '1',
                'ownedByMe': True, 'trashed': False, 'capabilities': {'canEdit': True, 'canDownload': True}, 'parents': ['folder'],
                'properties': {'papeer': 'canonical-provider-v1', 'providerKind': 'descriptor'}, **extra}
    state['metadata'] = metadata
    state['files']['folder'] = {'metadata': metadata('folder', mimeType='application/vnd.google-apps.folder', properties={}), 'bytes': b''}
    def open_http(request, timeout):
        url = urlparse(request.full_url)
        assert url.scheme == 'https' and url.hostname == 'www.googleapis.com'
        assert request.get_header('Authorization') == 'Bearer synthetic-not-a-real-token'
        state['requests'].append((request.method, url.path))
        query = parse_qs(url.query)
        if url.path.endswith('/about'):
            if state.get('denied_about'):
                raise HTTPError(request.full_url, 403, 'synthetic denied', {}, None)
            return Response(json.dumps({'user': {'permissionId': state['principal']}}).encode())
        if url.path.endswith('/generateIds'):
            count = int(query['count'][0]); start = state.get('allocated', 0); state['allocated'] = start + count
            ids = ['generated-folder', 'generated-checkpoint', 'generated-manifest', 'generated-descriptor'] if count == 4 and start == 0 else ['generated-' + str(start + index) for index in range(count)]
            return Response(json.dumps({'ids': ids}).encode())
        if url.path.endswith('/files') and request.method == 'GET':
            q = query.get('q', [''])[0]
            properties = re.findall(r"key='([^']+)' and value='([^']+)'", q)
            parents = re.findall(r"'([^']+)' in parents", q)
            return Response(json.dumps({'files': [value['metadata'] for value in state['files'].values()
                if all(value['metadata'].get('properties', {}).get(key) == item for key, item in properties)
                and all(parent in value['metadata'].get('parents', []) for parent in parents)]}).encode())
        if request.method == 'PUT':
            session = state['sessions'][query['upload_id'][0]]
            session['bytes'] += request.data
            raw, value = session['bytes'], session['metadata']
            if len(raw) < session['size']:
                raise HTTPError(request.full_url, 308, 'synthetic resumable', {'Range': f'bytes=0-{len(raw) - 1}'}, None)
            file_id = value['id']
            state['files'][file_id] = {'metadata': metadata(file_id, **{key: item for key, item in value.items() if key != 'id'}, size=str(len(raw))), 'bytes': raw}
            state['created'][file_id] = state['created'].get(file_id, 0) + 1
            if file_id in state['lose']:
                state['lose'].remove(file_id)
                raise URLError('synthetic final PUT reply lost')
            return Response(json.dumps({'id': file_id}).encode())
        if request.method == 'POST':
            if query.get('uploadType') == ['resumable']:
                value = json.loads(request.data); file_id = value['id']
                if file_id in state['files']: raise HTTPError(request.full_url, 409, 'synthetic conflict', {}, None)
                state['sessions'][file_id] = {'metadata': value, 'bytes': b'', 'size': int(request.get_header('X-upload-content-length'))}
                response = Response(b''); response.headers = {'Location': 'https://www.googleapis.com/upload/drive/v3/files?upload_id=' + file_id}
                return response
            if request.get_header('Content-type', '').startswith('multipart/'):
                boundary = request.get_header('Content-type').split('boundary=')[1]
                pieces = [part for part in request.data.split(('--' + boundary).encode()) if b'Content-Type:' in part]
                value = json.loads(pieces[0].split(b'\r\n\r\n')[1].strip())
                raw = pieces[1].split(b'\r\n\r\n')[1].removesuffix(b'\r\n')
            else:
                value, raw = json.loads(request.data), b''
            file_id = value['id']
            if file_id in state['files']:
                raise HTTPError(request.full_url, 409, 'synthetic conflict', {}, None)
            state['files'][file_id] = {'metadata': metadata(file_id, **{key: item for key, item in value.items() if key != 'id'}, size=str(len(raw))), 'bytes': raw}
            state['created'][file_id] = state['created'].get(file_id, 0) + 1
            if file_id in state['lose']:
                state['lose'].remove(file_id)
                raise URLError('synthetic accepted POST reply lost')
            return Response(json.dumps({'id': file_id}).encode())
        if state['denied'] and url.path.rsplit('/', 1)[1] == 'descriptor':
            raise HTTPError(request.full_url, 403, 'synthetic denied', {}, None)
        file_id = url.path.rsplit('/', 1)[1]
        if file_id not in state['files']:
            raise HTTPError(request.full_url, 404, 'synthetic missing', {}, None)
        file = state['files'][file_id]
        if query.get('alt') == ['media']:
            if state['version_race']:
                file['metadata']['version'] = '9007199254740994'
            return Response(file['bytes'])
        return Response(json.dumps(file['metadata']).encode())
    state['production_open'] = transport._open
    monkeypatch.setattr(transport, '_open', open_http)
    return state


def sample_descriptor():
    scope = {key: str(uuid.uuid4()) for key in ('accountId', 'libraryId', 'epoch')}
    raw = canonical_json({'version': 1, 'scope': scope, 'manifestId': str(uuid.uuid4()), 'checkpointSha256': 'b' * 64}).encode('utf8')
    return scope, raw


def connected():
    host = create_google_drive_provider_host()
    host.connect()
    return host, host.finish_connect()


def test_real_receiver_http_owner_version_bytes_and_commit_guard(http):
    host, principal = connected()
    try:
        assert principal['digest'] == google_drive_principal_digest('fixture-permission-A')
        scope, raw = sample_descriptor()
        http['files']['descriptor'] = {'metadata': http['metadata']('descriptor', size=str(len(raw)), sha256Checksum=hashlib.sha256(raw).hexdigest()), 'bytes': raw}
        assert host.list() == [{'id': 'descriptor', 'title': 'Human Library 日本語'}]
        summary = host.descriptor(principal, 'descriptor')
        assert summary['scope'] == scope and summary['version'] == '9007199254740993'
        assert summary['folderId'] == 'folder' and summary['title'] == 'Human Library 日本語'
        assert host.descriptor_bytes(principal, 'descriptor') == raw
        with host.guard(principal):
            host.assert_current(principal)  # Nested hostRLock/authRLock is intentional for SQLite callers.
        http['version_race'] = True
        with pytest.raises(ValueError, match='version-changed'):
            host.descriptor(principal, 'descriptor')
    finally:
        host.close()


def test_about403_locks_authenticated_receiver(http):
    host, principal = connected()
    try:
        http['denied_about'] = True
        with pytest.raises(ValueError, match='403'):
            host.current()
        with pytest.raises(ValueError):
            host.assert_current(principal)
    finally:
        host.close()


def test_file403_keeps_other_descriptor_choices_usable(http):
    host, principal = connected()
    try:
        scope, raw = sample_descriptor()
        for file_id in ['descriptor', 'valid']:
            http['files'][file_id] = {'metadata': http['metadata'](file_id, size=str(len(raw))), 'bytes': raw}
        http['denied'] = True
        with pytest.raises(ValueError, match='403'):
            host.descriptor(principal, 'descriptor')
        host.assert_current(principal)
        assert len(host.list()) == 2
        assert host.descriptor(principal, 'valid')['scope'] == scope
    finally:
        host.close()


def test_generated_ids_retry_without_list_visibility_or_replacement(http):
    host, _principal = connected()
    try:
        ids = host.allocate_file_ids(4)
        logical_folder, logical_descriptor = str(uuid.uuid4()), str(uuid.uuid4())
        http['lose'].add(ids[0])
        with pytest.raises(ValueError, match='network'):
            host.create_folder(ids[0], logical_folder, 'Human Library 日本語')
        folder = host.create_folder(ids[0], logical_folder, 'Human Library 日本語')
        assert folder['id'] == ids[0] and http['created'][ids[0]] == 1
        _scope, raw = sample_descriptor()
        http['lose'].add(ids[3])
        with pytest.raises(ValueError, match='network'):
            host.write_descriptor(ids[3], logical_descriptor, folder['id'], 'Human Library 日本語', raw, 'a' * 64)
        result = host.write_descriptor(ids[3], logical_descriptor, folder['id'], 'Human Library 日本語', raw, 'a' * 64)
        assert result['id'] == ids[3] and result['sha256'] == hashlib.sha256(raw).hexdigest() and http['created'][ids[3]] == 1
        assert http['files'][ids[3]]['metadata']['name'] == 'Human Library 日本語'
    finally:
        host.close()


def test_redirect_never_forwards_bearer_to_other_host():
    with pytest.raises(ValueError, match='provider-origin'):
        transport._GoogleRedirect().redirect_request(Request('https://www.googleapis.com/drive/v3/files', headers={'Authorization': 'Bearer synthetic'}), None,
            302, 'synthetic redirect', {}, 'https://not-google.invalid/collect')


def test_cancelled_oauth_attempt_cannot_resume_old_stored_credentials(http, monkeypatch):
    host = create_google_drive_provider_host()
    def cancelled_connect(capture=None):
        handle = object()
        with auth._change_credentials():
            if capture is not None: capture(handle)
            # No successful authorization-code save; old credentials are not a completion.
        return {'connecting': False}, handle
    monkeypatch.setattr(auth, 'connect_with_attempt', cancelled_connect)
    try:
        host.connect()
        with pytest.raises(ValueError, match='not-completed'):
            host.finish_connect()
        assert http['requests'] == []
    finally:
        host.close()


@pytest.mark.parametrize('patch', [
    {'ownedByMe': False}, {'capabilities': {'canEdit': False, 'canDownload': True}},
    {'capabilities': {'canEdit': True, 'canDownload': False}}, {'driveId': 'shared-drive'}, {'trashed': True},
])
def test_http_owner_capabilities_refuse_before_body_without_global_signout(http, patch):
    host, principal = connected()
    try:
        _scope, raw = sample_descriptor()
        http['files']['descriptor'] = {'metadata': http['metadata']('descriptor', size=str(len(raw)), **patch), 'bytes': raw}
        with pytest.raises(ValueError, match='owner-write-required'):
            host.descriptor(principal, 'descriptor')
        host.assert_current(principal)
        http['files']['valid'] = {'metadata': http['metadata']('valid', size=str(len(raw))), 'bytes': raw}
        assert host.descriptor(principal, 'valid')['scope'] == _scope
    finally:
        host.close()


@pytest.mark.parametrize('outcome', ['success', 'token-failure', 'cancel'])
def test_real_auth_module_sets_completion_marker_only_after_valid_code_save(monkeypatch, tmp_path, outcome):
    # Run the candidate auth.connect/callback worker itself. Only browser launching,
    # OAuth HTTP exchange and DPAPI file save are fake external boundaries.
    import threading
    import time
    from urllib.parse import urlencode
    from urllib.request import ProxyHandler, build_opener
    from papeer.core.cloud_drive_config import DesktopOAuth
    monkeypatch.setattr(auth, 'desktop_oauth', lambda: DesktopOAuth('synthetic.apps.googleusercontent.com'))
    monkeypatch.setattr(auth, 'setup_status', lambda: {'configured': True, 'setup_error': None})
    monkeypatch.setattr(auth, '_attempt', None)
    monkeypatch.setattr(auth, '_error', None)
    monkeypatch.setattr(auth, '_error_code', None)
    monkeypatch.setattr(auth, '_path', lambda: tmp_path / 'never-real-credentials.dpapi')
    saved, opened = [], []
    monkeypatch.setattr(auth, '_save', saved.append)
    def token(_values):
        if outcome == 'token-failure':
            raise auth._OAuthFailure('invalid_grant')
        return {'access_token': 'synthetic-access', 'refresh_token': 'synthetic-refresh', 'expires_at': 9999999999}
    monkeypatch.setattr(auth, '_token', token)
    def browser(url):
        params = parse_qs(url.split('?', 1)[1]);opened.append(params)
        if outcome != 'cancel':
            with build_opener(ProxyHandler({})).open(params['redirect_uri'][0] + '?' + urlencode({'state': params['state'][0], 'code': 'synthetic-code'}), timeout=3):
                pass
        return True
    monkeypatch.setattr(auth.webbrowser, 'open', browser)
    try:
        auth.connect()
        if outcome == 'cancel':
            auth.cancel()
        deadline = time.monotonic() + 4
        while auth.status()['connecting'] and time.monotonic() < deadline:
            threading.Event().wait(.01)
        assert not auth.status()['connecting'] and len(opened) == 1
        if outcome == 'success':
            assert len(saved) == 1
            assert auth.completed_authorization_generation() == auth.generation()
        else:
            assert saved == []
            assert auth.completed_authorization_generation() is None
    finally:
        auth.cancel()


@pytest.mark.parametrize('bad', ['noncanonical', 'hash', 'size'])
def test_descriptor_body_canonical_size_hash_validation(http, bad):
    host, principal = connected()
    try:
        _scope, raw = sample_descriptor()
        if bad == 'noncanonical':
            raw += b' '
        http['files']['descriptor'] = {'metadata': http['metadata']('descriptor', size='4097' if bad == 'size' else str(len(raw)), sha256Checksum='0' * 64 if bad == 'hash' else hashlib.sha256(raw).hexdigest()), 'bytes': raw}
        with pytest.raises(ValueError):
            host.descriptor(principal, 'descriptor')
    finally:
        host.close()


def test_old_401_cannot_invalidate_reconnected_same_principal(http, monkeypatch):
    host, old_principal = connected()
    original = transport._open
    new_principal = []
    def late_response(request, timeout):
        monkeypatch.setattr(transport, '_open', original)
        host.connect()
        new_principal.append(host.finish_connect())
        raise HTTPError(request.full_url, 401, 'synthetic old response', {}, None)
    try:
        monkeypatch.setattr(transport, '_open', late_response)
        with pytest.raises(ValueError):
            host.list()
        assert new_principal and new_principal[0] != old_principal
        host.assert_current(new_principal[0])
        assert host.current() == new_principal[0]
    finally:
        host.close()


def test_list_files_paginates_past_1000_and_create_json_uses_random_boundary(http, monkeypatch):
    host, _principal = connected()
    original = transport._open
    queries, boundaries = [], []
    def paged_http(request, timeout):
        url = urlparse(request.full_url)
        if url.path.endswith('/files') and request.method == 'GET':
            query = parse_qs(url.query)
            queries.append(query)
            token = query.get('pageToken', [None])[0]
            if token is None:
                return Response(json.dumps({'files': [{'id': f'f{i}', 'name': f'item {i}'} for i in range(1000)], 'nextPageToken': 'page-2'}).encode())
            return Response(json.dumps({'files': [{'id': 'f1000', 'name': 'item 1000'}]}).encode())
        if request.method == 'POST' and request.get_header('Content-type', '').startswith('multipart/'):
            boundaries.append(request.get_header('Content-type').split('boundary=')[1])
            return Response(json.dumps({'id': 'created-id'}).encode())
        return original(request, timeout)
    try:
        monkeypatch.setattr(transport, '_open', paged_http)
        items = host._receiver().list_files("trashed = false and properties has { key='papeer' and value='edits-v1' }", 'id,name')
        assert len(items) == 1001
        assert queries[0].get('pageSize') == ['1000']
        host._receiver().create_json({'id': 'a'}, b'{}')
        host._receiver().create_json({'id': 'b'}, b'{}')
        assert len(boundaries) == 2 and boundaries[0] != boundaries[1]
        assert boundaries[0] != 'papeer_provider_multipart'
    finally:
        host.close()


def test_reconnect_saved_preserves_and_uses_dpapi_after_release_until_explicit_disconnect(http, monkeypatch):
    http['files']['descriptor'] = {'metadata': http['metadata']('descriptor'), 'bytes': b'{}'}
    connected_flag = [True]
    monkeypatch.setattr(auth, 'status', lambda: {'connected': connected_flag[0], 'connecting': False, 'auth_error': None})
    def clear_dpapi():
        connected_flag[0] = False
        auth._generation = 'disconnected-generation'
    monkeypatch.setattr(auth, 'disconnect', clear_dpapi)

    host = create_google_drive_provider_host()
    try:
        principal = host.reconnect_saved()
        host.assert_current(principal)
        assert host.list() == [{'id': 'descriptor', 'title': 'Human Library 日本語'}]

        host.release_and_wait()
        assert connected_flag[0] is True
        with pytest.raises(ValueError):
            host.assert_current(principal)

        reconnected = host.reconnect_saved()
        host.assert_current(reconnected)
        assert reconnected['digest'] == principal['digest']

        host.disconnect_and_wait()
        assert connected_flag[0] is False
        with pytest.raises(ValueError, match='drive-saved-credentials-missing'):
            host.reconnect_saved()
    finally:
        host.close()


def test_write_tolerates_post_upload_version_and_checksum_and_capture_descriptor_reads_once(http, monkeypatch):
    host, principal = connected()
    scope, raw = sample_descriptor()
    digest = hashlib.sha256(raw).hexdigest()
    manifest_bytes = canonical_json({}).encode('utf8')
    manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()
    counts = {'desc': 0, 'man': 0}
    tamper = [False]
    original_open = transport._open

    def bumped_http(request, timeout):
        response = original_open(request, timeout)
        url = urlparse(request.full_url)
        query = parse_qs(url.query)
        if request.method == 'GET' and query.get('alt') != ['media']:
            file_id = url.path.rsplit('/', 1)[1]
            if file_id == 'desc-async':
                counts['desc'] += 1
                meta = json.loads(response.read().decode())
                if counts['desc'] == 1:
                    meta.pop('sha256Checksum', None)
                    meta['version'] = '1'
                else:
                    meta['version'] = '2'
                    meta['sha256Checksum'] = ('0' * 64) if tamper[0] else digest
                return Response(json.dumps(meta).encode())
            if file_id == 'man-async':
                counts['man'] += 1
                meta = json.loads(response.read().decode())
                if counts['man'] == 1:
                    meta.pop('sha256Checksum', None)
                    meta['version'] = '1'
                else:
                    meta['version'] = '2'
                    meta['sha256Checksum'] = manifest_digest
                return Response(json.dumps(meta).encode())
        return response

    try:
        monkeypatch.setattr(transport, '_open', bumped_http)
        written_manifest = host.write_immutable_json('man-async', 'a' * 64, 'folder', str(uuid.uuid4()), 'dataset-manifest', {})
        assert written_manifest == {'id': 'man-async', 'version': '2', 'sha256': manifest_digest}
        desc_logical_id = str(uuid.uuid4())
        written_desc = host.write_descriptor('desc-async', desc_logical_id, 'folder', 'Human Library', raw, 'a' * 64)
        assert written_desc == {'id': 'desc-async', 'version': '2', 'sha256': digest}
        summary, captured_raw = host.capture_descriptor(principal, 'desc-async')
        assert summary['version'] == '2' and summary['scope'] == scope and captured_raw == raw
        tamper[0] = True
        counts['desc'] = 0
        with pytest.raises(ValueError, match='drive-immutable-changed'):
            host.write_descriptor('desc-async', desc_logical_id, 'folder', 'Human Library', raw, 'a' * 64)
    finally:
        host.close()
