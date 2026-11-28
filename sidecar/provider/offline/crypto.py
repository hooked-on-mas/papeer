"""v1 wire-compatible vault crypto; never issues authority or persists keys."""
from typing import NoReturn
from dataclasses import dataclass, field
from copy import deepcopy
import hashlib
import json
import math
import re
import secrets

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, hmac
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from papeer.core.edit_model import canonical_json

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
MAX_COUNTER = (1 << 64) - 1
ITERATIONS = 600_000


class VaultInvalid(ValueError):
    pass


def fail() -> NoReturn:
    raise VaultInvalid('offline-unlock-failed')


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value): fail()
    return value


def encoded(value):
    return canonical_json(value).encode('utf-8')


def _fields(value, names):
    return type(value) is dict and set(value) == set(names)


def _bytes(value, size):
    return type(value) is list and len(value) == size and all(type(v) is int and 0 <= v <= 255 for v in value)


def password(secret):
    if type(secret) is not str or not 12 <= len(secret) <= 1024 or any(0xd800 <= ord(c) <= 0xdfff for c in secret): fail()
    raw = secret.encode('utf-8')
    if len(raw) > 4096: fail()
    return raw


def header(value, context):
    identifier(context)
    if (not _fields(value, ('version', 'context', 'iterations', 'salt', 'iv', 'prefix', 'wrapped'))
            or type(value['version']) is not int or value['version'] != 1 or value['context'] != context
            or type(value['iterations']) is not int or value['iterations'] != ITERATIONS
            or not all(_bytes(value[key], size) for key, size in (('salt', 32), ('iv', 12), ('prefix', 4), ('wrapped', 48)))): fail()
    return deepcopy(value)


@dataclass(frozen=True)
class Keys:
    encryption: bytes = field(repr=False)
    counter_mac: bytes = field(repr=False)


def _keys(seed):
    if len(seed) != 32: fail()
    derive = lambda purpose: HKDF(algorithm=hashes.SHA256(), length=32, salt=b'papeer-offline-vault-v1', info=purpose).derive(seed)
    return Keys(derive(b'grant-encryption'), derive(b'counter-authentication'))


def _wrapping(secret, salt):
    return hashlib.pbkdf2_hmac('sha256', password(secret), salt, ITERATIONS, dklen=32)


def create_header(context, secret):
    identifier(context); password(secret)
    parameters = {'version': 1, 'context': context, 'iterations': ITERATIONS,
                  'salt': list(secrets.token_bytes(32)), 'iv': list(secrets.token_bytes(12)), 'prefix': list(secrets.token_bytes(4))}
    seed = secrets.token_bytes(32)
    wrapped = AESGCM(_wrapping(secret, bytes(parameters['salt']))).encrypt(bytes(parameters['iv']), seed, encoded(parameters))
    return parameters | {'wrapped': list(wrapped)}, _keys(seed)


def unlock_header(value, context, secret):
    value = header(value, context)  # Validate all sizes/KDF parameters before expensive work.
    parameters = {k: v for k, v in value.items() if k != 'wrapped'}
    try:
        seed = AESGCM(_wrapping(secret, bytes(value['salt']))).decrypt(bytes(value['iv']), bytes(value['wrapped']), encoded(parameters))
        return value, _keys(seed)
    except (InvalidTag, UnicodeError, ValueError):
        fail()


def counter_number(value):
    if type(value) is not str or not re.fullmatch(r'[1-9][0-9]{0,19}', value): fail()
    number = int(value)
    if number > MAX_COUNTER: fail()
    return number


def _nonce(h, counter):
    return bytes(h['prefix']) + counter_number(counter).to_bytes(8, 'big')


def sign_counter(h, keys, next_value):
    header(h, h['context']); counter_number(next_value)
    signer = hmac.HMAC(keys.counter_mac, hashes.SHA256())
    signer.update(encoded({'purpose': 'offline-counter-v1', 'header': h, 'next': next_value}))
    return {'version': 1, 'context': h['context'], 'next': next_value, 'mac': list(signer.finalize())}


def verify_counter(h, keys, value):
    header(h, h['context'])
    if (not _fields(value, ('version', 'context', 'next', 'mac')) or type(value['version']) is not int
            or value['version'] != 1 or value['context'] != h['context'] or not _bytes(value['mac'], 32)): fail()
    number = counter_number(value['next'])
    verifier = hmac.HMAC(keys.counter_mac, hashes.SHA256())
    verifier.update(encoded({'purpose': 'offline-counter-v1', 'header': h, 'next': value['next']}))
    try: verifier.verify(bytes(value['mac']))
    except InvalidSignature: fail()
    return number


def seal(h, keys, record_id, counter, payload):
    header(h, h['context']); identifier(record_id)
    plain = encoded(payload)
    if len(plain) > 65536: fail()
    aad = {'version': 1, 'context': h['context'], 'id': record_id, 'counter': counter}
    ciphertext = AESGCM(keys.encryption).encrypt(_nonce(h, counter), plain, encoded(aad))
    return aad | {'ciphertext': list(ciphertext)}


def open_grant(h, keys, value):
    header(h, h['context'])
    if (not _fields(value, ('version', 'context', 'id', 'counter', 'ciphertext')) or type(value['version']) is not int
            or value['version'] != 1 or value['context'] != h['context']): fail()
    identifier(value['id']); counter_number(value['counter'])
    ciphertext = value['ciphertext']
    if type(ciphertext) is not list or not 16 <= len(ciphertext) <= 65552 or not _bytes(ciphertext, len(ciphertext)): fail()
    aad = {k: value[k] for k in ('version', 'context', 'id', 'counter')}
    try:
        plain = AESGCM(keys.encryption).decrypt(_nonce(h, value['counter']), bytes(ciphertext), encoded(aad))
        result = json.loads(plain.decode('utf-8'))
    except (InvalidTag, UnicodeError, ValueError): fail()
    return result


def tagged(value):
    """Explicit binary/container domains; no bytes-vs-numeric-object collision."""
    if type(value) is bytes: return ['bytes', list(value)]
    if type(value) is list: return ['array', [tagged(v) for v in value]]
    if type(value) is dict:
        if any(type(k) is not str for k in value): fail()
        return ['object', [[k, tagged(value[k])] for k in sorted(value)]]
    if value is None or type(value) in (str, bool): return ['scalar', value]
    if type(value) in (int, float):
        if not math.isfinite(value) or abs(value) > 9007199254740991 or value == 0 and math.copysign(1, value) < 0: fail()
        return ['number', value]
    fail()


def digest(value):
    return hashlib.sha256(encoded(tagged(value))).hexdigest()
