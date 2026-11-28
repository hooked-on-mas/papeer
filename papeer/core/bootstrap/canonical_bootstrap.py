"""Pure initialization admission; the host owns the transaction and principal guard."""
from copy import deepcopy

from papeer.core.edit_contracts import validate_canonicallibraryprofile, validate_canonicaldevicepeer, validate_canonicalinitializerequest
from papeer.core.edits.dataset_control import assert_dataset_control, assert_dataset_control_plan
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_model import reject


def assert_canonical_profile(profile):
    validate_canonicallibraryprofile(profile)
    scope = profile['initialization']['initialScope'] if profile['origin']['kind'] == 'local-initialize' else profile['origin']['installedScope']
    if {key:scope[key] for key in ('accountId','libraryId')} != profile['identity']:
        reject('dataset-scope')


def assert_initialization_unchanged(before, after):
    assert_canonical_profile(before)
    assert_canonical_profile(after)
    if before['identity'] != after['identity'] or before['initialization'] != after['initialization'] or before['origin'] != after['origin']:
        reject('dataset-initialization-changed')


def admit_initial_library(request, account_id, state):
    request, state = deepcopy(request), deepcopy(state)
    validate_canonicalinitializerequest(request)
    profile, control, peer_id = request['profile'], request['control'], request['expectedPeerId']
    if profile['identity']['accountId'] != account_id or profile['remote'] is not None or profile['identity'] != control['identity']:
        reject('dataset-scope')
    peer = state['peer']
    if peer is None:
        reject('dataset-peer')
    validate_canonicaldevicepeer(peer)
    if peer['accountId'] != account_id or peer['peerId'] != peer_id:
        reject('dataset-peer')
    if state['requestIdUsedByOtherIdentity']:
        reject('dataset-request-reused')
    assert_dataset_control_plan(control, profile['identity'])
    if control['transition']['mode'] != 'initialize':
        reject('dataset-initialize')
    run = control['transition']
    if run['source'] is not None or run['phase'] != 'activated' or control['id'] != run['id'] or control['epochs'] != [run['publication']['manifest']['scope']['epoch']]:
        reject('dataset-initialize')
    publication = control['transition']['publication']
    evidence = {'requestId':control['id'], 'requestSha256':edit_content_hash(request), 'initialScope':publication['manifest']['scope'], 'manifestId':publication['manifest']['id'], 'peerId':peer_id}
    receipt = {'requestId':evidence['requestId'], 'identity':profile['identity'], 'initialScope':evidence['initialScope'], 'manifestId':evidence['manifestId'], 'peerId':peer_id}
    values = [state[key] for key in ('profile', 'control', 'root', 'checkpoint', 'manifest')]
    present = sum(value is not None for value in values)
    if present == 0 and not state['otherLibraryState']:
        return {'kind':'create', 'profile':{**profile, 'origin':{'kind':'local-initialize'}, 'initialization':evidence}, 'receipt':receipt}
    if present != 5:
        reject('recovery-required')
    current_profile, current_control = state['profile'], state['control']
    try:
        assert_canonical_profile(current_profile)
        assert_dataset_control(current_control, profile['identity'])
    except ValueError:
        reject('recovery-required')
    if current_profile['identity'] != profile['identity'] or current_profile['origin']['kind'] != 'local-initialize':
        reject('recovery-required')
    if current_profile['initialization']['requestId'] != evidence['requestId']:
        reject('dataset-request-reused')
    if current_profile['initialization'] != evidence:
        reject('dataset-initialize-retry-mismatch')
    if state['root'] != publication['checkpoint']['roots'][0] or state['checkpoint'] != publication['checkpoint'] or state['manifest'] != publication['manifest']:
        reject('recovery-required')
    return {'kind':'retry', 'receipt':receipt}
