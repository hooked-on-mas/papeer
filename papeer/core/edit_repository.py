"""SQLite adapter for the finite PC/Web edit protocol.

The host injects the connection. Production uses canonical edit storage outside the
frozen legacy input. Its move/backup footprint must be handled before UI activation.
Old annotation/note tables are not dual-written; activation belongs to explicit migration.
"""
from __future__ import annotations

from copy import deepcopy
import json
import sqlite3
import hashlib
import pymupdf

from papeer.core.edit_model import EditGraph, assert_snapshot, canonical_json, reject
from papeer.core.edit_contracts import validate_resourcemetadata, validate_repositorycheckpoint, validate_page
from papeer.core.edits.resources import assert_resource_bindings, assert_resource_metadata, inspected_resource, publication_item
from papeer.core.edits.intents import assert_edit_intent, assert_intent_transition
from papeer.core.edits.records import assert_edit_record, merge_edit_record, history_status, validate_histories
from papeer.core.edits.datasets import assert_dataset_checkpoint, assert_dataset_manifest, checkpoint_hash as dataset_checkpoint_hash
from papeer.core.edits.dataset_control import (dataset_identity, dataset_access, assert_dataset_access, assert_dataset_control,
    assert_dataset_control_plan, assert_dataset_control_transition, assert_dataset_contained, copied_dataset_receipts)

class StorageIntegrityError(Exception):
    """Stored bytes/keys disagree; not a definitive rejected user operation."""

def _stored(payload, validate):
    try:
        value = json.loads(payload)
        validate(value)
        return value
    except (ValueError, TypeError, KeyError, IndexError, OverflowError) as error:
        raise StorageIntegrityError('stored-data-invalid') from error

def _check(condition):
    if not condition: raise ValueError('stored-key-mismatch')


def initialize_edit_schema(db):
    """Explicit provisioning only; caller owns an authorized write transaction."""
    db.execute("CREATE TABLE IF NOT EXISTS edit_roots (scope TEXT NOT NULL,target TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,target))")
    db.execute("CREATE TABLE IF NOT EXISTS edit_batches (scope TEXT NOT NULL,id TEXT NOT NULL,target TEXT NOT NULL,payload TEXT NOT NULL,receipt TEXT NOT NULL,history TEXT,PRIMARY KEY(scope,id))")
    db.execute("CREATE TABLE IF NOT EXISTS edit_projections (scope TEXT NOT NULL,target TEXT NOT NULL,version TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,target,version))")
    db.execute("CREATE TABLE IF NOT EXISTS edit_projection_pages (scope TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id))")
    db.execute("CREATE INDEX IF NOT EXISTS edit_batch_target ON edit_batches(scope,target)")
    db.execute("CREATE TABLE IF NOT EXISTS edit_publications (scope TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id))")
    db.execute("CREATE TABLE IF NOT EXISTS edit_resources (scope TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id))")
    db.execute("CREATE TABLE IF NOT EXISTS edit_resource_bytes (scope TEXT NOT NULL,sha256 TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(scope,sha256))")
    db.execute("CREATE TABLE IF NOT EXISTS edit_checkpoints (scope TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(scope,sha256))")
    db.execute("CREATE TABLE IF NOT EXISTS edit_intents (scope TEXT NOT NULL,target TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,target))")
    db.execute("CREATE TABLE IF NOT EXISTS edit_datasets (scope TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id))")
    db.execute("CREATE TABLE IF NOT EXISTS edit_dataset_controls (identity TEXT PRIMARY KEY,payload TEXT NOT NULL,active_epoch TEXT,staging_epoch TEXT,frozen INTEGER NOT NULL,epochs TEXT NOT NULL)")


