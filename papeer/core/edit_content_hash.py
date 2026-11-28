"""Versioned JSON-value content encoding, identical to editContentHash.ts."""
import hashlib
import math
import struct


def edit_content_hash(value):
    digest = hashlib.sha256(b"papeer-edit-content-v1\0")
    active = set()

    def string(encoded):
        digest.update(b"\x04" + struct.pack(">Q", len(encoded)) + encoded)

    def visit(value):
        if value is None:
            digest.update(b"\x00")
        elif type(value) is bool:
            digest.update(b"\x02" if value else b"\x01")
        elif type(value) in (int, float):
            try:
                number = float(value)
            except OverflowError:
                raise ValueError("non-json-content") from None
            if not math.isfinite(number):
                raise ValueError("non-json-content")
            digest.update(b"\x03" + struct.pack(">d", 0.0 if number == 0 else number))
        elif type(value) is str:
            string(value.encode("utf-8"))
        elif type(value) in (list, dict) and id(value) not in active:
            active.add(id(value))
            if type(value) is list:
                digest.update(b"\x05" + struct.pack(">Q", len(value)))
                for item in value:
                    visit(item)
            else:
                if any(type(key) is not str for key in value):
                    raise ValueError("non-json-content")
                entries = sorted((key.encode("utf-8"), item) for key, item in value.items())
                digest.update(b"\x06" + struct.pack(">Q", len(entries)))
                for key, item in entries:
                    string(key)
                    visit(item)
            active.remove(id(value))
        else:
            raise ValueError("non-json-content")

    try:
        visit(value)
    except UnicodeEncodeError:
        raise ValueError("non-json-content") from None
    return digest.hexdigest()
