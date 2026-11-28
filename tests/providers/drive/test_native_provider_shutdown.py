"""Unexecuted candidate tests; exercise real hub and replication drain on synthetic objects."""
from contextlib import nullcontext
import importlib.util
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest


def candidate():
    path = Path(__file__).resolve().parents[3] / 'sidecar/routes/provider_owner.py'
    spec = importlib.util.spec_from_file_location('candidate_provider_owner', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_concurrent_stop_shares_real_hub_active_replication_and_closes_host_once(monkeypatch):
    from sidecar import deps
    from sidecar.provider import replication as replication_module
    from sidecar.provider.hub import NativeProviderHub
    from sidecar.provider.replication import ProviderReplicationOwner
    from sidecar.routes import system
    import sidecar.routes

    owner = candidate()
    flush_entered, finish_flush = threading.Event(), threading.Event()
    cancel_entered, finish_cancel = threading.Event(), threading.Event()
    host_closes, errors = [], []

    def sync(*args):
        flush_entered.set()
        assert finish_flush.wait(5)

    def cancel():
        cancel_entered.set()
        assert finish_cancel.wait(5)

    monkeypatch.setattr(replication_module, 'sync_once', sync)
    storage = SimpleNamespace(cancel=cancel, pass_scope=lambda: nullcontext(), finish=lambda: None)
    # The real flush/suspend/wait_drained methods and their actual synchronization
    # are used; only the network/storage body is synthetic.
    rep = ProviderReplicationOwner.__new__(ProviderReplicationOwner)
    rep._owner = rep._repository = rep._peer = rep._transfer_ids = None
    rep._storage = storage
    rep._lock = threading.RLock(); rep._flight = threading.Lock(); rep._stopped = threading.Event()
    rep._idle = threading.Event(); rep._idle.set(); rep._suspend_generation = 0
    rep._state = {'running': False, 'suspended': False, 'error': ''}
    hub = NativeProviderHub(SimpleNamespace(), SimpleNamespace(close=lambda: host_closes.append(True)))
    hub._replications['synthetic'] = ('lease', 'operation', rep)
    owner._hub = hub
    importlib.import_module('sidecar.routes.provider_owner')
    monkeypatch.setattr(sidecar.routes, 'provider_owner', owner)
    monkeypatch.setattr(deps, 'job_manager', SimpleNamespace(close=lambda: 0, wait_idle=lambda timeout: True))
    monkeypatch.setattr(deps, 'wait_for_library_requests', lambda timeout: True)

    def flush():
        try: rep.flush()
        except Exception as exc: errors.append(exc)  # noqa: BLE001 - retain worker exception for parent assertion
    flush_thread = threading.Thread(target=flush)
    flush_thread.start()
    first_result = []
    first = threading.Thread(target=lambda: first_result.append(system.stop_work()))
    close_errors = []
    try:
        assert flush_entered.wait(2)
        first.start()
        assert cancel_entered.wait(2)  # first caller is inside the real hub begin
        # The second stop must see that same in-progress begin, not an absent hub.
        assert system.stop_work() == (0, False)
        with pytest.raises(RuntimeError, match='previous-close-incomplete'):
            owner.start_lifetime()
        finish_cancel.set()
        first.join(2)
        assert first_result == [(0, False)]  # real replication remains active
        assert system.stop_work() == (0, False)
        assert host_closes == []

        def close():
            try: owner.close_if_created()
            except Exception as exc: close_errors.append(exc)  # noqa: BLE001 - retain worker exception for parent assertion
        closer = threading.Thread(target=close)
        closer.start()
        finish_flush.set()
        flush_thread.join(2); closer.join(2)
        assert not closer.is_alive()
        assert errors == [] and close_errors == []
        assert host_closes == [True]
        owner.close_if_created()
        assert host_closes == [True]
        owner.start_lifetime()
        assert owner._closing is None and not owner._shutdown
    finally:
        finish_cancel.set(); finish_flush.set()
        if first.ident is not None: first.join(5)
        flush_thread.join(5)


def test_failure_stays_visible_and_new_lifetime_cannot_discard_it():
    owner = candidate()
    def fail(): raise RuntimeError('synthetic begin failure')
    owner._hub = SimpleNamespace(begin_shutdown=fail)
    first = owner.stop_if_created()
    second = owner.stop_if_created()
    assert first is second
    assert not first.finish_shutdown(0, close_host=False)
    assert not second.finish_shutdown(0)
    with pytest.raises(RuntimeError, match='previous-close-incomplete'):
        owner.start_lifetime()
    with pytest.raises(RuntimeError, match='provider-close-incomplete'):
        owner.close_if_created()


def test_close_false_keeps_host_for_lifespan_close():
    owner = candidate()
    calls = []
    class Hub:
        def begin_shutdown(self): calls.append('begin')
        def finish_shutdown(self, timeout, *, close_host=True):
            calls.append(('finish', close_host))
            return True
    owner._hub = Hub()
    handle = owner.stop_if_created()
    assert handle.finish_shutdown(0, close_host=False)
    with pytest.raises(RuntimeError, match='previous-close-incomplete'):
        owner.start_lifetime()
    owner.close_if_created()
    owner.close_if_created()
    assert calls == ['begin', ('finish', False), ('finish', True)]
    owner.start_lifetime()


def test_finish_exception_is_sticky_for_all_callers():
    owner = candidate()
    calls = []
    class Hub:
        def begin_shutdown(self): pass
        def finish_shutdown(self, timeout, *, close_host=True):
            calls.append(close_host)
            raise RuntimeError('synthetic unknown finish outcome')
    owner._hub = Hub()
    first = owner.stop_if_created()
    assert not first.finish_shutdown(0, close_host=False)
    assert not owner.stop_if_created().finish_shutdown(0, close_host=True)
    assert calls == [False]
    with pytest.raises(RuntimeError, match='provider-close-incomplete'):
        owner.close_if_created()
    with pytest.raises(RuntimeError, match='previous-close-incomplete'):
        owner.start_lifetime()


def test_timeout_can_be_retried_after_real_replication_drains(monkeypatch):
    from sidecar.provider import replication as replication_module
    from sidecar.provider.hub import NativeProviderHub
    from sidecar.provider.replication import ProviderReplicationOwner

    owner = candidate()
    entered, release = threading.Event(), threading.Event()
    closes, errors = [], []
    def sync(*args):
        entered.set()
        assert release.wait(5)
    monkeypatch.setattr(replication_module, 'sync_once', sync)
    rep = ProviderReplicationOwner.__new__(ProviderReplicationOwner)
    rep._owner = rep._repository = rep._peer = rep._transfer_ids = None
    rep._storage = SimpleNamespace(cancel=lambda: None, pass_scope=lambda: nullcontext(), finish=lambda: None)
    rep._lock = threading.RLock(); rep._flight = threading.Lock(); rep._stopped = threading.Event()
    rep._idle = threading.Event(); rep._idle.set(); rep._suspend_generation = 0
    rep._state = {'running': False, 'suspended': False, 'error': ''}
    hub = NativeProviderHub(SimpleNamespace(), SimpleNamespace(close=lambda: closes.append(True)))
    hub._replications['synthetic'] = ('lease', 'operation', rep)
    owner._hub = hub
    def flush():
        try: rep.flush()
        except Exception as exc: errors.append(exc)  # noqa: BLE001 - retain worker exception for parent assertion
    thread = threading.Thread(target=flush)
    thread.start()
    try:
        assert entered.wait(2)
        handle = owner.stop_if_created()
        assert not handle.finish_shutdown(0, close_host=False)
        release.set(); thread.join(2)
        assert not thread.is_alive() and errors == []
        assert handle.finish_shutdown(0, close_host=False)
        assert closes == []
        owner.close_if_created()
        assert closes == [True]
    finally:
        release.set(); thread.join(5)


def test_concurrent_lifespan_closes_close_host_once():
    owner = candidate()
    entered, release, second_entered = threading.Event(), threading.Event(), threading.Event()
    calls, errors = [], []
    class Hub:
        def begin_shutdown(self): pass
        def finish_shutdown(self, timeout, *, close_host=True):
            calls.append(close_host)
            entered.set()
            assert release.wait(5)
            return True
    owner._hub = Hub()
    def close():
        try: owner.close_if_created()
        except Exception as exc: errors.append(exc)  # noqa: BLE001 - retain worker exception for parent assertion
    first = threading.Thread(target=close)
    second = threading.Thread(target=close)
    first.start()
    try:
        assert entered.wait(2)
        original_stop = owner.stop_if_created
        def second_stop():
            handle = original_stop()
            second_entered.set()
            return handle
        owner.stop_if_created = second_stop
        second.start()
        assert second_entered.wait(2)
        release.set()
        first.join(2); second.join(2)
        assert not first.is_alive() and not second.is_alive()
        assert errors == [] and calls == [True]
    finally:
        release.set(); first.join(5)
        if second.ident is not None: second.join(5)


def test_start_lifetime_preserves_existing_active_hub():
    owner = candidate()
    active_hub = object()
    owner._hub = active_hub
    owner.start_lifetime()
    assert owner.hub() is active_hub
