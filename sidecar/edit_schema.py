"""Publish the canonical edit wire schema in OpenAPI without coercing/stripping its payloads."""
from papeer.core.edit_contracts import contract_definitions


def add_edit_schemas(schema):
    components = schema["components"]["schemas"]

    def refs(value):
        if isinstance(value, list):
            return [refs(item) for item in value]
        if isinstance(value, dict):
            return {key: "#/components/schemas/Shared" + item.rsplit("/", 1)[1] if key == "$ref" else refs(item)
                    for key, item in value.items()}
        return value

    for name, definition in contract_definitions().items():
        components["Shared" + name] = refs(definition)

    def ref(name):
        return {"$ref": "#/components/schemas/Shared" + name}

    fields = {
        "initialize": {"root": ref("Snapshot")},
        "commit": {"batch": ref("EditBatch"), "history": {"anyOf": [ref("HistoryRecord"), {"type": "null"}]}},
        "publish": {"publication": ref("ContentPublication"), "history": {"anyOf": [ref("HistoryRecord"), {"type": "null"}]}},
        "receive": {"batches": {"type": "array", "maxItems": 1000, "items": ref("EditBatch")}},
        "receive-publications": {"batches": {"type": "array", "maxItems": 1000, "items": ref("EditBatch")},
                                 "publications": {"type": "array", "maxItems": 1000, "items": ref("ContentPublication")}},
        "receive-records": {"records": {"type": "array", "items": ref("EditRecord")}},
        "store-resource": {"expected": {"anyOf": [ref("ResourceMetadata"), {"type": "null"}]}},
        "install-checkpoint": {"checkpoint": ref("RepositoryCheckpoint")},
        "install-dataset": {"manifest": ref("DatasetManifest"), "checkpoint": ref("RepositoryCheckpoint")},
        "replace-dataset-control": {"record": ref("DatasetControlRecord"), "expectedId": {"anyOf": [ref("Id"), {"type": "null"}]}},
        "replace-intent": {"record": {"anyOf": [ref("EditIntentRecord"), {"type": "null"}]},
                           "expectedId": {"anyOf": [ref("Id"), {"type": "null"}]}},
        "drive/read-resource": {"metadata": ref("ResourceMetadata")},
        "drive/save-resource": {"metadata": ref("ResourceMetadata")},
        "legacy-backup/inventory": {"id": ref("Id")},
        "legacy-backup/load": {"id": ref("Id")},
        "legacy-backup/plan": {"id": ref("Id")},
        "legacy-backup/capture": {"plan": ref("LegacyBackupPlan")},
        "legacy-backup/assert-current": {"plan": ref("LegacyBackupPlan")},
        "legacy-backup/object": {"id": ref("Id"), "entry": ref("LegacyBackupEntry")},
        "backup-artifacts/prepare": {"source": ref("LegacyBackupSource"), "plan": ref("LegacyBackupPlan")},
        "backup-artifacts/put-object": {"source": ref("LegacyBackupSource"), "entry": ref("LegacyBackupEntry")},
        "backup-artifacts/publish": {"source": ref("LegacyBackupSource"), "manifest": ref("LegacyBackupManifest")},
        "backup-artifacts/plan": {"source": ref("LegacyBackupSource"), "id": ref("Id")},
        "backup-artifacts/reference": {"source": ref("LegacyBackupSource"), "id": ref("Id")},
        "backup-artifacts/manifest": {"source": ref("LegacyBackupSource"), "id": ref("Id")},
        "backup-artifacts/object": {"source": ref("LegacyBackupSource"), "entry": ref("LegacyBackupEntry")},
        "legacy-startup/hold": {"hold": ref("LegacyMigrationHold")},
        "legacy-inputs/prepare": {"inputSet": ref("LegacyMigrationInputSet")},
        "legacy-inputs/read": {"runId": ref("Id")},
    }
    for path, properties in fields.items():
        operation = schema["paths"]["/api/edits/" + path]["post"]
        model_ref = operation["requestBody"]["content"]["application/json"]["schema"]["$ref"]
        components[model_ref.rsplit("/", 1)[1]]["properties"].update(properties)
    for path, payload in {
        "checkpoint": ref("RepositoryCheckpoint"),
        "datasets": {"type": "array", "items": ref("DatasetManifest")},
        "dataset-control": {"anyOf": [ref("DatasetControlRecord"), {"type": "null"}]},
        "replace-dataset-control": {"type": "object", "properties": {"status": {"enum": ["written", "conflict"]}}, "required": ["status"], "additionalProperties": False},
        "store-resource": ref("ResourceMetadata"),
        "resource-metadata": {"anyOf": [ref("ResourceMetadata"), {"type": "null"}]},
        "read-resource": {"anyOf": [{"type": "object", "properties": {"metadata": ref("ResourceMetadata"), "dataBase64": {"type": "string"}},
                                     "required": ["metadata", "dataBase64"], "additionalProperties": False}, {"type": "null"}]},
        "pending": {"type": "array", "items": ref("EditBatch")},
        "pending-publications": {"type": "array", "items": ref("ContentPublication")},
        "pending-records": {"type": "array", "items": ref("EditRecord")},
        "intent": {"anyOf": [ref("EditIntentRecord"), {"type": "null"}]},
        "pending-intents": {"type": "array", "items": {"type": "object", "properties": {"targetId": ref("Id"), "record": ref("EditIntentRecord")},
                             "required": ["targetId", "record"], "additionalProperties": False}},
        "replace-intent": {"type": "object", "properties": {"status": {"enum": ["written", "cleared", "conflict"]}}, "required": ["status"], "additionalProperties": False},
        "legacy-backup/inventory": ref("LegacyBackupPlan"),
        "legacy-backup/capture": ref("LegacyBackupManifest"),
        "legacy-backup/load": {"anyOf": [ref("LegacyBackupManifest"), {"type": "null"}]},
        "legacy-backup/plan": {"anyOf": [ref("LegacyBackupPlan"), {"type": "null"}]},
        "legacy-backup/assert-current": {"type": "object", "properties": {"status": {"const": "unchanged"}}, "required": ["status"], "additionalProperties": False},
        "legacy-backup/object": {"type": "object", "properties": {"dataBase64": {"type": "string"}}, "required": ["dataBase64"], "additionalProperties": False},
        "backup-artifacts/plan": {"anyOf": [ref("LegacyBackupPlan"), {"type": "null"}]},
        "backup-artifacts/reference": {"anyOf": [ref("LegacyBackupManifest"), {"type": "null"}]},
        "backup-artifacts/manifest": {"anyOf": [ref("LegacyBackupManifest"), {"type": "null"}]},
        "backup-artifacts/object": {"type": "object", "properties": {"dataBase64": {"type": "string"}}, "required": ["dataBase64"], "additionalProperties": False},
        "legacy-startup/read": {"anyOf": [ref("LegacyMigrationHold"), {"type": "null"}]},
        "legacy-startup/hold": ref("LegacyMigrationHold"),
        "legacy-inputs/read": {"anyOf": [ref("LegacyMigrationInputSet"), {"type": "null"}]},
        "legacy-inputs/prepare": {"type": "object", "properties": {"status": {"const": "prepared"}}, "required": ["status"], "additionalProperties": False},
    }.items():
        schema["paths"]["/api/edits/" + path]["post"]["responses"]["200"]["content"]["application/json"]["schema"] = payload
