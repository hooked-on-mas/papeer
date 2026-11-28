"""Authenticated I/O for shared edit repositories. No UI or operation semantics here."""
import base64
from typing import Literal
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from papeer.core.edit_repository import SqliteEditRepository
from papeer.core.edit_drive import DriveEditStorage
from papeer.core.migrations.legacy_backup import NativeLegacyBackup, FileLegacyBackupStore
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_contracts import validate_legacybackupsource
from papeer.core.migrations.legacy_drive import LegacyDriveRead
from papeer.core.migrations.legacy_device import NativeLegacyDeviceBackup
from papeer.core.migrations.legacy_startup import NativeLegacyStartup
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.edit_storage import edit_storage_root
from sidecar import deps
from sidecar.canonical_host import authority

router = APIRouter(prefix="/api/edits", dependencies=[Depends(deps.verify_token)])


class Scope(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    accountId: str = Field(min_length=1, max_length=200)
    libraryId: str = Field(pattern=r"^[0-9a-f-]{36}$")
    epoch: str = Field(min_length=1, max_length=200)


class LegacyBackupIdRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    area: Literal["legacy", "canonical", "device"] = "legacy"


class LegacyBackupPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    plan: dict
    area: Literal["legacy", "canonical", "device"] = "legacy"


class LegacyBackupObjectRequest(LegacyBackupIdRequest):
    entry: dict


class BackupArtifactSourceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source: dict


class BackupArtifactIdRequest(BackupArtifactSourceRequest):
    id: str


class BackupArtifactPlanRequest(BackupArtifactSourceRequest):
    plan: dict


class BackupArtifactManifestRequest(BackupArtifactSourceRequest):
    manifest: dict


class BackupArtifactEntryRequest(BackupArtifactSourceRequest):
    entry: dict


class BackupArtifactPutRequest(BackupArtifactEntryRequest):
    dataBase64: str


class LegacyDriveAccountRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class LegacyStartupHoldRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    hold: dict


class LegacyInputsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    inputSet: dict


class LegacyInputsReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    runId: str


class LegacyDriveIdRequest(LegacyDriveAccountRequest):
    fileId: str = Field(pattern=r"^[A-Za-z0-9_-]+$", min_length=1, max_length=200)


class LegacyDriveLibraryFilesRequest(LegacyDriveAccountRequest):
    libraryId: str = Field(pattern=r"^[A-Za-z0-9_-]+$", min_length=1, max_length=200)
    kind: Literal["ink-v1", "notes-v1", "note-blob-v1"]


class ReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Scope
    targetId: str


class InitializeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Scope
    root: dict


class CheckpointRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Scope
    checkpoint: dict


class DatasetRequest(CheckpointRequest):
    manifest: dict


class DatasetControlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Scope
    record: dict
    expectedId: str | None


class IntentRequest(ReadRequest):
    record: dict | None
    expectedId: str | None


class CommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Scope
    batch: dict
    history: dict | None = None


class PublishRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Scope
    publication: dict
    history: dict | None = None


class ResourceReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Scope
    resourceId: str


class ResourceWriteRequest(ResourceReadRequest):
    sha256: str
    mediaType: str
    dataBase64: str
    expected: dict | None = None


class ReceiveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Scope
    batches: list[dict] = Field(max_length=1000)


class ReceivePublicationsRequest(ReceiveRequest):
    publications: list[dict] = Field(max_length=1000)


class ReceiveRecordsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Scope
    records: list[dict]


class ReceiptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Scope
    batchId: str
    peerId: str | None = None


class DriveLeaseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: Scope
    folderId: str = Field(pattern=r"^[A-Za-z0-9_-]+$", max_length=200)


class DriveRequest(DriveLeaseRequest):
    leaseId: str = Field(min_length=1, max_length=200)


class DriveReadRequest(DriveRequest):
    fileId: str = Field(pattern=r"^[A-Za-z0-9_-]+$", max_length=200)


class DriveWriteRequest(DriveRequest):
    editId: str = Field(pattern=r"^[0-9a-f-]{36,73}$")
    value: dict


class DriveResourceRequest(DriveRequest):
    metadata: dict


class DriveResourceReadRequest(DriveResourceRequest):
    blobId: str = Field(pattern=r"^[A-Za-z0-9_-]+$", max_length=200)


class DriveResourceWriteRequest(DriveResourceRequest):
    dataBase64: str


def drive_storage(body: DriveRequest):
    return DriveEditStorage(body.scope.model_dump(), body.folderId, lease_id=body.leaseId)


def canonical_access(authorization: str | None = Header(None), x_papeer_host_lease: str | None = Header(None), x_papeer_admission: str | None = Header(None)):
    return authority.bind_repository(authorization, x_papeer_host_lease, x_papeer_admission)


def repository(scope, access):
    return SqliteEditRepository(access, scope.model_dump())


def _reject_drive():
    raise HTTPException(403, 'provider-unconfigured')


def _deny_owner_operation():
    raise HTTPException(403, 'operation-denied')


@router.post("/initialize", dependencies=[Depends(_deny_owner_operation)])
def initialize(body: InitializeRequest, access=Depends(canonical_access)):
    try:
        repository(body.scope, access).initialize(body.root)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"status": "initialized"}


