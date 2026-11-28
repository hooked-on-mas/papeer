"""Business rules for the shared edit contract; parity fixtures also run in TypeScript."""
from __future__ import annotations

from copy import deepcopy
from collections import OrderedDict
from collections.abc import Mapping
from datetime import datetime
import json
import math
from typing import NoReturn

from papeer.core.edit_contracts import EDIT_LIMITS, CONFLICT_SUFFIX, validate_editbatch, validate_snapshot
from papeer.core.edit_geometry import annotation_points


def conflict_title(title: str) -> str:
    return title[:EDIT_LIMITS["title"] - len(CONFLICT_SUFFIX)] + CONFLICT_SUFFIX


def canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def reject(reason) -> NoReturn:
    raise ValueError(reason)


def _immutable(*args, **kwargs):
    raise TypeError("immutable edit state")


class _FrozenDict(dict):
    __setitem__ = __delitem__ = clear = pop = popitem = setdefault = update = __ior__ = _immutable

    def __deepcopy__(self, memo):
        return {key: deepcopy(value, memo) for key, value in self.items()}


class _FrozenList(list):
    __setitem__ = __delitem__ = append = clear = extend = insert = pop = remove = reverse = sort = __iadd__ = __imul__ = _immutable

    def __deepcopy__(self, memo):
        return [deepcopy(value, memo) for value in self]


