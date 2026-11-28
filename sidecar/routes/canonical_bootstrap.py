"""Native owner bootstrap routes; IDs select server-owned capabilities only."""
from uuid import uuid4
from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, ConfigDict
from papeer.core.bootstrap.canonical_initialization_sqlite import SqliteCanonicalInitialization
from papeer.core.bootstrap.canonical_local_grant_sqlite import discover_local_grant
from sidecar import deps
from sidecar.canonical_host import authority, _bearer, _require_clear, AuthorityError

router = APIRouter(prefix='/api/edits/bootstrap', dependencies=[Depends(deps.verify_token)])
store = SqliteCanonicalInitialization()

class Empty(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

class RequestId(Empty):
    requestId: str

class FixedRequest(Empty):
    request: dict

class Handle(Empty):
    handleId: str

class Release(Empty):
    admissionId: str | None = None

def owner(authorization: str | None = Header(None), x_papeer_host_lease: str | None = Header(None)):
    return authorization, x_papeer_host_lease, authority.bind_initialization(authorization, x_papeer_host_lease)

@router.post('/local-context/read')
def read_context(body: Empty, authorization: str | None = Header(None)):
    _bearer(authorization); _require_clear()
    state = discover_local_grant(deps.get_canonical_storage_path())
    if state['status'] != 'ready': return state
    try: return {'status':'ready','leaseId':authority.issue(authorization)}
    except AuthorityError as error:
        if str(error) == 'setup-required': return {'status':'setup-required','reason':'schema-upgrade'}
        raise

@router.post('/local-context/provision')
def provision_context(body: Empty, authorization: str | None = Header(None)):
    return {'status':'ready','leaseId':authority.provision(authorization)}

@router.post('/discover')
def discover(body: Empty, context=Depends(owner)):
    authorization, lease_id, _ = context
    return authority.discover(authorization,lease_id)

@router.post('/peer')
def peer(body: Empty, context=Depends(owner)):
    return store.get_or_create_peer(context[2],str(uuid4()))

@router.post('/initialization/prepare')
def prepare(body: FixedRequest, context=Depends(owner)):
    return store.prepare(context[2],body.request)

@router.post('/initialization/query')
def query(body: RequestId, context=Depends(owner)):
    return store.query(context[2],body.requestId)

@router.post('/initialization/execute')
def execute(body: RequestId, context=Depends(owner)):
    return store.execute(context[2],body.requestId)

@router.post('/initialization/acknowledge')
def acknowledge(body: RequestId, context=Depends(owner)):
    store.acknowledge(context[2],body.requestId); return {'status':'acknowledged'}

@router.post('/inspect')
def inspect(body: Handle, context=Depends(owner)):
    return authority.inspect_handle(context[0],context[1],body.handleId)

@router.post('/revalidate')
def revalidate(body: Empty, context=Depends(owner), x_papeer_admission: str | None = Header(None)):
    return authority.revalidate(context[0],context[1],x_papeer_admission)

@router.post('/release')
def release(body: Release, context=Depends(owner)):
    authority.release(context[0],context[1],body.admissionId); return {'status':'released'}