@router.post("/read")
def read(body: ReadRequest, access=Depends(canonical_access)):
    try:
        return repository(body.scope, access).read(body.targetId)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/commit")
def commit(body: CommitRequest, access=Depends(canonical_access)):
    return repository(body.scope, access).commit(body.batch, body.history)


@router.post("/publish")
def publish(body: PublishRequest, access=Depends(canonical_access)):
    return repository(body.scope, access).publish(body.publication, body.history)


@router.post("/store-resource")
def store_resource(body: ResourceWriteRequest, access=Depends(canonical_access)):
    try:
        data = base64.b64decode(body.dataBase64, validate=True)
        return repository(body.scope, access).store_resource(body.resourceId, body.sha256, body.mediaType, data, body.expected)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/read-resource")
def read_resource(body: ResourceReadRequest, access=Depends(canonical_access)):
    try:
        resource = repository(body.scope, access).read_resource(body.resourceId)
        return {"metadata": resource["metadata"], "dataBase64": base64.b64encode(resource["bytes"]).decode("ascii")} if resource else None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/resource-metadata")
def resource_metadata(body: ResourceReadRequest, access=Depends(canonical_access)):
    try:
        return repository(body.scope, access).resource_metadata(body.resourceId)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/receive", dependencies=[Depends(_deny_owner_operation)])
def receive(body: ReceiveRequest, access=Depends(canonical_access)):
    try:
        repository(body.scope, access).receive(body.batches)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"status": "received"}


@router.post("/receipt")
def receipt(body: ReceiptRequest, access=Depends(canonical_access)):
    return repository(body.scope, access).receipt(body.batchId)


@router.post("/receive-publications", dependencies=[Depends(_deny_owner_operation)])
def receive_publications(body: ReceivePublicationsRequest, access=Depends(canonical_access)):
    try:
        repository(body.scope, access).receive_publications(body.publications, body.batches)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"status": "received"}


@router.post("/pending")
def pending(body: Scope, access=Depends(canonical_access)):
    return repository(body, access).pending()


@router.post("/pending-publications")
def pending_publications(body: Scope, access=Depends(canonical_access)):
    return repository(body, access).pending_publications()


@router.post("/acknowledge-upload", dependencies=[Depends(_deny_owner_operation)])
def acknowledge_upload(body: ReceiptRequest, access=Depends(canonical_access)):
    repository(body.scope, access).acknowledge(body.batchId)
    return {"status": "acknowledged"}


@router.post("/acknowledge-import", dependencies=[Depends(_deny_owner_operation)])
def acknowledge_import(body: ReceiptRequest, access=Depends(canonical_access)):
    if not body.peerId:
        raise HTTPException(422, "peerId is required")
    repository(body.scope, access).acknowledge(body.batchId, body.peerId)
    return {"status": "acknowledged"}


@router.post("/drive/lease", dependencies=[Depends(_reject_drive)])
def drive_lease(body: DriveLeaseRequest):
    storage = DriveEditStorage(body.scope.model_dump(), body.folderId)
    return {"leaseId": storage.drive.lease_id}


@router.post("/drive/files", dependencies=[Depends(_reject_drive)])
def drive_files(body: DriveRequest):
    return drive_storage(body).files()


@router.post("/drive/check-lease", dependencies=[Depends(_reject_drive)])
def drive_check_lease(body: DriveRequest):
    drive_storage(body).drive.assert_current()
    return {"status": "current"}


