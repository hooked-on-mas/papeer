"""Narrow Native provider owner routes. No records, scopes or credentials from the renderer."""
import threading
import time
from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, ConfigDict
from sidecar import deps
from sidecar.provider.hub import create_native_provider_hub
from sidecar.canonical_host import AuthorityError

router = APIRouter(prefix='/api/edits/provider-owner', dependencies=[Depends(deps.verify_token)])
_lock = threading.RLock()
_hub = None
_shutdown = False
_closing = None


class _ShutdownHandle:
    """Shared result for one hub, including begin, drain and host close.

    A timed-out drain can be retried. An exception is sticky: a later caller
    must never mistake an unknown outcome for successful shutdown.
    """
    def __init__(self, hub):
        self._hub = hub
        self._begin_lock = threading.Lock()
        self._begin_started = False
        self._begun = threading.Event()
        self._failed = False
        self._finish_lock = threading.Lock()
        self.host_closed = False

    def begin(self):
        with self._begin_lock:
            if self._begin_started:
                return
            self._begin_started = True
        try:
            self._hub.begin_shutdown()
        except Exception:  # noqa: BLE001 - outcome is unknown and remains failed
            self._failed = True
        finally:
            self._begun.set()

    def finish_shutdown(self, timeout, *, close_host=True):
        deadline = time.monotonic() + max(0, timeout)
        if not self._begun.wait(max(0, deadline - time.monotonic())):
            return False
        if not self._finish_lock.acquire(timeout=max(0, deadline - time.monotonic())):
            return False
        try:
            if self._failed:
                return False
            if self.host_closed:
                return True
            try:
                done = self._hub.finish_shutdown(max(0, deadline - time.monotonic()), close_host=close_host)
            except Exception:  # noqa: BLE001 - retain unknown outcome for all callers
                self._failed = True
                return False
            if done and close_host:
                self.host_closed = True
            return done
        finally:
            self._finish_lock.release()


def hub():
    global _hub
    with _lock:
        if _shutdown: raise AuthorityError('provider-host-shutting-down')
        if _hub is None: _hub = create_native_provider_hub()
        return _hub


def start_lifetime():
    global _shutdown, _closing
    with _lock:
        # A new app lifespan cannot discard an old active, timed-out or failed
        # owner. The old host must have completed close before re-opening.
        if _closing is not None and not _closing.host_closed:
            raise RuntimeError('provider-previous-close-incomplete')
        _closing = None
        _shutdown = False


def close_if_created():
    """Close the shared retiring hub, even if another caller started shutdown."""
    current = stop_if_created()
    if current is not None and not current.finish_shutdown(5): raise RuntimeError('provider-close-incomplete')


def stop_if_created():
    """Signal cancellation once; all callers share the same drain handle."""
    global _hub, _shutdown, _closing
    with _lock:
        _shutdown = True
        if _closing is None and _hub is not None:
            _closing, _hub = _ShutdownHandle(_hub), None
        current = _closing
    if current is not None: current.begin()
    return current


