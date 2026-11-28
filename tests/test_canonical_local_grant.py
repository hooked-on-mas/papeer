from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import pytest
from papeer.core.bootstrap.canonical_local_grant import assert_local_owner_grant
from papeer.core.bootstrap.canonical_local_grant_sqlite import discover_local_grant, provision_local_grant
from papeer.core.edit_contracts import validate_canonicallocalownergrant

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/canonical-local-owner-grant.json').read_text(encoding='utf8'))

def test_wire_fixture():
    assert_local_owner_grant(FIXTURE['valid'])
    validate_canonicallocalownergrant(FIXTURE['valid'])
    for value in FIXTURE['invalid']:
        with pytest.raises(ValueError): assert_local_owner_grant(value)
        with pytest.raises(ValueError): validate_canonicallocalownergrant(value)

def test_discovery_is_readonly_and_concurrent_provision_converges(tmp_path):
    path = tmp_path / 'canonical.sqlite3'
    assert discover_local_grant(path) == {'status':'setup-required','reason':'absent'}
    assert not path.exists()
    with sqlite3.connect(path) as db: db.execute('CREATE TABLE edit_roots(scope TEXT)')
    before = path.read_bytes()
    assert discover_local_grant(path) == {'status':'setup-required','reason':'schema-upgrade'}
    assert path.read_bytes() == before
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: provision_local_grant(path), range(2)))
    assert results[0] == results[1]
    assert discover_local_grant(path) == {'status':'ready','grant':results[0]}

def test_corruption_and_ungranted_state_never_provision(tmp_path):
    path = tmp_path / 'canonical.sqlite3'
    grant = provision_local_grant(path)
    with sqlite3.connect(path) as db: db.execute("UPDATE canonical_local_owner_grants SET payload='{}'")
    before = path.read_bytes()
    assert discover_local_grant(path)['status'] == 'recovery-required'
    with pytest.raises(ValueError): provision_local_grant(path)
    assert path.read_bytes() == before
    other = tmp_path / 'existing.sqlite3'
    with sqlite3.connect(other) as db:
        db.execute('CREATE TABLE edit_roots(scope TEXT)'); db.execute("INSERT INTO edit_roots VALUES ('legacy')")
    before = other.read_bytes()
    assert discover_local_grant(other)['reason'] == 'ungranted-canonical-state'
    with pytest.raises(ValueError): provision_local_grant(other)
    assert other.read_bytes() == before
    assert grant['namespaceId']
