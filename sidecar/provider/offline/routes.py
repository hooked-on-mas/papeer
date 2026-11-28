"""Narrow authenticated offline facade; selectors and principals never come from requests."""
from fastapi import APIRouter, Depends, Header
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sidecar import canonical_host
from .service import NativeOfflineService
from .crypto import VaultInvalid
from sidecar.canonical_host import AuthorityError

class SecretSafeRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()
        async def sanitized(request):
            try: return await original(request)
            except RequestValidationError:
                # Pydantic details can include the original body/secret. Never
                # return or log those details, even for extra keys/wrong types.
                return JSONResponse(status_code=422, content={'detail': 'offline-request-invalid'}, headers={'Cache-Control': 'no-store'})
        return sanitized

router = APIRouter(prefix='/offline', route_class=SecretSafeRoute)
_service = None

def invoke(operation, *args):
    try: return operation(*args)
    except (VaultInvalid, KeyError, TypeError, ValueError):
        raise AuthorityError('offline-unlock-failed') from None

def service():
    global _service
    with canonical_host.authority._lock:
        if _service is None or _service.registry is not canonical_host.authority:
            _service = NativeOfflineService(canonical_host.authority)
        return _service

class Empty(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

class Secret(Empty):
    secret: str = Field(min_length=12, max_length=1024)

class Enroll(Secret):
    requestId: str

class Selection(Empty):
    unlockSession: str = Field(min_length=1, max_length=256)
    handle: str = Field(min_length=1, max_length=256)

def context(authorization: str | None = Header(None), x_papeer_host_lease: str | None = Header(None)):
    return authorization, x_papeer_host_lease

@router.post('/enroll')
def enroll(body: Enroll, auth=Depends(context), x_papeer_admission: str | None = Header(None)):
    return invoke(service().enroll, *auth, x_papeer_admission, body.secret, body.requestId)

@router.post('/query')
def query(body: Enroll, auth=Depends(context), x_papeer_admission: str | None = Header(None)):
    return invoke(service().query, *auth, x_papeer_admission, body.secret, body.requestId)

@router.post('/unlock')
def unlock(body: Secret, auth=Depends(context)):
    return invoke(service().unlock, *auth, body.secret)

@router.post('/open')
def open_library(body: Selection, auth=Depends(context)):
    return invoke(service().open, *auth, body.unlockSession, body.handle)

@router.post('/revoke')
def revoke(body: Selection, auth=Depends(context)):
    return invoke(service().revoke, *auth, body.unlockSession, body.handle)

@router.post('/lock')
def lock(_body: Empty, auth=Depends(context)):
    return invoke(service().lock, *auth)


@router.post('/recover-enrollment')
def recover_enrollment(body: Secret, auth=Depends(context), x_papeer_admission: str | None = Header(None)):
    return invoke(service().recover_enrollment, *auth, x_papeer_admission, body.secret)


@router.post('/revoke-enrollment')
def revoke_enrollment(body: Secret, auth=Depends(context), x_papeer_admission: str | None = Header(None)):
    return invoke(service().revoke_enrollment, *auth, x_papeer_admission, body.secret)
