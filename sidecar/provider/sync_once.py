"""One finite host-private replication pass using the existing SQLite repository."""
from papeer.core.edits.datasets import snapshot_resources
from papeer.core.edits.records import assert_edit_record
from papeer.core.edits.resources import publication_item
from papeer.core.edit_model import canonical_json
import hashlib


def _resource_ids(record):
    assert_edit_record(record)
    batch = record['batch']; ids = set()
    if batch['kind'] == 'resolution': ids.update(snapshot_resources(batch['snapshot']))
    elif batch['kind'] == 'markdown': ids.update(image['resourceId'] for image in batch['imageResources'])
    elif batch['kind'] == 'document':
        for change in batch['changes']:
            pages = change['translation']['pages'] if change['type'] == 'translation' and change['translation'] else ([change['page']] if change['type'] in {'insert', 'replace'} else [])
            ids.update(page['background']['resourceId'] for page in pages if page['background']['kind'] == 'pdf')
    elif batch['kind'] == 'library':
        ids.update(change['item']['resourceId'] for change in batch['changes'] if change['type'] == 'put-item' and 'resourceId' in change['item'])
    if 'publication' in record:
        publication = record['publication']; item = publication_item(publication)
        if 'resourceId' in item: ids.add(item['resourceId'])
        if 'content' in publication: ids.update(snapshot_resources(publication['content']))
    return sorted(ids)


def sync_once(owner, repository, storage, peer_id, cancelled, transfer_ids):
    """I/O and SQLite stay host-owned; uncertain upload is never acknowledged."""
    def check():
        if cancelled(): raise ValueError('provider-sync-suspended')
        owner.assert_current()
    check(); owner.assert_admitted(); incoming = storage.pull(); owner.verify_fresh(); check()
    for metadata in incoming['resources']:
        existing = repository.resource_metadata(metadata['id'])
        if existing is not None:
            if existing != metadata: raise ValueError('resource-id-reused')
            continue
        stored = storage.download_resource(metadata); owner.verify_fresh(); check()
        if stored['metadata'] != metadata: raise ValueError('resource-descriptor-changed')
        repository.store_resource(metadata['id'], metadata['sha256'], metadata['mediaType'], stored['bytes'], metadata)
    check(); repository.receive_records(incoming['edits'])
    accepted_edits, accepted_imports = [], []
    for batch_id in dict.fromkeys(record['batch']['id'] for record in incoming['edits']):
        check(); receipt = repository.receipt(batch_id)
        if receipt and peer_id not in receipt['importedBy']:
            logical_id = batch_id + '-' + peer_id
            envelope = {'kind': 'import-receipt', 'batchId': batch_id, 'peerId': peer_id}
            digest = hashlib.sha256(canonical_json(envelope).encode('utf8')).hexdigest()
            physical_id = transfer_ids.ensure('receipt', logical_id, digest, 1)[0]
            storage.upload_json(logical_id, envelope, provider_file_id=physical_id)
            owner.verify_fresh(); check(); repository.acknowledge(batch_id, peer_id)
        if receipt and receipt.get('durable') is True: accepted_edits.append(batch_id)
    for receipt in incoming['imports']:
        check()
        local = repository.receipt(receipt['batchId'])
        if local and receipt['peerId'] not in local['importedBy']:
            repository.acknowledge(receipt['batchId'], receipt['peerId'])
        if local: accepted_imports.append((receipt['batchId'], receipt['peerId']))
    check(); storage.acknowledge_pull(incoming, accepted_edits, accepted_imports, [value['id'] for value in incoming['resources']])
    records = sorted(repository.pending_records(), key=lambda record: 'publication' not in record)
    uploaded = set()
    for record in records:
        check()
        for resource_id in _resource_ids(record):
            if resource_id in uploaded: continue
            resource = repository.read_resource(resource_id)
            if resource is None: raise ValueError('missing-resource')
            digest = hashlib.sha256(canonical_json(resource['metadata']).encode('utf8')).hexdigest()
            blob_id, descriptor_id = transfer_ids.ensure('resource', resource_id, digest, 2)
            storage.save_resource(resource['metadata'], resource['bytes'], retained_blob_id=blob_id, retained_descriptor_id=descriptor_id)
            owner.verify_fresh(); check(); uploaded.add(resource_id)
        envelope = {'kind': 'edit-record', 'record': record}
        digest = hashlib.sha256(canonical_json(envelope).encode('utf8')).hexdigest()
        physical_id = transfer_ids.ensure('record', record['batch']['id'], digest, 1)[0]
        storage.upload_json(record['batch']['id'], envelope, provider_file_id=physical_id)
        owner.verify_fresh(); check(); repository.acknowledge(record['batch']['id'])
    owner.verify_fresh(); check()
