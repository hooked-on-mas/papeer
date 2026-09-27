"""Tests only: Library.document hands out a deeply read-only view of the shared extraction.

Library.document returns one value shared by every caller until document.json changes
(papeer.core.shared_json), so no caller may change it in place. tests/conftest.py wraps the method
for every test with `frozen_view`, so that such a change raises TypeError at the place it is made
instead of silently altering what the next caller reads. Production code is not touched.

The view is made of dict and list subclasses, so everything that reads a document keeps working:
isinstance checks, json.dumps, ==, iteration, dict(view, key=...), list(view), slicing and `+`.
Copies are ordinary, changeable values: dict(view), view.copy(), copy.copy, copy.deepcopy and pickle
give plain dicts and lists (the first three are shallow, so what is inside stays read-only).
"""
from __future__ import annotations

import copy
import threading
from typing import Any


class SharedDocumentModified(TypeError):
    """A shared document (Library.document) was changed in place; copy it first."""


def _refuse(name: str):
    def method(self, *args, **kwargs):
        raise SharedDocumentModified(
            f"Library.document の共有値をその場で書き換えています（{type(self).__name__}.{name}）。"
            "copy.deepcopy するか、書き換える部分をコピーしてください。")
    method.__name__ = name
    return method


class FrozenDict(dict):
    __slots__ = ()
    for _name in ("__setitem__", "__delitem__", "update", "pop", "popitem", "setdefault", "clear", "__ior__"):
        locals()[_name] = _refuse(_name)
    del _name

    def __copy__(self):
        return dict(self)

    def __deepcopy__(self, memo):
        return {copy.deepcopy(key, memo): copy.deepcopy(value, memo) for key, value in self.items()}

    def __reduce_ex__(self, protocol):
        return dict, (dict(self),)


class FrozenList(list):
    __slots__ = ()
    for _name in ("__setitem__", "__delitem__", "append", "extend", "insert", "remove", "pop", "clear",
                  "sort", "reverse", "__iadd__", "__imul__"):
        locals()[_name] = _refuse(_name)
    del _name

    def __copy__(self):
        return list(self)

    def __deepcopy__(self, memo):
        return [copy.deepcopy(value, memo) for value in self]

    def __reduce_ex__(self, protocol):
        return list, (list(self),)


def freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return FrozenDict((key, freeze(item)) for key, item in value.items())
    if isinstance(value, list):
        return FrozenList(freeze(item) for item in value)
    return value


def frozen_view(document_method):
    """Wrap Library.document: the same shared value always gives the same read-only view (so that
    `is` still tells whether the file was read again), and a new value (the file changed) a new one."""
    views: dict[int, tuple[Any, Any]] = {}
    lock = threading.Lock()

    def document(self, paper_id: str):
        value = document_method(self, paper_id)
        with lock:
            known = views.get(id(value))
            # The value is kept alongside its view, so its id cannot be reused by another object.
            if known is None or known[0] is not value:
                known = views[id(value)] = (value, freeze(value))
            return known[1]

    return document