@router.post("/drive/read-json", dependencies=[Depends(_reject_drive)])
def drive_read_json(body: DriveReadRequest):
    return drive_storage(body).read_json(body.fileId)


@router.post("/drive/save-json", dependencies=[Depends(_reject_drive)])
def drive_save_json(body: DriveWriteRequest):
    drive_storage(body).upload_json(body.editId, body.value)
    return {"status": "uploaded"}


@router.post("/drive/read-resource", dependencies=[Depends(_reject_drive)])
def drive_read_resource(body: DriveResourceReadRequest):
    data = drive_storage(body).read_resource(body.metadata, body.blobId)
    return {"dataBase64": base64.b64encode(data).decode("ascii")}


@router.post("/drive/save-resource", dependencies=[Depends(_reject_drive)])
def drive_save_resource(body: DriveResourceWriteRequest):
    drive_storage(body).save_resource(body.metadata, base64.b64decode(body.dataBase64, validate=True))
    return {"status": "uploaded"}


@router.post("/checkpoint")
def checkpoint(body: Scope, access=Depends(canonical_access)):
    return repository(body, access).checkpoint()


@router.post("/datasets")
def datasets(body: Scope, access=Depends(canonical_access)):
    return repository(body, access).installed_datasets()


@router.post("/dataset-control")
def dataset_control(body: Scope, access=Depends(canonical_access)):
    return repository(body, access).dataset_control()


@router.post("/replace-dataset-control", dependencies=[Depends(_deny_owner_operation)])
def replace_dataset_control(body: DatasetControlRequest, access=Depends(canonical_access)):
    try:
        return repository(body.scope, access).replace_dataset_control(body.record, body.expectedId)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/install-dataset", dependencies=[Depends(_deny_owner_operation)])
def install_dataset(body: DatasetRequest, access=Depends(canonical_access)):
    try:
        repository(body.scope, access).install_dataset(body.manifest, body.checkpoint)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"status": "installed"}


@router.post("/install-checkpoint", dependencies=[Depends(_deny_owner_operation)])
def install_checkpoint(body: CheckpointRequest, access=Depends(canonical_access)):
    try:
        repository(body.scope, access).install_checkpoint(body.checkpoint)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"status": "installed"}


@router.post("/intent")
def read_intent(body: ReadRequest, access=Depends(canonical_access)):
    try:
        return repository(body.scope, access).read_intent(body.targetId)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/replace-intent")
def replace_intent(body: IntentRequest, access=Depends(canonical_access)):
    try:
        return repository(body.scope, access).replace_intent(body.targetId, body.record, body.expectedId)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/pending-intents")
def pending_intents(body: Scope, access=Depends(canonical_access)):
    try:
        return repository(body, access).pending_intents()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/receive-records", dependencies=[Depends(_deny_owner_operation)])
def receive_records(body: ReceiveRecordsRequest, access=Depends(canonical_access)):
    try:
        repository(body.scope, access).receive_records(body.records)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"status": "received"}


@router.post("/pending-records")
def pending_records(body: Scope, access=Depends(canonical_access)):
    return repository(body, access).pending_records()


def legacy_backup(area="legacy"):
    # Opening Library would run recovery/schema updates on the very input being preserved.
    root = deps.get_data_dir()
    if area == "device":
        return NativeLegacyDeviceBackup(root)
    return NativeLegacyBackup(edit_storage_root(root) if area == "canonical" else root)


def backup_io(action):
    try:
        return action()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, "backup-storage: " + str(exc)) from exc


@router.post("/legacy-backup/inventory")
def legacy_backup_inventory(body: LegacyBackupIdRequest):
    return backup_io(lambda: legacy_backup(body.area).inventory(body.id))


@router.post("/legacy-backup/capture")
def legacy_backup_capture(body: LegacyBackupPlanRequest):
    return backup_io(lambda: legacy_backup(body.area).capture(body.plan))


@router.post("/legacy-backup/load")
def legacy_backup_load(body: LegacyBackupIdRequest):
    return backup_io(lambda: legacy_backup(body.area).load(body.id))


@router.post("/legacy-backup/plan")
def legacy_backup_plan(body: LegacyBackupIdRequest):
    return backup_io(lambda: legacy_backup(body.area).plan(body.id))


