"""Isolated process component fixture; production Native routes, authority and disk SQLite.

No CoreTestAuthority, direct storage seed, route override, network server or Native UI.
The fixture deliberately retains a journal after a durable route response and models
that reply as lost; it does not claim an actual HTTP transport failure or crash.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import uuid


def identity():
    return str(uuid.uuid4())


def plain(value):
    return json.loads(json.dumps(value))


def raw_database(path):
    """Physical oracle opens only the existing owned DB, in SQLite read-only mode."""
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        actual = Path(db.execute('PRAGMA database_list').fetchone()[2]).resolve()
        assert actual == path and actual.is_file()
        schema = db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
        rows = {name: db.execute('SELECT * FROM "' + name.replace('"', '""') + '" ORDER BY rowid').fetchall()
            for name, _ in schema}
        return plain({'schema': schema, 'rows': rows})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'recover', 'confirm'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--previous', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    owned = args.root.resolve()
    assert owned.name == 'native-library-resolution-cold' and owned.is_dir()
    assert args.output.resolve().parent == owned / 'proof'
    assert os.environ['PAPEER_DATA_DIR'] == str(owned / 'legacy')
    assert Path(os.environ['LOCALAPPDATA']).resolve() == owned / 'device'
    assert os.environ.get('PAPEER_TOKEN') and not os.environ.get('PAPEER_DEV_NO_AUTH')
    if args.previous:
        assert args.previous.resolve().parent == owned / 'proof'
    previous = json.loads(args.previous.read_bytes()) if args.previous else None

    # Import only after the parent supplied isolated production paths and real configured bearer.
    from fastapi.testclient import TestClient
    from papeer.core.edits.datasets import checkpoint_hash
    from papeer.core.edit_model import EditGraph
    from sidecar import deps
    from sidecar.app import app

    path = deps.get_canonical_storage_path().resolve()
    assert path == owned / '.legacy-shared-app' / 'content.sqlite3'
    assert path.is_relative_to(owned) and not path.is_symlink() and not path.parent.is_symlink()
    assert not path.is_junction() and not path.parent.is_junction()
    auth = {'Authorization': 'Bearer ' + os.environ['PAPEER_TOKEN']}
    bootstrap = '/api/edits/bootstrap'
    with TestClient(app) as client:
        def post(route, body, headers):
            response = client.post(route, json=body, headers=headers)
            assert response.status_code == 200, (route, response.status_code, response.text)
            assert response.headers['cache-control'] == 'no-store'
            return response.json()

        if args.phase == 'prepare':
            assert previous is None and not path.exists()
            assert post(bootstrap + '/local-context/read', {}, auth) == {'status': 'setup-required', 'reason': 'absent'}
            lease = post(bootstrap + '/local-context/provision', {}, auth)['leaseId']
            headers = {**auth, 'X-Papeer-Host-Lease': lease}
            peer = post(bootstrap + '/peer', {}, headers)
            library, epoch, root_version, request_id, manifest_id = [identity() for _ in range(5)]
            scope = {'accountId': peer['accountId'], 'libraryId': library, 'epoch': epoch}
            root = {'kind': 'library', 'id': library, 'version': root_version, 'items': [], 'folders': [], 'links': [], 'deletions': []}
            checkpoint = {'version': 1, 'libraryId': library, 'roots': [root], 'edits': []}
            manifest = {'version': 1, 'id': manifest_id, 'scope': scope, 'checkpointSha256': checkpoint_hash(checkpoint), 'resources': []}
            request = {'expectedPeerId': peer['peerId'],
                'profile': {'version': 1, 'revision': identity(), 'identity': {key: scope[key] for key in ('accountId', 'libraryId')}, 'title': 'SQLite cold resolution', 'remote': None},
                'control': {'version': 1, 'id': request_id, 'identity': {key: scope[key] for key in ('accountId', 'libraryId')}, 'epochs': [epoch], 'active': manifest,
                    'transition': {'id': request_id, 'mode': 'initialize', 'source': None, 'phase': 'activated',
                        'publication': {'manifest': manifest, 'checkpoint': checkpoint, 'checkpointObjectId': identity()}}}}
            assert post(bootstrap + '/initialization/prepare', {'request': request}, headers) == {'status': 'pending'}
            assert post(bootstrap + '/initialization/execute', {'requestId': request_id}, headers)['status'] == 'accepted'
            assert post(bootstrap + '/initialization/acknowledge', {'requestId': request_id}, headers) == {'status': 'acknowledged'}
        else:
            assert previous and previous['phase'] == ('prepare' if args.phase == 'recover' else 'recover')
            assert path.is_file() and str(path) == previous['sqlitePath']
            scope = previous['scope']
            # A new interpreter owns a new NativeAuthority registry. Old capabilities must fail.
            before_denied = raw_database(path)
            old_headers = {**auth, **previous['capabilities']}
            assert client.post('/api/edits/read', json={'scope': scope, 'targetId': scope['libraryId']}, headers=old_headers).status_code == 403
            assert raw_database(path) == before_denied
            context = post(bootstrap + '/local-context/read', {}, auth)
            assert context['status'] == 'ready'
            lease = context['leaseId']
            assert lease != previous['capabilities']['X-Papeer-Host-Lease']
            headers = {**auth, 'X-Papeer-Host-Lease': lease}

        listing = post(bootstrap + '/discover', {}, headers)['libraries']
        assert len(listing) == 1 and listing[0]['status'] == 'available'
        admitted = post(bootstrap + '/inspect', {'handleId': listing[0]['handleId']}, headers)
        assert admitted['scope'] == scope
        headers['X-Papeer-Admission'] = admitted['admissionId']

        def edit(route, body=None):
            return post('/api/edits/' + route, scope if body is None else {'scope': scope, **body}, headers)

        def selected(version=None):
            read = edit('read', {'targetId': scope['libraryId']})
            head = version if version else read['heads'][0]
            return plain(EditGraph(read['checkpoint']).states[head]), read

        def commit(changes, parent):
            batch = {'kind': 'library', 'id': identity(), 'libraryId': scope['libraryId'], 'targetId': scope['libraryId'], 'parents': [parent], 'changes': changes}
            result = edit('commit', {'batch': batch})
            assert result['status'] == 'durable'
            return batch

        if args.phase == 'prepare':
            published = []
            for title, metadata in [('Reserved template', {'papeer.note-template': 'v1'}), ('Deleted memo', {})]:
                before, _ = selected()
                item = {'id': identity(), 'kind': 'markdown', 'title': title, 'ownerId': None, 'folderId': None,
                    'position': len(before['items']), 'tags': [], 'read': False, 'metadata': metadata}
                content = {'kind': 'markdown', 'id': item['id'], 'version': identity(), 'content': 'Template body' if metadata else 'Deleted body', 'appendIds': [], 'imageResources': []}
                batch = {'kind': 'library', 'id': identity(), 'libraryId': scope['libraryId'], 'targetId': scope['libraryId'],
                    'parents': [before['version']], 'changes': [{'type': 'put-item', 'item': item}]}
                assert edit('publish', {'publication': {'libraryBatch': batch, 'content': content}})['status'] == 'durable'
                published.append({'item': item, 'content': content})
            template, memo = published
            before, _ = selected()
            deletion = {'id': identity(), 'itemIds': [memo['item']['id']],
                'observed': [{'targetId': memo['item']['id'], 'heads': [memo['content']['version']]}], 'active': True}
            commit([{'type': 'put-deletion', 'deletion': deletion}], before['version'])
            base, _ = selected()
            folder = lambda title: {'type': 'put-folder', 'folder': {'id': identity(), 'title': title, 'parentId': None, 'position': 0}}
            a = commit([folder('Selected local branch')], base['version'])
            b = commit([folder('Other local branch'), {'type': 'put-item', 'item': {**template['item'], 'title': 'Other template', 'metadata': {**template['item']['metadata'], 'source': 'other'}}},
                {'type': 'put-deletion', 'deletion': {**deletion, 'active': False}}], base['version'])
            chosen, read = selected(a['id'])
            other, _ = selected(b['id'])
            assert set(read['heads']) == {a['id'], b['id']}
            assert chosen['items'] != other['items'] and chosen['deletions'] != other['deletions']
            resolution_id = identity()
            resolution = {'kind': 'resolution', 'id': resolution_id, 'libraryId': scope['libraryId'], 'targetId': scope['libraryId'],
                'parents': read['heads'], 'snapshot': {**chosen, 'version': resolution_id}}
            initial_intent = {'id': identity(), 'intent': {'request': {'batch': resolution}, 'dispatched': False, 'undoRequested': False}}
            assert edit('replace-intent', {'targetId': scope['libraryId'], 'record': initial_intent, 'expectedId': None}) == {'status': 'written'}
            intent = {'id': identity(), 'intent': {**initial_intent['intent'], 'dispatched': True}}
            assert edit('replace-intent', {'targetId': scope['libraryId'], 'record': intent, 'expectedId': initial_intent['id']}) == {'status': 'written'}
            durable = edit('commit', {'batch': resolution})
            assert durable['status'] == 'durable'
            assert edit('receipt', {'batchId': resolution_id}) == durable['receipt']
            assert durable['receipt']['durable'] is True
            assert edit('intent', {'targetId': scope['libraryId']}) == intent
            # Model loss at the component caller only after the actual route response and physical receipt.
            modeled_delivery = {'status': 'unknown', 'reason': 'fixture discarded actual durable response after commit'}
            expected = {'chosen': chosen, 'resolution': resolution, 'intent': intent, 'receipt': durable['receipt'],
                'templateId': template['item']['id'], 'deletedId': memo['item']['id'], 'modeledDelivery': modeled_delivery}
            raw_before = None
        else:
            expected = previous['expected']
            raw_before = raw_database(path)
            assert raw_before == previous['rawAfter']
            resolution = expected['resolution']
            if args.phase == 'recover':
                assert edit('intent', {'targetId': scope['libraryId']}) == expected['intent']
                assert edit('pending-intents') == [{'targetId': scope['libraryId'], 'record': expected['intent']}]
                # Replay the full recovered request, not a regenerated operation or a receipt-only shortcut.
                replayed = deepcopy(edit('intent', {'targetId': scope['libraryId']})['intent']['request']['batch'])
                assert replayed == resolution
                assert edit('commit', {'batch': replayed}) == {'status': 'durable', 'receipt': expected['receipt']}
                assert raw_database(path) == raw_before
                assert edit('replace-intent', {'targetId': scope['libraryId'], 'record': None, 'expectedId': identity()}) == {'status': 'conflict'}
                assert raw_database(path) == raw_before
                assert edit('replace-intent', {'targetId': scope['libraryId'], 'record': None, 'expectedId': expected['intent']['id']}) == {'status': 'cleared'}
            assert edit('intent', {'targetId': scope['libraryId']}) is None
            assert edit('pending-intents') == []

        after, read = selected()
        assert read['heads'] == [expected['resolution']['id']]
        assert after == {**expected['chosen'], 'version': expected['resolution']['id']}
        assert next(item for item in after['items'] if item['id'] == expected['templateId'])['metadata'] == {'papeer.note-template': 'v1'}
        assert next(record for record in after['deletions'] if expected['deletedId'] in record['itemIds'])['active'] is True
        assert edit('receipt', {'batchId': expected['resolution']['id']}) == expected['receipt']
        resolution_batches = [batch for batch in read['checkpoint']['batches'] if batch['kind'] == 'resolution']
        assert resolution_batches == [expected['resolution']]
        raw_after = raw_database(path)
        namespace = json.dumps([scope['accountId'], scope['libraryId'], scope['epoch']], separators=(',', ':'))
        physical_resolution = [row for row in raw_after['rows']['edit_batches'] if row[0] == namespace and row[1] == expected['resolution']['id']]
        assert len(physical_resolution) == 1
        assert json.loads(physical_resolution[0][3]) == expected['resolution']
        assert json.loads(physical_resolution[0][4]) == expected['receipt']
        physical_projection = [row for row in raw_after['rows']['edit_projections'] if row[:3] == [namespace, scope['libraryId'], expected['resolution']['id']]]
        assert len(physical_projection) == 1 and json.loads(physical_projection[0][3]) == after
        physical_intents = raw_after['rows']['edit_intents']
        if args.phase == 'prepare':
            assert physical_intents == [[namespace, scope['libraryId'], json.dumps(expected['intent'], sort_keys=True, separators=(',', ':'), ensure_ascii=False)]]
        elif args.phase == 'recover':
            expected_raw = deepcopy(raw_before)
            expected_raw['rows']['edit_intents'] = []
            assert raw_after == expected_raw  # All tables/receipts/projections unchanged except exact CAS journal clear.
        else:
            assert raw_after == raw_before

        # Preserve production authorization: no privileged route is enabled to set up or recover this fixture.
        privileged = {
            'initialize': {'root': {}}, 'receive': {'batches': []}, 'receive-publications': {'publications': [], 'batches': []},
            'receive-records': {'records': []}, 'acknowledge-upload': {'batchId': expected['resolution']['id']},
            'acknowledge-import': {'batchId': expected['resolution']['id'], 'peerId': identity()},
            'replace-dataset-control': {'record': {}, 'expectedId': None}, 'install-dataset': {'manifest': {}, 'checkpoint': {}},
            'install-checkpoint': {'checkpoint': {}}}
        denied = {}
        for route, payload in privileged.items():
            response = client.post('/api/edits/' + route, json={'scope': scope, **payload}, headers=headers)
            assert response.status_code == 403
            assert raw_database(path) == raw_after
            denied[route] = 403
        body = {'scope': scope, 'targetId': scope['libraryId']}
        for label, denied_headers in [('missing-capability', auth), ('forged-admission', {**headers, 'X-Papeer-Admission': 'forged'})]:
            assert client.post('/api/edits/read', json=body, headers=denied_headers).status_code == 403
            assert raw_database(path) == raw_after
            denied[label] = 403
        assert client.post('/api/edits/read', json={**body, 'scope': {**scope, 'epoch': 'other'}}, headers=headers).status_code == 403
        assert raw_database(path) == raw_after
        denied['wrong-scope'] = 403
        evidence = {'phase': args.phase, 'ownPid': os.getpid(), 'generation': identity(), 'sqlitePath': str(path), 'scope': scope,
            'capabilities': {key: headers[key] for key in ('X-Papeer-Host-Lease', 'X-Papeer-Admission')},
            'expected': expected, 'selected': after, 'read': read, 'rawBefore': raw_before, 'rawAfter': raw_after, 'denied': denied,
            'scopeQualification': 'production-route/NativeAuthority disk SQLite component only; modeled reply loss and normal worker-process exit, no frontend registry, transport failure, Native UI or power-loss claim'}
    with args.output.open('xb') as stream: stream.write((json.dumps(evidence, indent=2) + '\n').encode('utf8'))
    print(json.dumps({'phase': args.phase, 'ownPid': evidence['ownPid'], 'resolutionId': expected['resolution']['id'],
        'proofSha256': hashlib.sha256(args.output.read_bytes()).hexdigest(), 'denied403Count': len(evidence['denied'])}), flush=True)


if __name__ == '__main__':
    main()
