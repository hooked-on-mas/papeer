"""Shared initialization intent invariants. Generated structural validators come from edit-contracts.json."""
from copy import deepcopy
from papeer.core.edit_contracts import validate_canonicallibraryinitializationintent, validate_canonicalinitializerequest
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_model import reject


def make_initialization_intent(request, account_id):
    request = deepcopy(request)
    validate_canonicalinitializerequest(request)
    control = request['control']
    if request['profile']['identity']['accountId'] != account_id or control['identity'] != request['profile']['identity']:
        reject('dataset-scope')
    return {'version':1, 'accountId':account_id, 'requestId':control['id'], 'requestSha256':edit_content_hash(request), 'request':request, 'result':None}


def assert_initialization_intent(intent):
    validate_canonicallibraryinitializationintent(intent)
    if intent.get('retired'):
        if intent['identity']['accountId'] != intent['accountId']:
            reject('dataset-scope')
        return
    expected = make_initialization_intent(intent['request'], intent['accountId'])
    if intent['requestId'] != expected['requestId'] or intent['requestSha256'] != expected['requestSha256']:
        reject('initialization-intent-mismatch')
    if intent['result'] and intent['result']['status'] == 'accepted':
        receipt = intent['result']['receipt']; run = intent['request']['control']['transition']; manifest = run['publication']['manifest']
        expected_receipt = {'requestId':intent['requestId'], 'identity':intent['request']['profile']['identity'], 'initialScope':manifest['scope'], 'manifestId':manifest['id'], 'peerId':intent['request']['expectedPeerId']}
        if receipt != expected_receipt:
            reject('initialization-intent-mismatch')