@router.post("/legacy-backup/assert-current")
def legacy_backup_current(body: LegacyBackupPlanRequest):
    backup_io(lambda: legacy_backup(body.area).assert_current(body.plan))
    return {"status": "unchanged"}


@router.post("/legacy-backup/object")
def legacy_backup_object(body: LegacyBackupObjectRequest):
    data = backup_io(lambda: legacy_backup(body.area).object(body.id, body.entry))
    return {"dataBase64": base64.b64encode(data).decode("ascii")}


def backup_artifacts(source):
    validate_legacybackupsource(source)
    root = legacy_backup().root / "sources" / edit_content_hash(source)
    return FileLegacyBackupStore(root, source)


@router.post("/backup-artifacts/prepare")
def backup_artifact_prepare(body: BackupArtifactPlanRequest):
    backup_io(lambda: backup_artifacts(body.source).prepare(body.plan))
    return {"status": "prepared"}


@router.post("/backup-artifacts/put-object")
def backup_artifact_put(body: BackupArtifactPutRequest):
    backup_io(lambda: backup_artifacts(body.source).put_object(body.entry, base64.b64decode(body.dataBase64, validate=True)))
    return {"status": "stored"}


@router.post("/backup-artifacts/publish")
def backup_artifact_publish(body: BackupArtifactManifestRequest):
    backup_io(lambda: backup_artifacts(body.source).publish(body.manifest))
    return {"status": "published"}


@router.post("/backup-artifacts/plan")
def backup_artifact_plan(body: BackupArtifactIdRequest):
    return backup_io(lambda: backup_artifacts(body.source).plan(body.id))


@router.post("/backup-artifacts/reference")
def backup_artifact_reference(body: BackupArtifactIdRequest):
    return backup_io(lambda: backup_artifacts(body.source).reference(body.id))


@router.post("/backup-artifacts/manifest")
def backup_artifact_manifest(body: BackupArtifactIdRequest):
    return backup_io(lambda: backup_artifacts(body.source).manifest(body.id))


@router.post("/backup-artifacts/object")
def backup_artifact_object(body: BackupArtifactEntryRequest):
    data = backup_io(lambda: backup_artifacts(body.source).object(body.entry))
    return {"dataBase64": base64.b64encode(data).decode("ascii")}


def legacy_drive_storage():
    return LegacyDriveRead()


@router.post("/legacy-drive/account")
def legacy_drive_account(body: LegacyDriveAccountRequest):
    return backup_io(lambda: legacy_drive_storage().account())


@router.post("/legacy-drive/metadata")
def legacy_drive_metadata(body: LegacyDriveIdRequest):
    return backup_io(lambda: legacy_drive_storage().metadata(body.fileId))


@router.post("/legacy-drive/children")
def legacy_drive_children(body: LegacyDriveIdRequest):
    return backup_io(lambda: legacy_drive_storage().children(body.fileId))


@router.post("/legacy-drive/library-files")
def legacy_drive_library_files(body: LegacyDriveLibraryFilesRequest):
    return backup_io(lambda: legacy_drive_storage().library_files(body.libraryId, body.kind))


@router.post("/legacy-drive/read")
def legacy_drive_read(body: LegacyDriveIdRequest):
    data = backup_io(lambda: legacy_drive_storage().read(body.fileId))
    return {"dataBase64": base64.b64encode(data).decode("ascii")}


@router.post("/legacy-startup/read")
def legacy_startup_read(body: LegacyDriveAccountRequest):
    return backup_io(lambda: NativeLegacyStartup(deps.get_data_dir()).read())


@router.post("/legacy-startup/presence", response_model=Literal['clear', 'legacy-present'])
def legacy_startup_presence(body: LegacyDriveAccountRequest):
    return backup_io(deps.read_native_startup_presence)


@router.post("/legacy-startup/hold")
def legacy_startup_hold(body: LegacyStartupHoldRequest):
    return backup_io(lambda: authority.save_legacy_hold(body.hold))


@router.post("/legacy-inputs/prepare")
def legacy_inputs_prepare(body: LegacyInputsRequest):
    backup_io(lambda: NativeLegacyInputs(deps.get_data_dir()).prepare(body.inputSet))
    return {"status": "prepared"}


@router.post("/legacy-inputs/read")
def legacy_inputs_read(body: LegacyInputsReadRequest):
    return backup_io(lambda: NativeLegacyInputs(deps.get_data_dir()).read(body.runId))
