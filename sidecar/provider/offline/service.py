"""Host-owned enrollment/unlock; bearer authenticates transport, never substitutes for a passphrase."""
from copy import deepcopy
import json
import re
import secrets
import time

from papeer.core.edits.provider.activation import query_prepared
from sidecar.canonical_host import AuthorityError, _existing, _current_grant, _schema_state, _require_clear, _provider_proof
from sidecar.provider.owner import ProviderOperationOwner, ProviderCommitUnknown
from . import crypto, snapshot, storage
from .owner import create as create_owner


class NativeOfflineService:
    def __init__(self, registry):
        self.registry = registry
        self._generation = 0
        self._unlocks = {}
        self._jobs = registry._offline_jobs
        self._inflight = self._jobs.enrollments
        with registry._lock:
            self._active_principal = registry._provider_principal
            registry._offline_services.add(self)

    def _capture(self, authorization, lease_id):
        with self.registry._lock:
            lease = self.registry._lease(authorization, lease_id)
            _require_clear()
            return {'authorization': authorization, 'leaseId': lease_id, 'lease': lease, 'generation': self._generation,
                    'leaseGeneration': lease.get('_offline_generation', 0), 'jobToken': self._jobs.capture()}

    def _check(self, job):
        with self.registry._lock:
            if (job['generation'] != self._generation or self.registry._lease(job['authorization'], job['leaseId']) is not job['lease']
                    or job['leaseGeneration'] != job['lease'].get('_offline_generation', 0)):
                raise AuthorityError('offline-operation-retired')
            if self._jobs.retired(job['jobToken'], job.get('enrollmentKey'), job.get('kind')):
                raise AuthorityError('offline-operation-retired')

    def _read(self, job):
        with self.registry._lock:
            self._check(job)
            with _existing(job['lease']['path'], False) as db:
                _require_clear()
                if _schema_state(db) != 'ready' or _current_grant(db) != job['lease']['grant']: raise AuthorityError('offline-unlock-failed')
                rows = storage.read(db, job['lease']['grant']['contextId'])
            self._check(job)
            return rows

    def _live(self, authorization, lease_id, admission_id, kind=None, job=None):
        if job is None: job = self._capture(authorization, lease_id)
        job['kind'] = kind
        with self.registry._lock:
            admission = self.registry._admissions.get(admission_id) if isinstance(admission_id, str) else None
            owner = admission.get('provider_owner') if admission else None
            if (not admission or admission['lease_id'] != lease_id or not isinstance(owner, ProviderOperationOwner)
                    or owner._registry is not self.registry or owner._authorization != authorization or owner._lease_id != lease_id):
                raise AuthorityError('provider-admission-required')
            scope = deepcopy(admission['proof']['scope'])
        owner.verify_fresh()
        with owner.transaction('provider-read') as db:
            proof = _provider_proof(db, owner, scope)
            if self.registry._admissions.get(admission_id) is not admission or proof != admission['proof']: raise AuthorityError('admission-changed')
            value = snapshot.selector_from_proof(job['lease']['grant'], proof)
            job['enrollmentKey'] = snapshot.reclaim_identity(job['lease']['grant']['contextId'], value)
            self._check(job)
        if query_prepared(owner, value['requestId'])['status'] != 'accepted': raise AuthorityError('provider-activation-incomplete')
        with owner.transaction('provider-read') as db:
            proof, activation_digest = snapshot.read(db, job['lease']['grant']['contextId'], value)
            if self.registry._admissions.get(admission_id) is not admission or proof != admission['proof']: raise AuthorityError('admission-changed')
            self._allow_principal(value)
            rows = storage.read(db, job['lease']['grant']['contextId'])
        self._check(job)
        return job, owner, value, proof, activation_digest, rows

    def _decode(self, h, keys, rows, kind='grants'):
        result = {}
        for record_id, raw in rows[kind].items():
            grant = json.loads(raw)
            if grant.get('id') != record_id: crypto.fail()
            payload = crypto.open_grant(h, keys, grant)
            if (type(payload) is not dict or set(payload) != {'version', 'selector', 'activationDigest'}
                    or type(payload['version']) is not int or payload['version'] != 1
                    or type(payload['activationDigest']) is not str or not re.fullmatch('[0-9a-f]{64}', payload['activationDigest'])): crypto.fail()
            result[record_id] = payload
        return result

    def _begin_enrollment(self, authorization, lease_id, admission_id, request_id):
        # Register before network verification so revocation drains even jobs
        # that have not reached KDF/pending persistence yet. This metadata only
        # classifies work; _live still verifies the real owner before any write.
        job = self._capture(authorization, lease_id)
        job['kind'] = 'enroll'
        with self.registry._lock:
            admission = self.registry._admissions.get(admission_id) if isinstance(admission_id, str) else None
            owner = admission.get('provider_owner') if admission else None
            if (not admission or admission['lease_id'] != lease_id or not isinstance(owner, ProviderOperationOwner)
                    or owner._registry is not self.registry or owner._authorization != authorization or owner._lease_id != lease_id):
                raise AuthorityError('provider-admission-required')
            selector = snapshot.selector_from_proof(job['lease']['grant'], admission['proof'])
            job['enrollmentKey'] = snapshot.reclaim_identity(job['lease']['grant']['contextId'], selector)
            self._check(job)
            if request_id in self._inflight: return None
            self._inflight[request_id] = job
        return job

    def enroll(self, authorization, lease_id, admission_id, secret, request_id):
        crypto.identifier(request_id); crypto.password(secret)
        job = self._begin_enrollment(authorization, lease_id, admission_id, request_id)
        if job is None: return {'status': 'unknown', 'requestId': request_id}
        grant_committed = False
        pending_committed = False
        counter_after = None
        try:
            job, owner, value, _proof, activation_digest, old = self._live(authorization, lease_id, admission_id, 'enroll', job)
            context = job['lease']['grant']['contextId']
            if old['header'] is None:
                h, keys = crypto.create_header(context, secret)
                counter = 1; counter_after = crypto.sign_counter(h, keys, '2')
                existing = {}; pending = {}
            else:
                h, keys = crypto.unlock_header(json.loads(old['header']), context, secret)
                counter = crypto.verify_counter(h, keys, json.loads(old['counter']))
                existing = self._decode(h, keys, old)
                pending = self._decode(h, keys, old, 'pending')
            self._check(job)
            if request_id in existing:
                payload = existing[request_id]
                if payload != {'version': 1, 'selector': value, 'activationDigest': activation_digest}: crypto.fail()
                with owner.transaction('provider-read') as db:
                    self._check(job)
                    if storage.read(db, context) != old or snapshot.read(db, context, value)[1] != activation_digest: crypto.fail()
                return {'status': 'accepted', 'requestId': request_id}
            if request_id in pending:
                if pending[request_id] != {'version': 1, 'selector': value, 'activationDigest': activation_digest}: crypto.fail()
                with owner.transaction('provider-write') as db:
                    self._check(job)
                    if storage.read(db, context) != old or snapshot.read(db, context, value)[1] != activation_digest: crypto.fail()
                    storage.promote(db, context, request_id, old['pending'][request_id])
                grant_committed = True
                self._check(job)
                return {'status': 'accepted', 'requestId': request_id}
            if any(snapshot.identity(context, payload['selector']) == snapshot.identity(context, value) for payload in list(existing.values()) + list(pending.values())):
                return {'status': 'rejected', 'requestId': request_id, 'reason': 'offline-already-enabled'}
            if len(existing) + len(pending) + 3 > storage.MAX_ROWS:
                return {'status': 'rejected', 'requestId': request_id, 'reason': 'offline-capacity-exceeded'}
            if old['header'] is not None:
                if counter >= crypto.MAX_COUNTER: crypto.fail()
                counter_after = crypto.sign_counter(h, keys, str(counter + 1))
                # Authentication/MAC work is outside the transaction. Commit this
                # reservation BEFORE AES-GCM; even later cancellation burns it.
                with owner.transaction('provider-write') as db:
                    self._check(job)
                    if storage.read(db, context) != old or snapshot.read(db, job['lease']['grant']['contextId'], value)[1] != activation_digest: crypto.fail()
                    storage.reserve(db, context, old['counter'], counter_after)
                self._check(job)
            payload = {'version': 1, 'selector': value, 'activationDigest': activation_digest}
            encrypted = crypto.seal(h, keys, request_id, str(counter), payload)
            self._check(job)
            latest = self._read(job)
            if old['header'] is not None:
                if latest['header'] != old['header'] or latest['grants'] != old['grants'] or latest['pending'] != old['pending']: crypto.fail()
                if crypto.verify_counter(h, keys, json.loads(latest['counter'])) <= counter: crypto.fail()
            elif latest != old: crypto.fail()
            with owner.transaction('provider-write') as db:
                self._check(job)
                if storage.read(db, context) != latest or snapshot.read(db, job['lease']['grant']['contextId'], value)[1] != activation_digest: crypto.fail()
                if old['header'] is None:
                    if counter_after is None: crypto.fail()
                    storage.insert(db, context, 'header', context, h)
                    storage.insert(db, context, 'counter', context, counter_after)
                storage.insert(db, context, 'pending', request_id, encrypted)
            pending_committed = True
            # A cold retry reads this exact authenticated ciphertext. It does
            # not reserve another nonce or encrypt again for this fixed ID.
            self._check(job)
            sealed = self._read(job)
            with owner.transaction('provider-write') as db:
                self._check(job)
                if storage.read(db, context) != sealed or snapshot.read(db, context, value)[1] != activation_digest: crypto.fail()
                storage.promote(db, context, request_id, sealed['pending'][request_id])
            grant_committed = True
            self._check(job)
            return {'status': 'accepted', 'requestId': request_id}
        except storage.VaultCapacityExceeded:
            if pending_committed or grant_committed: return {'status': 'unknown', 'requestId': request_id}
            return {'status': 'rejected', 'requestId': request_id, 'reason': 'offline-capacity-exceeded'}
        except ProviderCommitUnknown:
            return {'status': 'unknown', 'requestId': request_id}
        except AuthorityError:
            if grant_committed or pending_committed: return {'status': 'unknown', 'requestId': request_id}
            raise
        finally:
            with self.registry._lock:
                if self._inflight.get(request_id) is job: del self._inflight[request_id]
                job['jobToken'].done.set()

    def query(self, authorization, lease_id, admission_id, secret, request_id):
        crypto.identifier(request_id)
        job, owner, value, _proof, activation_digest, rows = self._live(authorization, lease_id, admission_id)
        with self.registry._lock:
            if request_id in self._inflight: return {'status': 'unknown', 'requestId': request_id}
        if rows['header'] is None: return {'status': 'rejected', 'requestId': request_id}
        h, keys = crypto.unlock_header(json.loads(rows['header']), job['lease']['grant']['contextId'], secret)
        crypto.verify_counter(h, keys, json.loads(rows['counter']))
        payload = self._decode(h, keys, rows).get(request_id)
        pending = self._decode(h, keys, rows, 'pending').get(request_id)
        self._check(job)
        with owner.transaction('provider-read') as db:
            self._check(job)
            if storage.read(db, job['lease']['grant']['contextId']) != rows or snapshot.read(db, job['lease']['grant']['contextId'], value)[1] != activation_digest: crypto.fail()
        expected = {'version': 1, 'selector': value, 'activationDigest': activation_digest}
        return {'status': 'accepted' if payload == expected else 'unknown' if pending == expected else 'rejected', 'requestId': request_id}

    def recover_enrollment(self, authorization, lease_id, admission_id, secret):
        """Reveal one exact live tuple's fixed ID only after verifying the secret."""
        crypto.password(secret)
        job, owner, value, _proof, activation_digest, rows = self._live(authorization, lease_id, admission_id)
        if rows['header'] is None: return None
        context = job['lease']['grant']['contextId']
        h, keys = crypto.unlock_header(json.loads(rows['header']), context, secret)
        crypto.verify_counter(h, keys, json.loads(rows['counter']))
        grants = self._decode(h, keys, rows)
        pending = self._decode(h, keys, rows, 'pending')
        found = []
        expected = {'version': 1, 'selector': value, 'activationDigest': activation_digest}
        for kind, entries in [('accepted', grants), ('pending', pending)]:
            for request_id, payload in entries.items():
                if snapshot.identity(context, payload['selector']) != snapshot.identity(context, value): continue
                if payload != expected: crypto.fail()
                found.append({'requestId': request_id, 'status': kind})
        if len(found) > 1: crypto.fail()
        with owner.transaction('provider-read') as db:
            self._check(job)
            if storage.read(db, context) != rows or snapshot.read(db, context, value)[1] != activation_digest: crypto.fail()
        return found[0] if found else None

    def _revocation_live(self, authorization, lease_id, admission_id):
        job = self._capture(authorization, lease_id)
        with self.registry._lock:
            admission = self.registry._admissions.get(admission_id) if isinstance(admission_id, str) else None
            owner = admission.get('provider_owner') if admission else None
            if (not admission or admission['lease_id'] != lease_id or not isinstance(owner, ProviderOperationOwner)
                    or owner._registry is not self.registry or owner._authorization != authorization or owner._lease_id != lease_id):
                raise AuthorityError('provider-admission-required')
            scope = deepcopy(admission['proof']['scope'])
        owner.verify_fresh()
        with owner.transaction('provider-read') as db:
            proof = _provider_proof(db, owner, scope)
            if self.registry._admissions.get(admission_id) is not admission or proof != admission['proof']: raise AuthorityError('admission-changed')
            value = snapshot.selector_from_proof(job['lease']['grant'], proof)
            job['enrollmentKey'] = snapshot.reclaim_identity(job['lease']['grant']['contextId'], value)
            self._check(job); self._allow_principal(value)
            rows = storage.read(db, job['lease']['grant']['contextId'])
        self._check(job)
        return job, owner, value, proof, None, rows

    def revoke_enrollment(self, authorization, lease_id, admission_id, secret):
        """Explicit online retirement, never a way to admit an old scope."""
        crypto.password(secret)
        job, _owner, value, _proof, _digest, rows = self._revocation_live(authorization, lease_id, admission_id)
        context = job['lease']['grant']['contextId']
        if rows['header'] is not None:
            h, keys = crypto.unlock_header(json.loads(rows['header']), context, secret)
            crypto.verify_counter(h, keys, json.loads(rows['counter']))
            self._decode(h, keys, rows); self._decode(h, keys, rows, 'pending')
        with self.registry._lock:
            self._check(job)
            retirement = self._jobs.reserve(job['enrollmentKey'])
            if retirement is None: return {'status': 'unknown'}
        committed = False
        try:
            # Never wait while holding the verifier, registry or a SQLite lock.
            deadline = time.monotonic() + 5
            for event in retirement.waiters:
                if not event.wait(max(0, deadline - time.monotonic())): return {'status': 'unknown'}
            # Refresh after draining: a cancelled old job may have committed a
            # counter/pending row before its cancellation fence was reserved.
            fresh, owner, selected, proof, _digest, current = self._revocation_live(authorization, lease_id, admission_id)
            if fresh['enrollmentKey'] != retirement.key: raise AuthorityError('admission-changed')
            targets = []
            if current['header'] is not None:
                h, keys = crypto.unlock_header(json.loads(current['header']), context, secret)
                crypto.verify_counter(h, keys, json.loads(current['counter']))
                for kind, field in [('grant', 'grants'), ('pending', 'pending')]:
                    for request_id, payload in self._decode(h, keys, current, field).items():
                        identity = snapshot.reclaim_identity(context, payload['selector'])
                        if identity == retirement.key: targets.append((kind, request_id, current[field][request_id]))
            with owner.transaction('provider-write') as db:
                self._check(fresh)
                if self._jobs.barriers.get(retirement.key) is not retirement: raise AuthorityError('offline-operation-retired')
                if storage.read(db, context) != current or _provider_proof(db, owner, selected['scope']) != proof: crypto.fail()
                for kind, request_id, raw in targets: storage.remove_permission(db, context, kind, request_id, raw)
                self._check(fresh)
                if _provider_proof(db, owner, selected['scope']) != proof: crypto.fail()
            committed = True
            self._check(fresh)
            return {'status': 'revoked'}
        except ProviderCommitUnknown:
            committed = True
            return {'status': 'unknown'}
        except Exception:  # noqa: BLE001 - a reserved retirement may already have cancelled jobs; never report pre-effect rejection
            return {'status': 'unknown'}
        finally:
            with self.registry._lock: self._jobs.finish(retirement, settled=committed)

    def unlock(self, authorization, lease_id, secret):
        """No list/discovery method exists before successful secret verification."""
        job = self._capture(authorization, lease_id); rows = self._read(job)
        context = job['lease']['grant']['contextId']
        if rows['header'] is None: crypto.fail()
        h, keys = crypto.unlock_header(json.loads(rows['header']), context, secret)
        crypto.verify_counter(h, keys, json.loads(rows['counter']))
        payloads = self._decode(h, keys, rows)
        self._decode(h, keys, rows, 'pending')
        if not payloads: crypto.fail()
        choices, entries, proofs = [], {}, {}
        with self.registry._lock:
            self._check(job)
            with _existing(job['lease']['path'], False) as db:
                _require_clear()
                if _current_grant(db) != job['lease']['grant'] or _schema_state(db) != 'ready': crypto.fail()
                current = storage.read(db, context)
                if current['header'] != rows['header'] or current['grants'] != rows['grants'] or current['pending'] != rows['pending']: crypto.fail()
                for record_id, payload in payloads.items():
                    self._allow_principal(payload['selector'])
                    proof, activation_digest = snapshot.read(db, context, payload['selector'])
                    if activation_digest != payload['activationDigest']: crypto.fail()
                    handle = secrets.token_urlsafe(32)
                    choices.append({'handle': handle, 'title': proof['profile']['title']})
                    entries[handle] = (record_id, payload)
                    proofs[record_id] = deepcopy(proof)
            self._check(job)
            token = secrets.token_urlsafe(32)
            session = job | {'id': token, 'headerRaw': rows['header'], 'grants': deepcopy(rows['grants']), 'entries': entries, 'proofs': proofs}
            self._unlocks[token] = session
        return {'unlockSession': token, 'choices': choices}

    def _check_session(self, session):
        self._check(session)
        if self._unlocks.get(session['id']) is not session: raise AuthorityError('offline-operation-retired')

    def _selected(self, authorization, lease_id, token, handle):
        with self.registry._lock:
            self.registry._lease(authorization, lease_id)
            session = self._unlocks.get(token) if isinstance(token, str) else None
            if not session or session['authorization'] != authorization or session['leaseId'] != lease_id: raise AuthorityError('offline-unlock-failed')
            self._check_session(session)
            entry = session['entries'].get(handle) if isinstance(handle, str) else None
            if entry is None: raise AuthorityError('offline-unlock-failed')
            return session, entry

    def open(self, authorization, lease_id, token, handle):
        session, (record_id, payload) = self._selected(authorization, lease_id, token, handle)
        owner = create_owner(self, session, record_id, payload)
        owner.assert_current()
        installed = self.registry.offline_handle(authorization, lease_id, owner, owner.scope)
        return {'leaseId': lease_id, 'handleId': installed, 'requestId': payload['selector']['requestId'], 'authorizationMode': 'provider-offline'}

    def revoke(self, authorization, lease_id, token, handle):
        session, (record_id, payload) = self._selected(authorization, lease_id, token, handle)
        owner = create_owner(self, session, record_id, payload)
        committed = False
        try:
            with self.registry._lock:
                self._check_session(session)
                context = session['lease']['grant']['contextId']
                with _existing(session['lease']['path'], True) as db:
                    _require_clear()
                    if _current_grant(db) != session['lease']['grant'] or _schema_state(db) != 'ready': crypto.fail()
                    current = storage.read(db, context)
                    if current['header'] != session['headerRaw']: crypto.fail()
                    if record_id not in current['grants']: return {'status': 'revoked'}
                    owner._check(db)
                    storage.remove(db, context, record_id, session['grants'][record_id])
                    if snapshot.current_proof(db, context, payload['selector']) != owner._expected_proof: crypto.fail()
                    self._check_session(session)
                committed = True
                self._check_session(session)
            return {'status': 'revoked'}
        except Exception as error:
            if committed: raise ProviderCommitUnknown('provider-commit-unknown') from error
            raise

    def lock(self, authorization, lease_id):
        with self.registry._lock:
            lease = self.registry._lease(authorization, lease_id)
            # Cleanup may outlive its durable grant revision, but it owns only
            # this exact retained lease. Never retire a newer lease's work.
            lease['_offline_generation'] = lease.get('_offline_generation', 0) + 1
            for service in list(self.registry._offline_services):
                service._retire_lease_locked(lease)
        return {'status': 'locked'}

    def _retire_lease_locked(self, lease):
        self._unlocks = {token: session for token, session in self._unlocks.items() if session['lease'] is not lease}

    def _retire_locked(self):
        self._generation += 1
        self._unlocks.clear()

    def _provider_admitted_locked(self, principal_digest):
        # A real fresh online admission changes host state, not a caller boolean.
        self._active_principal = principal_digest
        self._retire_locked()

    def _allow_principal(self, selector):
        if self._active_principal is not None and selector['binding']['principalDigest'] != self._active_principal:
            raise AuthorityError('offline-account-mismatch')