class Empty(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Request(Empty):
    requestId: str


class Attempt(Empty):
    attemptId: str


class Resume(Request):
    attemptId: str


class Create(Request):
    title: str


class Selection(Empty):
    handleId: str


class Join(Request):
    handleId: str


class Replication(Empty):
    replicationId: str


def owner(authorization: str | None = Header(None), x_papeer_host_lease: str | None = Header(None),
          x_papeer_provider_operation: str | None = Header(None)):
    return authorization, x_papeer_host_lease, x_papeer_provider_operation


@router.post('/preload')
def preload(_body: Empty):
    return hub().preload()


@router.post('/connect')
def connect(body: Attempt, authorization: str | None = Header(None)):
    return hub().connect(authorization, body.attemptId)


@router.post('/finish-connect')
def finish_connect(body: Attempt, authorization: str | None = Header(None)):
    return hub().finish_connect(authorization, body.attemptId)


@router.post('/status')
def status(body: Attempt, authorization: str | None = Header(None)):
    return hub().status(authorization, body.attemptId)


@router.post('/reconnect-saved')
def reconnect_saved(_body: Empty, authorization: str | None = Header(None)):
    return hub().reconnect_saved(authorization)


@router.post('/cancel-connect')
def cancel_connect(body: Attempt, authorization: str | None = Header(None)):
    return hub().cancel_connect(authorization, body.attemptId)



@router.post('/disconnect')
def disconnect(_body: Empty, context=Depends(owner)):
    hub().disconnect(*context)
    return {'status': 'disconnected'}


@router.post('/release')
def release(_body: Empty, context=Depends(owner)):
    hub().release(*context)
    return {'status': 'released'}


@router.post('/resume-retained')
def resume_retained(body: Resume, context: tuple[str | None, str | None, str | None] = Depends(owner)):
    return hub().resume_retained(*context, body.requestId, body.attemptId)


@router.post('/cancel-resume')
def cancel_resume(body: Attempt, context: tuple[str | None, str | None, str | None] = Depends(owner)):
    return hub().cancel_resume(*context, body.attemptId)


@router.post('/acknowledge-resume')
def acknowledge_resume(body: Attempt, context: tuple[str | None, str | None, str | None] = Depends(owner)):
    return hub().acknowledge_resume(*context, body.attemptId)


@router.post('/discard-resumed')
def discard_resumed(_body: Empty, context=Depends(owner)):
    hub().discard_resumed(*context)
    return {'status': 'discarded'}


@router.post('/list')
def list_libraries(_body: Empty, context=Depends(owner)):
    return hub().list(*context)


@router.post('/health')
def health(_body: Empty, context=Depends(owner)):
    return hub().health(*context)


@router.post('/create/prepare')
def prepare_create(body: Create, context=Depends(owner)):
    authorization, lease, operation = context
    return hub()._create.prepare(operation, authorization, lease, body.title, body.requestId)


@router.post('/query')
def query(body: Request, context=Depends(owner)):
    authorization, lease, operation = context
    return hub()._create.query(operation, authorization, lease, body.requestId)


@router.post('/join/prepare')
def prepare_join(body: Join, context=Depends(owner)):
    authorization, lease, operation = context
    return hub().prepare_join(authorization, lease, operation, body.handleId, body.requestId)


@router.post('/execute')
def execute(body: Request, context=Depends(owner)):
    authorization, lease, operation = context
    return hub().execute(authorization, lease, operation, body.requestId)


@router.post('/recoveries')
def recoveries(_body: Empty, context=Depends(owner)):
    authorization, lease, operation = context
    return hub()._create.recoveries(operation, authorization, lease)


@router.post('/acknowledge')
def acknowledge(body: Request, context=Depends(owner)):
    authorization, lease, operation = context
    hub()._create.acknowledge(operation, authorization, lease, body.requestId)
    return {'status': 'acknowledged'}


@router.post('/open-installed')
def open_installed(body: Request, context=Depends(owner)):
    authorization, lease, operation = context
    return hub()._create.open_installed(operation, authorization, lease, body.requestId)


@router.post('/open-selected')
def open_selected(body: Selection, context=Depends(owner)):
    authorization, lease, operation = context
    selection = hub().resolve_selection(authorization, lease, operation, body.handleId)
    return hub()._create.open_selected(operation, authorization, lease, selection)


@router.post('/replication/open')
def open_replication(_body: Empty, context=Depends(owner), x_papeer_admission: str | None = Header(None)):
    authorization, lease, operation = context
    return hub().open_replication(authorization, lease, operation, x_papeer_admission)


@router.post('/replication/status')
def replication_status(body: Replication, context=Depends(owner)):
    authorization, lease, operation = context
    return hub().replication(authorization, lease, operation, body.replicationId).snapshot()


@router.post('/replication/flush')
def replication_flush(body: Replication, context=Depends(owner)):
    authorization, lease, operation = context
    replication = hub().replication(authorization, lease, operation, body.replicationId)
    replication.flush(); return replication.snapshot()


@router.post('/replication/suspend')
def replication_suspend(body: Replication, context=Depends(owner)):
    authorization, lease, operation = context
    replication = hub().replication_for_cancel(authorization, lease, operation, body.replicationId)
    replication.suspend_and_wait(); return replication.snapshot()


@router.post('/replication/resume')
def replication_resume(body: Replication, context=Depends(owner)):
    authorization, lease, operation = context
    replication = hub().replication(authorization, lease, operation, body.replicationId)
    replication.resume(); return replication.snapshot()

from sidecar.provider.offline.routes import router as offline_router
router.include_router(offline_router)
