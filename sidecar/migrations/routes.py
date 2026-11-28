"""Current-selection maintenance management; bearer never certifies writer stop."""
import asyncio
import json
import re
import threading
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sidecar import deps
# Static imports so that the PyInstaller bundle always collects the preview modules.
from . import notebook_preview, preparation, preview_gate
from .census import CoverageUnresolved

router = APIRouter(prefix='/api/edits/legacy-maintenance', dependencies=[Depends(deps.verify_token)])


async def _empty(request):
    try: body = await request.json()
    except (ValueError, UnicodeError): raise HTTPException(422, 'maintenance-invalid-request') from None
    if type(body) is not dict or body:
        raise HTTPException(422, 'maintenance-invalid-request')


@router.post('/start', status_code=202)
async def start(request: Request):
    await _empty(request)
    try: result = await asyncio.to_thread(preparation.start)
    except (OSError, ValueError) as error:
        reason = str(error) if isinstance(error, CoverageUnresolved) else 'maintenance-selection-unavailable'
        return JSONResponse(status_code=409, content={'state': 'blocked', 'reason': reason}, headers={'Cache-Control': 'no-store'})
    return JSONResponse(status_code=202, content=result, headers={'Cache-Control': 'no-store'})


@router.post('/status')
async def status(request: Request):
    await _empty(request)
    return preparation.status()


async def _run(request):
    try: body = await request.json()
    except (ValueError, UnicodeError): raise HTTPException(422, 'maintenance-invalid-request') from None
    if type(body) is not dict or set(body) != {'runId'} or not isinstance(body['runId'], str):
        raise HTTPException(422, 'maintenance-invalid-request')
    from papeer.core.edit_contracts import validate_id
    try: validate_id(body['runId'])
    except ValueError: raise HTTPException(422, 'maintenance-invalid-request') from None
    return body['runId']


@router.post('/resume', status_code=202)
async def resume(request: Request):
    run_id = await _run(request)
    try: result = await asyncio.to_thread(preparation.recover, run_id, 'capture')
    except (OSError, ValueError):
        return JSONResponse(status_code=409, content={'state': 'blocked', 'reason': 'maintenance-recovery-unavailable'}, headers={'Cache-Control': 'no-store'})
    return JSONResponse(status_code=202, content=result, headers={'Cache-Control': 'no-store'})


@router.post('/abandon', status_code=202)
async def abandon(request: Request):
    run_id = await _run(request)
    try: result = await asyncio.to_thread(preparation.recover, run_id, 'cancel')
    except (OSError, ValueError):
        return JSONResponse(status_code=409, content={'state': 'blocked', 'reason': 'maintenance-recovery-unavailable'}, headers={'Cache-Control': 'no-store'})
    return JSONResponse(status_code=202, content=result, headers={'Cache-Control': 'no-store'})


_SELECTOR = re.compile(r'^[0-9a-f]{32}$')
_NO_STORE = {'Cache-Control': 'no-store'}


async def _preview_body(request, with_selector):
    chunks = []; size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > 1024: raise HTTPException(422, 'preview-invalid-request')
        chunks.append(chunk)
    try: body = json.loads(b''.join(chunks))
    except (ValueError, UnicodeError): raise HTTPException(422, 'preview-invalid-request') from None
    expected = {'runId', 'selector'} if with_selector else {'runId'}
    if type(body) is not dict or set(body) != expected or not isinstance(body['runId'], str):
        raise HTTPException(422, 'preview-invalid-request')
    from papeer.core.edit_contracts import validate_id
    try: validate_id(body['runId'])
    except ValueError: raise HTTPException(422, 'preview-invalid-request') from None
    if with_selector and (not isinstance(body['selector'], str) or not _SELECTOR.fullmatch(body['selector'])):
        raise HTTPException(422, 'preview-invalid-request')
    return body['runId'], body.get('selector')


def _blocked(error):
    """Only an allowed reason code leaves the server; never an exception text or a path."""
    return JSONResponse(status_code=409, headers=_NO_STORE, content={
        'state': 'blocked', 'reason': notebook_preview.blocked_reason(error), 'scope': notebook_preview.SCOPE})


async def _preview(request, run_id, selector):
    """Run one preview on the gate's own thread; the thread outlives this coroutine if need be."""
    abort, box = threading.Event(), {}

    def launch():
        token = preparation.admit_preview(run_id)
        box['token'] = token
        if abort.is_set():
            preview_gate.gate.finish(token)
            raise ValueError('preview-cancelled')
        return preview_gate.gate.start(token, lambda current: notebook_preview.run(current, selector))

    try:
        try: future = await asyncio.to_thread(launch)
        except notebook_preview.EXPECTED_ERRORS as error: return _blocked(error)
        wrapped = asyncio.wrap_future(future)
        while True:
            done, _pending = await asyncio.wait({wrapped}, timeout=.25)
            if done: break
            if await request.is_disconnected():
                box['token'].cancel.set()
        try: result = wrapped.result()
        except notebook_preview.EXPECTED_ERRORS as error: return _blocked(error)
        return JSONResponse(content=result, headers=_NO_STORE)
    finally:
        # CancelledError (client gone) or any exit: stop the reader; the gate waits for the real thread.
        abort.set()
        token = box.get('token')
        if token is not None: token.cancel.set()


@router.post('/notebooks')
async def notebooks(request: Request):
    run_id, _selector = await _preview_body(request, False)
    return await _preview(request, run_id, None)


@router.post('/notebook-preview')
async def notebook_preview_route(request: Request):
    run_id, selector = await _preview_body(request, True)
    return await _preview(request, run_id, selector)