def _freeze(value):
    if isinstance(value, (_FrozenDict, _FrozenList)):
        return value
    if isinstance(value, dict):
        return _FrozenDict({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return _FrozenList(_freeze(item) for item in value)
    return value


def unique(values, reason):
    if len(set(values)) != len(values):
        reject(reason)


def deleted_item_ids(snapshot):
    return {item_id for record in snapshot["deletions"] if record["active"] for item_id in record["itemIds"]}


def assert_page(page):
    unique([a["id"] for a in page["annotations"]], "duplicate-annotation")
    count = 0
    for annotation in page["annotations"]:
        if annotation["kind"] != "ink" and annotation["metadata"]["createdAt"] is not None:
            try:
                datetime.fromisoformat(annotation["metadata"]["createdAt"])
            except ValueError:
                reject("annotation-time")
        if annotation["kind"] == "highlight":
            text_range = annotation["range"]
            if (text_range["kind"] == "indexed" and text_range["end"] <= text_range["start"]) or annotation["backgroundRevision"] != page["backgroundRevision"]:
                reject("highlight-range-or-background")
            for quad in annotation["quads"]:
                area = sum(p["x"] * quad[(i + 1) % 4]["y"] - p["y"] * quad[(i + 1) % 4]["x"] for i, p in enumerate(quad))
                if not math.isfinite(area) or abs(area) < 1e-9:
                    reject("degenerate-quad")
        elif annotation["kind"] == "ink":
            g, t = annotation["geometry"], annotation["transform"]
            if g["kind"] in ("line", "arrow") and g["start"] == g["end"]:
                reject("degenerate-line")
            if g["kind"] == "path":
                count += len(g["points"])
            if g["kind"] == "arrow" and g.get("preferredHeadLengthPt", g["headLengthPt"]) < g["headLengthPt"]:
                reject("arrow-head-preference")
            width = annotation["style"]["widthPt"] * max(t["scaleX"], t["scaleY"])
            if not width > 0 or ("widthPt" in g and (not g["widthPt"] * t["scaleX"] > 0 or not g["heightPt"] * t["scaleY"] > 0)):
                reject("degenerate-transform")
            values = [width]
            for point in annotation_points(annotation):
                values.extend([point["x"], point["y"]])
            if any(not math.isfinite(value) for value in values):
                reject("non-finite-geometry")
    if count > EDIT_LIMITS["pagePoints"]:
        reject("page-point-limit")


def assert_library(snapshot):
    unique([item["id"] for item in snapshot["items"]], "duplicate-item")
    unique([folder["id"] for folder in snapshot["folders"]], "duplicate-folder")
    unique([item["id"] for item in snapshot["items"] + snapshot["folders"]], "shared-catalog-id")
    unique([record["id"] for record in snapshot["deletions"]], "duplicate-deletion")
    items = {item["id"]: item for item in snapshot["items"]}
    folders = {folder["id"]: folder for folder in snapshot["folders"]}
    deleted = deleted_item_ids(snapshot)
    template_names = set()
    for item in snapshot["items"]:
        if not item["title"].strip():
            reject("empty-title")
        unique(item["tags"], "duplicate-tag")
        if item["folderId"] and item["folderId"] not in folders:
            reject("missing-folder")
        if item["ownerId"]:
            if item["folderId"] is not None:
                reject("owned-item-folder")
            owner = items.get(item["ownerId"])
            if not owner or owner["id"] == item["id"] or owner["ownerId"] or owner["metadata"].get("papeer.note-template") == "v1" or (item["id"] not in deleted and owner["id"] in deleted):
                reject("invalid-owner")
            if item["kind"] not in ("notebook", "markdown", "attachment"):
                reject("invalid-owned-kind")
        if item["kind"] == "attachment" and (not item["ownerId"] or not item.get("resourceId")):
            reject("invalid-attachment")
        if "papeer.note-template" in item["metadata"]:
            if item["metadata"]["papeer.note-template"] != "v1":
                reject("note-template-version")
            if item["kind"] != "markdown" or item["ownerId"] is not None or item["folderId"] is not None or item.get("resourceId") is not None:
                reject("note-template-kind")
            name = item["title"].strip()
            if not name or name != item["title"] or len(name) > 80 or name == "読書メモ":
                reject("note-template-name")
            if item["id"] not in deleted:
                if name in template_names:
                    reject("duplicate-note-template-name")
                template_names.add(name)
    for folder in snapshot["folders"]:
        if not folder["title"].strip():
            reject("empty-title")
        seen, parent = {folder["id"]}, folder["parentId"]
        while parent:
            if parent in seen:
                reject("folder-cycle")
            seen.add(parent)
            if parent not in folders:
                reject("missing-parent-folder")
            parent = folders[parent]["parentId"]
    unique([f"{link['pdfId']}:{link['noteId']}" for link in snapshot["links"]], "duplicate-link")
    for link in snapshot["links"]:
        pdf, note = items.get(link["pdfId"]), items.get(link["noteId"])
        if not pdf or pdf["kind"] != "pdf" or not note or note["kind"] not in ("notebook", "markdown") or note["metadata"].get("papeer.note-template") == "v1" or pdf["ownerId"] or note["ownerId"] or pdf["id"] in deleted or note["id"] in deleted:
            reject("invalid-link")
    for record in snapshot["deletions"]:
        unique(record["itemIds"], "duplicate-deleted-item")
        unique([value["targetId"] for value in record["observed"]], "duplicate-observation")
        if any(item_id not in items for item_id in record["itemIds"]):
            reject("missing-deleted-item")
        observed = {value["targetId"]: value["heads"] for value in record["observed"]}
        for item_id in record["itemIds"]:
            if items[item_id]["kind"] != "attachment" and item_id not in observed:
                reject("missing-deletion-observation")
        for observation in record["observed"]:
            if observation["targetId"] not in record["itemIds"]:
                reject("unrelated-deletion-observation")
            unique(observation["heads"], "duplicate-observed-head")


def assert_snapshot(value):
    validate_snapshot(value)
    if value["kind"] == "document":
        pages = all_document_pages(value)
        unique([page["id"] for page in pages], "duplicate-page")
        for page in pages:
            assert_page(page)
        if "translation" in value:
            translation = value["translation"]
            originals = {page["id"]: page for page in value["pages"] + value["deletedPages"]}
            translated = {page["id"]: page for page in translation["pages"] + value["deletedPages"]}
            if any(page["background"]["kind"] != "pdf" for page in translation["pages"]):
                reject("translation-pdf-required")
            unique([binding["original"]["pageId"] for binding in translation["bindings"]], "duplicate-translation-original")
            for binding in translation["bindings"]:
                if originals.get(binding["original"]["pageId"], {}).get("background", {}).get("kind") != "pdf":
                    reject("translation-original-missing")
                unique([candidate["pageId"] for candidate in binding["candidates"]], "duplicate-translation-candidate")
                if any(translated.get(candidate["pageId"], {}).get("background", {}).get("kind") != "pdf" for candidate in binding["candidates"]):
                    reject("translation-page-missing")
    elif value["kind"] == "library":
        assert_library(value)
    else:
        unique(value["appendIds"], "duplicate-append")
        unique([image["resourceId"] for image in value["imageResources"]], "duplicate-markdown-image")


def assert_batch(value):
    validate_editbatch(value)
    unique(value["parents"], "duplicate-parent")
    if value["kind"] == "markdown":
        unique([image["resourceId"] for image in value["imageResources"]], "duplicate-markdown-image")
    if value["id"] in value["parents"]:
        reject("self-parent")
    if value["kind"] == "library" and value["targetId"] != value["libraryId"]:
        reject("library-target")


def active_document_pages(snapshot):
    return snapshot["pages"] + snapshot.get("translation", {}).get("pages", [])


def all_document_pages(snapshot):
    return active_document_pages(snapshot) + snapshot["deletedPages"]


def expected_page(snapshot, expected):
    page = next((page for page in active_document_pages(snapshot) if page["id"] == expected["pageId"]), None)
    if not page or any(page[field] != expected[field] for field in ("annotationVersion", "backgroundRevision", "lifecycleVersion")):
        reject("stale-page")
    return page


def apply_translation(parent, change, version):
    if change["expectedRevision"] != parent.get("translation", {}).get("revision"):
        reject("stale-translation")
    deleted, previous, pages = deepcopy(parent["deletedPages"]), parent.get("translation", {}).get("pages", []), []
    def content(page):
        return {**page, "lifecycleVersion": "", "annotationVersion": ""}
    translation = change["translation"]
    for page in translation["pages"] if translation else []:
        if any(original["id"] == page["id"] for original in parent["pages"]):
            reject("translation-page-reused")
        old = next((value for value in previous if value["id"] == page["id"]), None)
        tombstone = next((value for value in deleted if value["id"] == page["id"]), None)
        if old and old != page or tombstone and content(tombstone) != content(page):
            reject("translation-page-reused")
        pages.append(deepcopy(old) if old else {**deepcopy(page), "lifecycleVersion": version, "annotationVersion": version})
        if tombstone:
            deleted.remove(tombstone)
    deleted.extend({**deepcopy(old), "lifecycleVersion": version} for old in previous if not any(page["id"] == old["id"] for page in pages))
    result = {**deepcopy(parent), "version": version, "deletedPages": deleted}
    result.pop("translation", None)
    if translation:
        result["translation"] = {"revision": version, "pages": pages, "bindings": deepcopy(translation["bindings"])}
    return result


def apply_batch(parent, batch):
    # The public function owns its result; graph internals instead share frozen values.
    assert_snapshot(parent)
    return deepcopy(_apply_batch(_freeze(parent), _freeze(batch)))


def _apply_batch(parent, batch) -> _FrozenDict:
    assert_batch(batch)
    if batch["targetId"] != parent["id"] or parent["version"] not in batch["parents"]:
        reject("wrong-parent")
    kind = batch["kind"]
    result = dict(parent)
    result["version"] = batch["id"]
    if kind == "resolution":
        result = deepcopy(batch["snapshot"])
        if result["id"] != parent["id"] or result["kind"] != parent["kind"] or result["version"] != batch["id"]:
            reject("resolution-target")
        if result["kind"] == "document":
            for page in all_document_pages(result):
                page["annotationVersion"] = batch["id"]
    elif kind == "page":
        if parent["kind"] != "document":
            reject("target-kind")
        old_page = expected_page(parent, batch["expected"])
        page = dict(old_page)
        result["pages"] = [page if value["id"] == page["id"] else value for value in parent["pages"]]
        if "translation" in parent:
            result["translation"] = {**parent["translation"], "pages": [page if value["id"] == page["id"] else value for value in parent["translation"]["pages"]]}
        annotations = {annotation["id"]: annotation for annotation in page["annotations"]}
        unique(["$order" if change["type"] == "order" else change["id"] if change["type"] == "delete" else change["annotation"]["id"] for change in batch["changes"]], "duplicate-change-target")
        order = None
        for change in batch["changes"]:
            if change["type"] == "order":
                order = change["ids"]
                continue
            item_id = change["id"] if change["type"] == "delete" else change["annotation"]["id"]
            if (change["type"] == "create") == (item_id in annotations):
                reject("annotation-existence")
            if change["type"] == "delete":
                del annotations[item_id]
            else:
                annotation = change["annotation"]
                assert_page({**old_page, "annotations": [annotation]})
                annotations[item_id] = annotation
        if order is not None and (len(set(order)) != len(annotations) or len(order) != len(annotations) or any(key not in annotations for key in order)):
            reject("annotation-order")
        page["annotations"] = [annotations[key] for key in order] if order is not None else list(annotations.values())
        page["annotationVersion"] = batch["id"]
        if len(annotations) > 3000:
            reject("annotation-limit")
        if sum(len(a["geometry"]["points"]) for a in annotations.values() if a["kind"] == "ink" and a["geometry"]["kind"] == "path") > EDIT_LIMITS["pagePoints"]:
            reject("page-point-limit")
    elif kind == "document":
        if parent["kind"] != "document":
            reject("target-kind")
        result["pages"], result["deletedPages"] = list(parent["pages"]), list(parent["deletedPages"])
        if "translation" in parent:
            result["translation"] = {**parent["translation"], "pages": list(parent["translation"]["pages"])}
        mapping_change = next((change for change in batch["changes"] if change["type"] == "translation"), None)
        if mapping_change:
            if len(batch["changes"]) != 1:
                reject("translation-command-alone")
            result = apply_translation(parent, mapping_change, batch["id"])
        mappings = [change for change in batch["changes"] if change["type"] == "mapping"]
        if len(mappings) > 1:
            reject("duplicate-mapping-change")
        if mappings and ("translation" not in parent or mappings[0]["expectedRevision"] != parent["translation"]["revision"]):
            reject("stale-translation")
        if mappings:
            result["translation"]["revision"] = batch["id"]
            result["translation"]["bindings"] = deepcopy(mappings[0]["bindings"])
        changes = [] if mapping_change else [change for change in batch["changes"] if change["type"] != "mapping"]
        primary, deleted = result["pages"], result["deletedPages"]
        translated = result.get("translation", {}).get("pages")
        unique([change["page"]["id"] if change["type"] == "insert" else change["expected"]["pageId"] for change in changes], "duplicate-change-page")
        for change in changes:
            if change["type"] == "insert":
                pages = translated if change.get("collection") == "translation" else primary
                if pages is None or any(page["id"] == change["page"]["id"] for page in active_document_pages(parent)) or change["index"] > len(pages):
                    reject("insert-page")
                deleted[:] = [page for page in deleted if page["id"] != change["page"]["id"]]
                page = deepcopy(change["page"])
                for field in ("lifecycleVersion", "annotationVersion"):
                    page[field] = batch["id"]
                pages.insert(change["index"], page)
            else:
                expected_page(parent, change["expected"])
                pages = primary if any(page["id"] == change["expected"]["pageId"] for page in primary) else translated or []
                index = next((i for i, page in enumerate(pages) if page["id"] == change["expected"]["pageId"]), -1)
                if index < 0:
                    reject("missing-page")
                if change["type"] == "remove":
                    page = dict(pages.pop(index))
                    page["lifecycleVersion"] = batch["id"]
                    deleted.append(page)
                elif change["type"] == "move":
                    if change["index"] >= len(pages):
                        reject("move-page")
                    pages.insert(change["index"], pages.pop(index))
                else:
                    if change["page"]["id"] != change["expected"]["pageId"]:
                        reject("replace-page-id")
                    old, page = pages[index], deepcopy(change["page"])
                    changed = old["background"] != page["background"] or old["widthPt"] != page["widthPt"] or old["heightPt"] != page["heightPt"]
                    page["lifecycleVersion"] = old["lifecycleVersion"]
                    page["annotationVersion"] = batch["id"]
                    page["backgroundRevision"] = batch["id"] if changed else old["backgroundRevision"]
                    pages[index] = page
    elif kind == "markdown":
        if parent["kind"] != "markdown":
            reject("target-kind")
        if batch.get("appendId") in parent["appendIds"]:
            reject("append-already-applied")
        result["content"] = batch["content"]
        result["imageResources"] = deepcopy(batch["imageResources"])
        if "appendId" in batch:
            result["appendIds"] = [*parent["appendIds"], batch["appendId"]]
    elif kind == "library":
        if parent["kind"] != "library":
            reject("target-kind")
        items = {item["id"]: item for item in result["items"]}
        folders = {folder["id"]: folder for folder in result["folders"]}
        links = {f"{link['pdfId']}:{link['noteId']}": link for link in result["links"]}
        deletions = {record["id"]: record for record in result["deletions"]}
        keys = []
        for change in batch["changes"]:
            action = change["type"]
            if action == "put-item":
                item = deepcopy(change["item"])
                old = items.get(item["id"])
                if old and (old["kind"] != item["kind"] or old.get("resourceId") != item.get("resourceId")):
                    reject("catalog-content-rebind")
                if old and (old["metadata"].get("papeer.note-template") == "v1") != (item["metadata"].get("papeer.note-template") == "v1"):
                    reject("note-template-role-rebind")
                items[item["id"]] = item
                keys.append(f"item:{item['id']}")
            elif action == "put-folder":
                folder = deepcopy(change["folder"])
                folders[folder["id"]] = folder
                keys.append(f"folder:{folder['id']}")
            elif action == "remove-folder":
                if change["id"] not in folders:
                    reject("missing-folder")
                del folders[change["id"]]
                keys.append(f"folder:{change['id']}")
            elif action == "put-deletion":
                record = deepcopy(change["deletion"])
                old = deletions.get(record["id"])
                if old and {**record, "active": old["active"]} != old:
                    reject("catalog-history-loss")
                deletions[record["id"]] = record
                keys.append(f"deletion:{record['id']}")
            else:
                link = change["link"]
                key = f"{link['pdfId']}:{link['noteId']}"
                keys.append(f"link:{key}")
                if action == "add-link":
                    if key in links:
                        reject("duplicate-link")
                    links[key] = deepcopy(link)
                elif key not in links:
                    reject("missing-link")
                else:
                    del links[key]
        unique(keys, "duplicate-catalog-change")
        result.update(items=list(items.values()), folders=list(folders.values()), links=list(links.values()), deletions=list(deletions.values()))
    # A page command changes only its validated annotation delta and version. The
    # frozen parent already passed schema, page, and translation checks.
    if kind != "page":
        assert_snapshot(result)
    frozen = _freeze(result)
    assert isinstance(frozen, _FrozenDict)
    return frozen


class _GraphStates(Mapping[str, _FrozenDict]):
    """Known versions with bounded materializations, not one full array per edit.

    Objects/pages are immutable and shared. Old versions are rebuilt iteratively
    from the closest cached ancestor when needed (including late branch parents).
    """
    def __init__(self, root: _FrozenDict, nodes, previous: _GraphStates | None = None):
        self.root, self.nodes = root, nodes
        self.known = dict.fromkeys(previous.known if previous else [root["version"]])
        self.cache: OrderedDict[str, _FrozenDict] = OrderedDict(previous.cache if previous else {root["version"]: root})

    def __iter__(self):
        return iter(self.known)

    def __len__(self):
        return len(self.known)

    def __contains__(self, version):
        return version in self.known

    def put(self, version: str, snapshot: _FrozenDict):
        self.known[version] = None
        self.cache[version] = snapshot
        self.cache.move_to_end(version)
        while len(self.cache) > 16:
            self.cache.popitem(last=False)

    def __getitem__(self, version: str) -> _FrozenDict:
        if version not in self.known:
            raise KeyError(version)
        path, current = [], version
        while current not in self.cache and current != self.root["version"]:
            path.append(current)
            current = self.nodes[current]["parents"][0]
        snapshot = self.cache.get(current, self.root)
        for node_id in reversed(path):
            snapshot = _apply_batch(snapshot, self.nodes[node_id])
            self.put(node_id, snapshot)
        return snapshot


class EditGraph:
    def __init__(self, checkpoint):
        if checkpoint["version"] != 1:
            reject("checkpoint-version")
        assert_snapshot(checkpoint["root"])
        root = _freeze(checkpoint["root"])
        assert isinstance(root, _FrozenDict)
        self.root = root
        self.library_id = checkpoint["libraryId"]
        self.nodes = {}
        self.states = _GraphStates(self.root, self.nodes)
        self.view = {}
        self.receive(checkpoint["batches"])

    def receive(self, batches):
        nodes = dict(self.nodes)
        for batch in batches:
            assert_batch(batch)
            if batch["libraryId"] != self.library_id or batch["targetId"] != self.root["id"] or batch["id"] == self.root["version"]:
                reject("batch-scope")
            if batch["id"] in nodes and nodes[batch["id"]] != batch:
                reject("batch-id-reused")
            nodes[batch["id"]] = _freeze(batch)
        children, degree = {}, {}
        for node_id, node in nodes.items():
            degree[node_id] = sum(parent_id in nodes for parent_id in node["parents"])
            for parent_id in node["parents"]:
                children.setdefault(parent_id, []).append(node_id)
        ready = [node_id for node_id, count in degree.items() if not count]
        ordered = []
        for node_id in ready:
            ordered.append(node_id)
            for child in children.get(node_id, []):
                degree[child] -= 1
                if not degree[child]:
                    ready.append(child)
        if len(ordered) != len(nodes):
            reject("parent-cycle")
        states = _GraphStates(self.root, nodes, self.states)
        pending = {node_id: nodes[node_id] for node_id in ordered}
        rejected = {}
        for node_id, batch in list(pending.items()):
            if node_id in states:
                del pending[node_id]
                continue
            if any(parent in rejected for parent in batch["parents"]):
                rejected[node_id] = "rejected-parent"
            elif not all(parent in states for parent in batch["parents"]):
                continue
            else:
                try:
                    parent = states[batch["parents"][0]]
                    if any(states[node_id]["kind"] != parent["kind"] for node_id in batch["parents"]):
                        reject("resolution-parent-kind")
                    states.put(node_id, _apply_batch(parent, batch))
                except ValueError as exc:
                    rejected[node_id] = str(exc)
            del pending[node_id]
        heads = set(states)
        for node_id, batch in nodes.items():
            if node_id in states:
                heads.difference_update(batch["parents"])
        self.nodes, self.states = nodes, states
        self.view = {"heads": sorted(heads), "waiting": sorted(pending), "rejected": rejected}

    def assert_local(self, batch):
        assert_batch(batch)
        if batch["kind"] == "resolution" and sorted(batch["parents"]) != self.view["heads"]:
            reject("heads-changed")
        if any(parent not in self.states for parent in batch["parents"]):
            reject("missing-local-parent")

    def checkpoint(self):
        return {"version": 1, "libraryId": self.library_id, "root": deepcopy(self.root), "batches": deepcopy(list(self.nodes.values()))}

    def descends_from(self, head, ancestor):
        pending, seen = [head], set()
        while pending:
            node_id = pending.pop()
            if node_id == ancestor:
                return node_id in self.states
            if node_id in seen:
                continue
            seen.add(node_id)
            pending.extend(self.nodes.get(node_id, {}).get("parents", []))
        return False