class SqliteEditRepository:
    def __init__(self, authority, scope):
        if set(scope) != {"accountId", "libraryId", "epoch"} or any(not isinstance(value, str) or not value for value in scope.values()):
            reject("empty-scope")
        if not callable(getattr(authority, 'transaction', None)):
            reject('authority-required')
        self.authority = authority
        self.scope = deepcopy(scope)
        self.namespace = json.dumps([scope["accountId"], scope["libraryId"], scope["epoch"]], ensure_ascii=False, separators=(",", ":"))
        self.identity = json.dumps([scope["accountId"], scope["libraryId"]], ensure_ascii=False, separators=(",", ":"))

    def _transaction(self, operation):
        scope = self.scope
        if (self.namespace != canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']])
                or self.identity != canonical_json([scope['accountId'],scope['libraryId']])):
            reject('dataset-scope')
        return self.authority.transaction(operation, scope)

    def _namespace_scope(self, namespace):
        def validate(value):
            _check(isinstance(value,list) and len(value) == 3 and all(isinstance(v,str) and v for v in value))
            _check(value[:2] == [self.scope['accountId'], self.scope['libraryId']] and canonical_json(value) == namespace)
        value = _stored(namespace,validate)
        return {'accountId':value[0],'libraryId':value[1],'epoch':value[2]}

    def _stored_root(self, target, payload):
        def validate(value):
            assert_snapshot(value)
            _check(value['id'] == target and ((value['kind'] == 'library') == (target == self.scope['libraryId'])))
        return _stored(payload,validate)

    def _stored_intent(self, target, payload):
        return _stored(payload,lambda value: assert_edit_intent(value,self.scope['libraryId'],target))

    def _stored_manifest(self, namespace, manifest_id, payload):
        scope = self._namespace_scope(namespace)
        def validate(value):
            assert_dataset_manifest(value,scope)
            _check(value['id'] == manifest_id)
        return _stored(payload,validate)

    def _stored_resource(self, resource_id, payload):
        def validate(value):
            assert_resource_metadata(value)
            _check(value['id'] == resource_id)
        return _stored(payload,validate)

    def _stored_control(self, payload):
        return _stored(payload,lambda value: assert_dataset_control(value,dataset_identity(self.scope)))

    def _control(self, db):
        row = db.execute('SELECT payload,active_epoch,staging_epoch,frozen,epochs FROM edit_dataset_controls WHERE identity=?',(self.identity,)).fetchone()
        if not row: return None
        value = self._stored_control(row[0]); access = dataset_access(value)
        epochs = _stored(row[4],lambda item: _check(isinstance(item,list) and all(isinstance(v,str) and v for v in item)))
        if (row[1] != access['activeEpoch'] or row[2] != access['stagingEpoch'] or row[3] not in (0,1)
                or bool(row[3]) != access['frozen'] or epochs != access['epochs']):
            raise StorageIntegrityError('stored-data-invalid')
        return value

    def _stored_page(self, target, key, payload):
        def validate(value):
            validate_page(value)
            _check(key == ':'.join([target,value['id'],value['backgroundRevision'],value['lifecycleVersion'],value['annotationVersion']]))
        return _stored(payload,validate)

    def _stored_projection(self, db, target, version, payload):
        def validate(value):
            _check(isinstance(value,dict) and value.get('id') == target and value.get('version') == version)
            if value.get('kind') != 'document':
                assert_snapshot(value); return
            def pages(keys):
                _check(isinstance(keys,list) and all(isinstance(key,str) for key in keys))
                results = []
                for key in keys:
                    row = db.execute('SELECT payload FROM edit_projection_pages WHERE scope=? AND id=?',(self.namespace,key)).fetchone()
                    _check(row is not None)
                    results.append(self._stored_page(target,key,row[0]))
                return results
            hydrated = {**value,'pages':pages(value['pages']),'deletedPages':pages(value['deletedPages'])}
            if 'translation' in value:
                hydrated['translation'] = {**value['translation'],'pages':pages(value['translation']['pages'])}
            assert_snapshot(hydrated)
        return _stored(payload,validate)

    def _access(self, db, mode):
        value = self._control(db)
        access = dataset_access(value) if value else None
        assert_dataset_access(access, self.scope, mode)

    def dataset_control(self):
        with self._transaction('dataset-control') as db:
            record = self._control(db)
        self.authority.assert_current()
        return record

    def _scoped_state(self, db, scope):
        if dataset_identity(scope) != dataset_identity(self.scope):
            reject("dataset-scope")
        namespace = json.dumps([scope["accountId"], scope["libraryId"], scope["epoch"]], ensure_ascii=False, separators=(",", ":"))
        return {"roots": self._roots(db, namespace), "edits": self._edits(db, namespace=namespace),
                "intents": [self._stored_intent(target,payload) for target,payload in db.execute("SELECT target,payload FROM edit_intents WHERE scope=?", (namespace,))],
                "datasets": [self._stored_manifest(namespace,key,payload) for key,payload in db.execute("SELECT id,payload FROM edit_datasets WHERE scope=?", (namespace,))]}

    def replace_dataset_control(self, record, expected_id):
        record = deepcopy(record)
        assert_dataset_control_plan(record, dataset_identity(self.scope))
        with self._transaction('replace-dataset-control') as db:
            old = self._control(db)
            if old and old["id"] == record["id"]:
                if old != record:
                    reject("dataset-control-id-reused")
                if record["transition"]["phase"] not in {"prepared", "rolled-back"}:
                    self._verify_dataset_resources(db, record["transition"]["publication"]["manifest"])
                return {"status": "written"}
            if (old["id"] if old else None) != expected_id:
                return {"status": "conflict"}
            assert_dataset_control_transition(old, record)
            run = record["transition"]
            scope = run["publication"]["manifest"]["scope"]
            target = self._scoped_state(db, scope)
            source = self._scoped_state(db, run["source"]["scope"]) if run["source"] else None
            if run["phase"] != "rolled-back":
                if source:
                    assert_dataset_contained(source, run["publication"]["checkpoint"])
                assert_dataset_contained(target, run["publication"]["checkpoint"], run["phase"] != "prepared")
                if run["phase"] != "prepared" and run["publication"]["manifest"] not in target["datasets"]:
                    reject("dataset-not-installed")
                if run["phase"] != "prepared":
                    self._verify_dataset_resources(db, run["publication"]["manifest"])
            elif target["intents"] or (source and source["intents"]):
                reject("dataset-pending-intents")
            if run["phase"] == "activated" and source:
                namespace = json.dumps([scope["accountId"], scope["libraryId"], scope["epoch"]], ensure_ascii=False, separators=(",", ":"))
                for edit in copied_dataset_receipts(source, target):
                    self._put(db, edit, namespace)
            access = dataset_access(record)
            db.execute("INSERT INTO edit_dataset_controls VALUES(?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET payload=excluded.payload,active_epoch=excluded.active_epoch,staging_epoch=excluded.staging_epoch,frozen=excluded.frozen,epochs=excluded.epochs",
                       (self.identity, canonical_json(record), access["activeEpoch"], access["stagingEpoch"], int(access["frozen"]), canonical_json(access["epochs"])))
            return {"status": "written"}

    def installed_datasets(self):
        with self._transaction('datasets') as db:
            values = [self._stored_manifest(self.namespace,key,payload) for key,payload in db.execute("SELECT id,payload FROM edit_datasets WHERE scope=? ORDER BY id", (self.namespace,))]
        self.authority.assert_current()
        return values

    def install_dataset(self, manifest, checkpoint):
        manifest, checkpoint = deepcopy(manifest), deepcopy(checkpoint)
        assert_dataset_checkpoint(manifest, checkpoint, self.scope)
        with self._transaction('install-dataset') as db:
            self._access(db, 'stage')
            previous = db.execute("SELECT payload FROM edit_datasets WHERE scope=? AND id=?", (self.namespace, manifest["id"])).fetchone()
            if previous:
                if self._stored_manifest(self.namespace,manifest['id'],previous[0]) != manifest:
                    reject("dataset-id-reused")
                self._verify_dataset_resources(db, manifest)
                return
            self._verify_dataset_resources(db, manifest)
            self._install_checkpoint_in(db, checkpoint, manifest["checkpointSha256"])
            db.execute("INSERT INTO edit_datasets VALUES(?,?,?)", (self.namespace, manifest["id"], canonical_json(manifest)))

    def _verify_dataset_resources(self, db, manifest):
        scope = manifest["scope"]
        if dataset_identity(scope) != dataset_identity(self.scope):
            reject("dataset-scope")
        namespace = json.dumps([scope["accountId"], scope["libraryId"], scope["epoch"]], ensure_ascii=False, separators=(",", ":"))
        for expected in manifest["resources"]:
            row = db.execute("SELECT payload FROM edit_resources WHERE scope=? AND id=?", (namespace, expected["id"])).fetchone()
            body = db.execute("SELECT payload FROM edit_resource_bytes WHERE scope=? AND sha256=?", (namespace, expected["sha256"])).fetchone()
            if not row or self._stored_resource(expected['id'],row[0]) != expected or body is None:
                reject("dataset-resource-missing")
            if not isinstance(body[0],bytes) or len(body[0]) != expected["byteLength"] or hashlib.sha256(body[0]).hexdigest() != expected["sha256"]:
                raise StorageIntegrityError('stored-data-invalid')

    def read_intent(self, target_id):
        with self._transaction('intent') as db:
            row = db.execute("SELECT payload FROM edit_intents WHERE scope=? AND target=?", (self.namespace, target_id)).fetchone()
        record = self._stored_intent(target_id,row[0]) if row else None
        self.authority.assert_current()
        return record

    def replace_intent(self, target_id, record, expected_id):
        record = deepcopy(record)
        if record is not None:
            assert_edit_intent(record, self.scope["libraryId"], target_id)
        with self._transaction('replace-intent') as db:
            self._access(db, 'edit')
            row = db.execute("SELECT payload FROM edit_intents WHERE scope=? AND target=?", (self.namespace, target_id)).fetchone()
            old = self._stored_intent(target_id,row[0]) if row else None
            if record and old and old["id"] == record["id"]:
                if old != record:
                    reject("intent-id-reused")
                return {"status": "written"}
            if record is None and old is None:
                return {"status": "cleared"}
            if (old["id"] if old else None) != expected_id:
                return {"status": "conflict"}
            if old and record:
                assert_intent_transition(old, record)
            if record is None:
                db.execute("DELETE FROM edit_intents WHERE scope=? AND target=?", (self.namespace, target_id))
            else:
                db.execute("INSERT INTO edit_intents VALUES(?,?,?) ON CONFLICT(scope,target) DO UPDATE SET payload=excluded.payload",
                           (self.namespace, target_id, canonical_json(record)))
            return {"status": "written" if record else "cleared"}

    def pending_intents(self):
        with self._transaction('pending-intents') as db:
            rows = db.execute("SELECT target,payload FROM edit_intents WHERE scope=? ORDER BY target", (self.namespace,)).fetchall()
        pending = [{"targetId": row[0], "record": self._stored_intent(row[0],row[1])} for row in rows]
        self.authority.assert_current()
        return pending

    def _root(self, db, target_id):
        row = db.execute("SELECT payload FROM edit_roots WHERE scope=? AND target=?", (self.namespace, target_id)).fetchone()
        return self._stored_root(target_id,row[0]) if row else None

    def _roots(self, db, namespace=None):
        namespace = namespace or self.namespace; self._namespace_scope(namespace)
        return [self._stored_root(target,payload) for target,payload in db.execute("SELECT target,payload FROM edit_roots WHERE scope=? ORDER BY target", (namespace,))]

    def checkpoint(self):
        with self._transaction('checkpoint') as db:
            return {"version": 1, "libraryId": self.scope["libraryId"], "roots": self._roots(db),
                    "edits": [{key: value for key, value in edit.items() if key != "receipt"} for edit in self._edits(db)]}

    def install_checkpoint(self, checkpoint):
        validate_repositorycheckpoint(checkpoint)
        checkpoint = deepcopy(checkpoint)
        if checkpoint["libraryId"] != self.scope["libraryId"]:
            reject("batch-scope")
        checkpoint_hash = dataset_checkpoint_hash(checkpoint)
        with self._transaction('install-checkpoint') as db:
            self._access(db, 'stage')
            self._install_checkpoint_in(db, checkpoint, checkpoint_hash)

    def _install_checkpoint_in(self, db, checkpoint, checkpoint_hash):
        if db.execute("SELECT 1 FROM edit_checkpoints WHERE scope=? AND sha256=?", (self.namespace, checkpoint_hash)).fetchone():
            return
        roots = {root["id"]: root for root in self._roots(db)}
        incoming_root_ids = set()
        for root in checkpoint["roots"]:
            assert_snapshot(root)
            if root["id"] in incoming_root_ids:
                reject("checkpoint-duplicate-root")
            incoming_root_ids.add(root["id"])
            if (root["kind"] == "library") != (root["id"] == self.scope["libraryId"]):
                reject("checkpoint-library")
            if root["id"] in roots and roots[root["id"]] != root:
                reject("root-already-initialized")
            roots[root["id"]] = root
        if self.scope["libraryId"] not in roots:
            reject("checkpoint-library")
        edits = {edit["batch"]["id"]: edit for edit in self._edits(db)}
        context = {value["batch"]["id"]: value for value in checkpoint["edits"]}
        context.update(edits)
        for batch_id, old in list(edits.items()):
            if history_status(old, list(context.values()), list(roots.values())) == "invalid":
                edits[batch_id] = {key: value for key, value in old.items() if key != "history"}
        incoming_ids = set()
        for value in checkpoint["edits"]:
            assert_edit_record(value)
            batch = value["batch"]
            if batch["libraryId"] != self.scope["libraryId"]:
                reject("batch-scope")
            if batch["id"] in incoming_ids:
                reject("checkpoint-duplicate-batch")
            incoming_ids.add(batch["id"])
            old = edits.get(batch["id"])
            edits[batch["id"]] = {**merge_edit_record(old, value), "receipt": old["receipt"]} if old else {**value, "receipt": {
                "id": batch["id"], "targetId": batch["targetId"], "durable": True, "upload": "accepted", "importedBy": []}}
        for root in roots.values():
            db.execute("INSERT OR IGNORE INTO edit_roots VALUES(?,?,?)", (self.namespace, root["id"], canonical_json(root)))
        validate_histories(edits, list(roots.values()), {edit["batch"]["id"] for edit in checkpoint["edits"] if "history" in edit})
        publications = {}
        for edit in edits.values():
            if "publication" not in edit:
                continue
            item = publication_item(edit["publication"])
            if item["id"] in publications and publications[item["id"]] != edit["batch"]["id"]:
                reject("publication-item-reused")
            publications[item["id"]] = edit["batch"]["id"]
            content = edit["publication"].get("content")
            if content and roots.get(item["id"]) != content:
                reject("publication-content-exists")
            resource = self._resource(db, item["resourceId"]) if item.get("resourceId") else None
            if item["kind"] == "pdf" and (not resource or resource["mediaType"] != "application/pdf"):
                reject("publication-pdf-required")
        for root in roots.values():
            target_edits = [edit for edit in edits.values() if edit["batch"]["targetId"] == root["id"]]
            graph = EditGraph({"version": 1, "libraryId": self.scope["libraryId"], "root": root,
                               "batches": [edit["batch"] for edit in target_edits]})
            if graph.view["rejected"]:
                reject(next(iter(graph.view["rejected"].values())))
            for edit in target_edits:
                if "publication" in edit:
                    parent = graph.states.get(edit["batch"]["parents"][0])
                    item = publication_item(edit["publication"])
                    if parent and (parent["kind"] != "library" or any(value["id"] == item["id"] for value in parent["items"])):
                        reject("publication-item-exists")
            for snapshot in graph.states.values():
                self._assert_bindings(db, snapshot)
                if snapshot["version"] in [root["version"], *graph.view["heads"]]:
                    self._project(db, snapshot)
            self._prune_projections(db, root["id"], {root["version"], *graph.view["heads"]})
        for edit in edits.values():
            self._put(db, edit)
        db.execute("INSERT INTO edit_checkpoints VALUES(?,?)", (self.namespace, checkpoint_hash))

    def _edits(self, db, target_id=None, namespace=None, batch_id=None):
        namespace = namespace or self.namespace; scope = self._namespace_scope(namespace)
        orphan = db.execute('SELECT 1 FROM edit_publications p LEFT JOIN edit_batches b ON b.scope=p.scope AND b.id=p.id WHERE p.scope=? AND b.id IS NULL LIMIT 1',(namespace,)).fetchone()
        if orphan: raise StorageIntegrityError('stored-data-invalid')
        query = "SELECT id,target,payload,receipt,history,(SELECT p.payload FROM edit_publications p WHERE p.scope=edit_batches.scope AND p.id=edit_batches.id) FROM edit_batches WHERE scope=?"
        args = [namespace]
        if target_id is not None:
            query += " AND target=?"
            args.append(target_id)
        if batch_id is not None:
            query += " AND id=?"
            args.append(batch_id)
        edits = []
        for key, target, payload, receipt_payload, history_payload, publication_payload in db.execute(query + " ORDER BY id", args):
            batch = _stored(payload,lambda value: None)
            receipt = _stored(receipt_payload,lambda value: None)
            history = _stored(history_payload,lambda value: None) if history_payload is not None else None
            publication = _stored(publication_payload,lambda value: None) if publication_payload is not None else None
            record = {'batch':batch, **({'history':history} if history_payload is not None else {}), **({'publication':publication} if publication_payload is not None else {})}
            try:
                assert_edit_record(record)
                _check(batch['id'] == key and batch['targetId'] == target and batch['libraryId'] == scope['libraryId'])
                _check(isinstance(receipt,dict) and set(receipt) == {'id','targetId','durable','upload','importedBy'})
                _check(receipt['id'] == key and receipt['targetId'] == target and receipt['durable'] is True)
                _check(receipt['upload'] in ('pending','accepted') and isinstance(receipt['importedBy'],list) and all(isinstance(value,str) for value in receipt['importedBy']))
            except (ValueError,TypeError,KeyError,IndexError,OverflowError) as error:
                raise StorageIntegrityError('stored-data-invalid') from error
            edits.append({**record,'receipt':receipt})
        return edits

    def _put(self, db, edit, namespace=None):
        namespace = namespace or self.namespace
        batch = edit["batch"]
        db.execute("INSERT INTO edit_batches VALUES(?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET receipt=excluded.receipt,history=excluded.history",
                   (namespace, batch["id"], batch["targetId"], canonical_json(batch), canonical_json(edit["receipt"]),
                    canonical_json(edit["history"]) if "history" in edit else None))
        if "publication" in edit:
            db.execute("INSERT OR IGNORE INTO edit_publications VALUES(?,?,?)", (namespace, batch["id"], canonical_json(edit["publication"])))

    def _resource(self, db, resource_id):
        row = db.execute("SELECT payload FROM edit_resources WHERE scope=? AND id=?", (self.namespace, resource_id)).fetchone()
        return self._stored_resource(resource_id,row[0]) if row else None

    def _assert_bindings(self, db, snapshot):
        assert_resource_bindings(snapshot, lambda resource_id: self._resource(db, resource_id))
        if snapshot["kind"] == "library":
            for item in snapshot["items"]:
                if item["kind"] == "attachment":
                    continue
                root = self._root(db, item["id"])
                if not root or root["kind"] != ("markdown" if item["kind"] == "markdown" else "document"):
                    reject("missing-or-wrong-content")

    def store_resource(self, resource_id, sha256, media_type, data, expected=None):
        data = bytes(data)
        metadata = {"id": resource_id, "sha256": sha256, "mediaType": media_type, "byteLength": len(data)}
        validate_resourcemetadata(metadata)
        if hashlib.sha256(data).hexdigest() != sha256:
            reject("resource-hash")
        if media_type == "application/pdf":
            try:
                with pymupdf.open(stream=data, filetype="pdf") as document:
                    if document.needs_pass:
                        reject("pdf-password-required")
                    if not 0 < document.page_count <= 100000:
                        reject("pdf-page-limit")
                    metadata["pdfPages"] = [{"widthPt": page.rect.width, "heightPt": page.rect.height} for page in document]
            except pymupdf.FileDataError as exc:
                raise ValueError("invalid-pdf-resource") from exc
        metadata = inspected_resource(metadata, expected)
        with self._transaction('store-resource') as db:
            self._access(db, 'stage')
            existing = self._resource(db, resource_id)
            if existing is not None and existing != metadata:
                reject("resource-id-reused")
            saved = db.execute("SELECT payload FROM edit_resource_bytes WHERE scope=? AND sha256=?", (self.namespace,sha256)).fetchone()
            if existing is not None and saved is None:
                raise StorageIntegrityError('stored-data-invalid')
            if saved is not None and (not isinstance(saved[0],bytes) or saved[0] != data):
                raise StorageIntegrityError('stored-data-invalid')
            db.execute("INSERT OR IGNORE INTO edit_resource_bytes VALUES(?,?,?)", (self.namespace, sha256, data))
            db.execute("INSERT OR IGNORE INTO edit_resources VALUES(?,?,?)", (self.namespace, resource_id, canonical_json(metadata)))
        return metadata

    def read_resource(self, resource_id):
        with self._transaction('read-resource') as db:
            metadata = self._resource(db, resource_id)
            if metadata is None:
                return None
            row = db.execute("SELECT payload FROM edit_resource_bytes WHERE scope=? AND sha256=?", (self.namespace, metadata["sha256"])).fetchone()
            if row is None:
                raise StorageIntegrityError('stored-data-invalid')
            if not isinstance(row[0],bytes): raise StorageIntegrityError('stored-data-invalid')
            data = row[0]
        assert_resource_metadata(metadata)
        if len(data) != metadata["byteLength"] or hashlib.sha256(data).hexdigest() != metadata["sha256"]:
            raise StorageIntegrityError('stored-data-invalid')
        self.authority.assert_current()
        return {"metadata": metadata, "bytes": data}

    def resource_metadata(self, resource_id):
        with self._transaction('resource-metadata') as db:
            metadata = self._resource(db, resource_id)
        if metadata:
            assert_resource_metadata(metadata)
        self.authority.assert_current()
        return metadata

    def _project(self, db, snapshot):
        existing = db.execute("SELECT payload FROM edit_projections WHERE scope=? AND target=? AND version=?", (self.namespace,snapshot['id'],snapshot['version'])).fetchone()
        if existing is not None:
            self._stored_projection(db,snapshot['id'],snapshot['version'],existing[0])
        projection = dict(snapshot)
        if "translation" in snapshot:
            projection["translation"] = dict(snapshot["translation"])
        if snapshot["kind"] == "document":
            collections = [("pages", snapshot["pages"]), ("deletedPages", snapshot["deletedPages"])]
            if "translation" in snapshot:
                collections.append(("translation", snapshot["translation"]["pages"]))
            for field, pages in collections:
                keys = []
                for page in pages:
                    key = ":".join([snapshot["id"], page["id"], page["backgroundRevision"], page["lifecycleVersion"], page["annotationVersion"]])
                    existing = db.execute("SELECT payload FROM edit_projection_pages WHERE scope=? AND id=?", (self.namespace, key)).fetchone()
                    if existing and self._stored_page(snapshot['id'],key,existing[0]) != page:
                        reject("immutable-page-reused")
                    db.execute("INSERT OR IGNORE INTO edit_projection_pages VALUES(?,?,?)", (self.namespace, key, canonical_json(page)))
                    keys.append(key)
                if field == "translation":
                    projection["translation"]["pages"] = keys
                else:
                    projection[field] = keys
        db.execute("INSERT INTO edit_projections VALUES(?,?,?,?) ON CONFLICT(scope,target,version) DO UPDATE SET payload=excluded.payload",
                   (self.namespace, snapshot["id"], snapshot["version"], canonical_json(projection)))

    def _prune_projections(self, db, target_id, versions):
        # Projections are rebuildable caches. Keep genesis and every current branch,
        # while immutable roots/batches retain all old versions and waiting edits.
        retained_pages = set()
        for version, payload in db.execute("SELECT version,payload FROM edit_projections WHERE scope=? AND target=?", (self.namespace, target_id)).fetchall():
            snapshot = self._stored_projection(db,target_id,version,payload)
            if version not in versions:
                db.execute("DELETE FROM edit_projections WHERE scope=? AND target=? AND version=?", (self.namespace, target_id, version))
                continue
            if snapshot["kind"] == "document":
                retained_pages.update(snapshot["pages"] + snapshot["deletedPages"] + snapshot.get("translation", {}).get("pages", []))
        prefix = target_id + ":"
        for (page_id,) in db.execute("SELECT id FROM edit_projection_pages WHERE scope=? AND substr(id,1,?)=?", (self.namespace, len(prefix), prefix)).fetchall():
            if page_id not in retained_pages:
                db.execute("DELETE FROM edit_projection_pages WHERE scope=? AND id=?", (self.namespace, page_id))

    def _graph(self, db, target_id):
        root = self._root(db, target_id)
        if root is None:
            reject("missing-target")
        edits = self._edits(db, target_id)
        return EditGraph({"version": 1, "libraryId": self.scope["libraryId"], "root": root, "batches": [edit["batch"] for edit in edits]}), edits

    def initialize(self, root):
        assert_snapshot(root)
        with self._transaction('initialize') as db:
            self._access(db, 'stage')
            old = self._root(db, root["id"])
            if old is not None and old != root:
                reject("root-already-initialized")
            if old is None:
                self._install_root(db, root)

    def _install_root(self, db, root):
        self._assert_bindings(db, root)
        db.execute("INSERT INTO edit_roots VALUES(?,?,?)", (self.namespace, root["id"], canonical_json(root)))
        self._project(db, root)
        waiting = self._edits(db, root["id"])
        if waiting:
            records = {edit["batch"]["id"]: edit for edit in waiting}
            validate_histories(records, [root], set())
            for record in records.values():
                self._put(db, record)
            graph = EditGraph({"version": 1, "libraryId": self.scope["libraryId"], "root": root, "batches": [edit["batch"] for edit in waiting]})
            for snapshot in graph.states.values():
                self._assert_bindings(db, snapshot)
                if snapshot["version"] in [root["version"], *graph.view["heads"]]:
                    self._project(db, snapshot)
            self._prune_projections(db, root["id"], {root["version"], *graph.view["heads"]})

    def read(self, target_id):
        with self._transaction('read') as db:
            graph, edits = self._graph(db, target_id)
            return {**graph.view, "checkpoint": graph.checkpoint(), "receipts": [edit["receipt"] for edit in edits],
                    "publicationOrigins": [{"batchId": edit["batch"]["id"], "itemId": change["item"]["id"],
                                            "kind": change["item"]["kind"], "contentVersion": edit["publication"].get("content", {}).get("version")}
                                           for edit in edits if "publication" in edit
                                           for change in edit["publication"]["libraryBatch"]["changes"] if change["type"] == "put-item"],
                    "history": [edit["history"] for edit in edits if "history" in edit and history_status(edit, edits, [graph.root]) != "invalid"]}

    def _commit_in(self, db, batch, history=None, publication=None):
        matches = self._edits(db,batch_id=batch['id'])
        existing = matches[0] if matches else None
        if existing:
            if existing['batch'] != batch:
                reject("batch-id-reused")
            if history is not None and existing.get('history') != history:
                reject("history-id-reused")
            return {"status": "durable", "receipt": existing['receipt']}
        graph, edits = self._graph(db, batch["targetId"])
        if history and history_status({"batch": batch, "history": history}, edits, [graph.root]) == "invalid":
            reject("history-action-order")
        graph.assert_local(batch)
        graph.receive([batch])
        projection = graph.states.get(batch["id"])
        if projection is None:
            reject(graph.view["rejected"].get(batch["id"], "unresolved-batch"))
        self._assert_bindings(db, projection)
        receipt = {"id": batch["id"], "targetId": batch["targetId"], "durable": True, "upload": "pending", "importedBy": []}
        self._put(db, {"batch": batch, "receipt": receipt, **({"history": history} if history else {}), **({"publication": publication} if publication else {})})
        self._project(db, projection)
        self._prune_projections(db, batch["targetId"], {graph.root["version"], *graph.view["heads"]})
        return {"status": "durable", "receipt": receipt}

    def publish(self, publication, history=None):
        try:
            item = publication_item(publication)
            batch = publication["libraryBatch"]
            if batch["libraryId"] != self.scope["libraryId"]:
                reject("batch-scope")
            assert_edit_record({"batch": batch, "publication": publication, **({"history": history} if history is not None else {})})
            with self._transaction('publish') as db:
                self._access(db, 'edit')
                edits = self._edits(db)
                old = next((edit for edit in edits if edit["batch"]["id"] == batch["id"]), None)
                if old:
                    if old.get("publication") != publication:
                        reject("publication-id-reused")
                    if history is not None and old.get("history") != history:
                        reject("history-id-reused")
                    return {"status": "durable", "receipt": old["receipt"]}
                if any("publication" in edit and publication_item(edit["publication"])["id"] == item["id"] for edit in edits):
                    reject("publication-item-reused")
                graph, _ = self._graph(db, batch["targetId"])
                parent = graph.states.get(batch["parents"][0])
                if not parent or parent["kind"] != "library" or any(value["id"] == item["id"] for value in parent["items"]):
                    reject("publication-item-exists")
                if self._root(db, item["id"]) is not None:
                    reject("publication-content-exists")
                resource = self._resource(db, item["resourceId"]) if item.get("resourceId") else None
                if item["kind"] == "pdf" and (not resource or resource["mediaType"] != "application/pdf"):
                    reject("publication-pdf-required")
                if publication.get("content"):
                    root = publication["content"]
                    self._install_root(db, root)
                return self._commit_in(db, batch, history, publication)
        except (ValueError, sqlite3.Error) as exc:
            return {"status": "aborted", "reason": str(exc)}

    def commit(self, batch, history=None):
        try:
            assert_edit_record({"batch": batch, **({"history": history} if history is not None else {})})
            if batch["libraryId"] != self.scope["libraryId"]:
                reject("batch-scope")
            with self._transaction('commit') as db:
                self._access(db, 'edit')
                return self._commit_in(db, batch, history)
        except (ValueError, sqlite3.Error) as exc:
            # The context manager rolled the native transaction back. HTTP response loss is classified by the client.
            return {"status": "aborted", "reason": str(exc)}

    def receive(self, batches):
        return self.receive_records([{"batch": batch} for batch in batches])

    def receive_publications(self, publications, batches=None):
        return self.receive_records([{"batch": publication["libraryBatch"], "publication": publication} for publication in publications]
                                    + [{"batch": batch} for batch in (batches or [])])

    def receive_records(self, records):
        records = deepcopy(records)
        for record in records:
            assert_edit_record(record)
            if record["batch"]["libraryId"] != self.scope["libraryId"]:
                reject("batch-scope")
        publications = [record["publication"] for record in records if "publication" in record]
        batches = [record["batch"] for record in records]
        with self._transaction('receive-records') as db:
            self._access(db, 'edit')
            existing = self._edits(db)
            original = {edit["batch"]["id"]: edit for edit in existing}
            ids = dict(original)
            existing_ids = set(ids)
            published_ids = {publication_item(edit["publication"])["id"]: edit["batch"]["id"] for edit in existing if "publication" in edit}
            for publication in publications:
                batch = publication["libraryBatch"]
                item = publication_item(publication)
                old = ids.get(batch["id"])
                if old and old.get("publication") != publication:
                    reject("publication-id-reused")
                if item["id"] in published_ids and published_ids[item["id"]] != batch["id"]:
                    reject("publication-item-reused")
                published_ids[item["id"]] = batch["id"]
                root = self._root(db, item["id"])
                if root and (not old or not old.get("publication") or root != publication.get("content")):
                    reject("publication-content-exists")
                resource = self._resource(db, item["resourceId"]) if item.get("resourceId") else None
                if item["kind"] == "pdf" and (not resource or resource["mediaType"] != "application/pdf"):
                    reject("publication-pdf-required")
                if publication.get("content") and root is None:
                    content = publication["content"]
                    self._install_root(db, content)
                if not old:
                    ids[batch["id"]] = {"batch": batch, "publication": publication,
                                         "receipt": {"id": batch["id"], "targetId": batch["targetId"], "durable": True, "upload": "accepted", "importedBy": []}}
            for batch in batches:
                old = ids.get(batch["id"])
                if old and old["batch"] != batch:
                    reject("batch-id-reused")
                if not old:
                    ids[batch["id"]] = {"batch": batch, "receipt": {"id": batch["id"], "targetId": batch["targetId"], "durable": True, "upload": "accepted", "importedBy": []}}
            for record in records:
                old = ids[record["batch"]["id"]]
                if history_status(old, list(ids.values()), self._roots(db)) == "invalid":
                    old = {key: value for key, value in old.items() if key != "history"}
                ids[record["batch"]["id"]] = {**merge_edit_record(old, record), "receipt": old["receipt"]}
            validate_histories(ids, self._roots(db), {record["batch"]["id"] for record in records if "history" in record})
            targets = {batch["targetId"] for batch in batches} | {value["content"]["id"] for value in publications if value.get("content")}
            for target in targets:
                root = self._root(db, target)
                if root is None:
                    if target == self.scope["libraryId"]:
                        reject("missing-target")
                    continue  # Listed before its creation/checkpoint; durable private parent-waiting data.
                graph = EditGraph({"version": 1, "libraryId": self.scope["libraryId"], "root": root,
                                   "batches": [edit["batch"] for edit in ids.values() if edit["batch"]["targetId"] == target]})
                for batch_id, reason in graph.view["rejected"].items():
                    if batch_id not in existing_ids:
                        reject(reason)
                for edit in ids.values():
                    if "publication" in edit and edit["batch"]["targetId"] == target:
                        parent = graph.states.get(edit["batch"]["parents"][0])
                        item = publication_item(edit["publication"])
                        if parent and (parent["kind"] != "library" or any(value["id"] == item["id"] for value in parent["items"])):
                            reject("publication-item-exists")
                for snapshot in graph.states.values():
                    self._assert_bindings(db, snapshot)
                    if snapshot["version"] in [root["version"], *graph.view["heads"]]:
                        self._project(db, snapshot)
                self._prune_projections(db, target, {root["version"], *graph.view["heads"]})
            for batch_id, edit in ids.items():
                if original.get(batch_id) is not edit:
                    self._put(db, edit)

    def receipt(self, batch_id):
        with self._transaction('receipt') as db:
            rows = self._edits(db,batch_id=batch_id)
            return rows[0]['receipt'] if rows else None

    def pending(self):
        with self._transaction('pending') as db:
            return [edit["batch"] for edit in self._edits(db) if edit["receipt"]["upload"] == "pending"]

    def pending_records(self):
        with self._transaction('pending-records') as db:
            return [{key: value for key, value in edit.items() if key != "receipt"}
                    for edit in self._edits(db) if edit["receipt"]["upload"] == "pending"]

    def pending_publications(self):
        with self._transaction('pending-publications') as db:
            return [edit["publication"] for edit in self._edits(db) if edit["receipt"]["upload"] == "pending" and "publication" in edit]

    def acknowledge(self, batch_id, peer_id=None):
        with self._transaction('acknowledge-upload') as db:
            self._access(db, "stage" if peer_id is not None else "edit")
            edit = next((edit for edit in self._edits(db) if edit["batch"]["id"] == batch_id), None)
            if not edit:
                reject("unknown-receipt")
            if peer_id is None:
                edit["receipt"]["upload"] = "accepted"
            elif peer_id not in edit["receipt"]["importedBy"]:
                edit["receipt"]["importedBy"].append(peer_id)
            self._put(db, edit)
