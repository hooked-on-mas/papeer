from urllib.error import HTTPError
import pytest
from test_provider_data_plane import context  # noqa: F401
from test_provider_verifier import http as google_http  # noqa: F401
from papeer.core.providers.drive import transport
from sidecar.canonical_host import AuthorityError
from sidecar.provider.operations import ProviderOperations
from sidecar.provider.sync_once import sync_once
from papeer.core.edit_repository import SqliteEditRepository

@pytest.mark.parametrize('failure', ['503', '429'])
def test_transient_descriptor_outage_preserves_admitted_owner_and_requires_fresh_transfer(context, monkeypatch, failure):  # noqa: F811 - imported pytest fixture
    host, owner, plan, admit, _put, http = context; admit()
    scope = plan['intent']['scope']; operations = ProviderOperations(owner._registry, host)
    selected = plan['descriptor']['id']; summary = host.descriptor(owner._principal, selected)
    token = operations._retain(owner, owner._authorization, owner._lease_id, owner._principal, selected, summary)
    admission, admitted = owner._registry.admit_provider(owner._authorization, owner._lease_id, owner, scope)
    assert admitted == scope
    repository = SqliteEditRepository(owner._registry.bind_repository(owner._authorization, owner._lease_id, admission), scope)
    initial_open = transport._open
    def failed(request, timeout):
        raise HTTPError(request.full_url, int(failure), 'offline', {}, None)
    monkeypatch.setattr(transport, '_open', failed)
    with pytest.raises(ValueError, match='drive-provider-http-(503|429)'): operations.resolve(token, owner._authorization, owner._lease_id)
    owner.assert_current()
    assert repository.pending_intents() == []
    assert repository.pending_records() == []
    with owner.transaction('provider-read') as db:
        assert db.execute('SELECT COUNT(*) FROM canonical_provider_bindings').fetchone()[0] >= 1
    with pytest.raises(ValueError, match='drive-provider-http-(503|429)'): owner.assert_admitted()
    class NoTransfer:
        def __getattr__(self, name):
            raise AssertionError('transfer unexpectedly reached: ' + name)
    with pytest.raises(ValueError, match='drive-provider-http-(503|429)'):
        sync_once(owner, NoTransfer(), NoTransfer(), 'unused', lambda: False, NoTransfer())
    # The outage cannot complete a provider operation: a new real fetch is required.
    monkeypatch.setattr(transport, '_open', initial_open)
    assert operations.resolve(token, owner._authorization, owner._lease_id) is owner
    assert owner.assert_admitted() == scope
    assert isinstance(host.edit_storage(owner).pull(), dict)

@pytest.mark.parametrize('status', [401, 403])
def test_descriptor_authorization_denials_still_retire_owner(context, monkeypatch, status):  # noqa: F811 - imported pytest fixture
    host, owner, _plan, admit, _put, _http = context; admit()
    def denied(request, timeout): raise HTTPError(request.full_url, status, 'denied', {}, None)
    monkeypatch.setattr(transport, '_open', denied)
    with pytest.raises(ValueError): owner.verify_fresh()
    with pytest.raises((AuthorityError, ValueError), match='provider-operation-invalid|drive-provider-auth-changed'): owner.assert_current()


def test_real_selected_descriptor_change_stays_sticky(context):  # noqa: F811 - imported pytest fixture
    host, owner, plan, admit, _put, http = context; admit()
    file_id = plan['descriptor']['id']; old = http['files'][file_id]['metadata']['version']
    http['files'][file_id]['metadata']['version'] = str(int(old) + 1)
    with pytest.raises((ValueError, AuthorityError)): owner.verify_fresh()
    http['files'][file_id]['metadata']['version'] = old
    with pytest.raises((ValueError, AuthorityError)): owner.assert_current()

def test_real_provider_account_switch_stays_sticky(context):  # noqa: F811 - imported pytest fixture
    host, owner, _plan, admit, _put, http = context; admit()
    http['principal'] = 'fixture-permission-B'
    with pytest.raises(ValueError, match='drive-principal-changed'): host.current()
    with pytest.raises((ValueError, AuthorityError)): owner.assert_current()
