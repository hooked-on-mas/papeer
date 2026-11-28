"""Build readable, deterministic wire fixtures used by both edit implementations."""
from copy import deepcopy
import json
import hashlib
from pathlib import Path
import sys
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def identity(value):
    return f"00000000-0000-0000-0000-{value:012d}"


def coordinate_pdf():
    """Deterministic tiny PDF: offset CropBox, every Rotate, UserUnit and fractional boxes."""
    specs = [(0, '1.5', '[40 60 580 760]'), (90, '2', '[40 60 580 760]'),
             (180, '1.25', '[40 60 580 760]'), (270, '1.75', '[40 60 580 760]'),
             (0, '1.333333', '[41.137 62.523 581.115 761.203]')]
    content_id = len(specs) + 3
    objects = ['<< /Type /Catalog /Pages 2 0 R >>',
               f'<< /Type /Pages /Count {len(specs)} /Kids [' + ' '.join(f'{i + 3} 0 R' for i in range(len(specs))) + '] >>']
    objects.extend(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 800] /CropBox {crop} /Rotate {rotate} /UserUnit {unit} /Resources << >> /Contents {content_id} 0 R >>'
                   for rotate, unit, crop in specs)
    objects.append('<< /Length 0 >>\nstream\nendstream')
    data, offsets = bytearray(b'%PDF-1.7\n'), []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f'{number} 0 obj\n{obj}\nendobj\n'.encode('ascii'))
    start = len(data)
    data.extend(f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode('ascii'))
    for offset in offsets:
        data.extend(f'{offset:010d} 00000 n \n'.encode('ascii'))
    data.extend(f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode('ascii'))
    return bytes(data)


def main():
    from papeer.core.edits.datasets import checkpoint_hash
    from papeer.core.edit_content_hash import edit_content_hash
    library, document, p1, p2, markdown = map(identity, [1, 2, 3, 4, 5])
    def page(value):
        return {"id": identity(value), "backgroundRevision": identity(100), "lifecycleVersion": identity(100), "annotationVersion": identity(100),
                "widthPt": 612, "heightPt": 792, "background": {"kind": "paper", "spec": {"template": "blank", "color": "white"}}, "annotations": []}
    root = {"kind": "document", "id": document, "version": identity(100), "pages": [page(3), page(4)], "deletedPages": []}
    expected = {"pageId": p1, "backgroundRevision": identity(100), "lifecycleVersion": identity(100), "annotationVersion": identity(100)}
    ink = {"kind": "ink", "id": identity(401), "geometry": {"kind": "rect", "widthPt": 60, "heightPt": 40},
           "style": {"color": "#dc2626", "widthPt": 2, "opacity": 1, "highlighter": False},
           "transform": {"x": 20, "y": 30, "rotationRad": 0, "scaleX": 1, "scaleY": 1}}
    def envelope(kind, number, target, parents):
        return {"kind": kind, "id": identity(number), "libraryId": library, "targetId": target, "parents": list(map(identity, parents))}
    a = {**envelope("page", 201, document, [100]), "expected": expected, "changes": [{"type": "create", "annotation": ink}]}
    ink2 = deepcopy(ink); ink2["transform"]["x"] = 90
    a2 = {**envelope("page", 202, document, [201]), "expected": {**expected, "annotationVersion": identity(201)}, "changes": [{"type": "update", "annotation": ink2}]}
    b = {**envelope("document", 203, document, [100]), "changes": [{"type": "remove", "expected": expected}]}
    b2 = {**envelope("page", 204, document, [203]), "expected": {**expected, "pageId": p2}, "changes": [{"type": "create", "annotation": ink}]}
    c = {**envelope("page", 205, document, [100]), "expected": {**expected, "pageId": p2}, "changes": [{"type": "create", "annotation": ink}]}
    resolved = deepcopy(root); resolved["version"] = identity(206)
    resolved["pages"][0]["annotations"] = [ink2]; resolved["pages"][0]["annotationVersion"] = identity(202)
    resolution = {**envelope("resolution", 206, document, [202, 204]), "snapshot": resolved}
    resolution2 = deepcopy(resolution); resolution2["id"] = identity(207); resolution2["snapshot"]["version"] = identity(207)
    resolution2["snapshot"]["pages"][0]["annotations"][0]["style"]["color"] = "#000000"
    md = {"kind": "markdown", "imageResources": [], "id": markdown, "version": identity(120), "content": "base", "appendIds": []}
    md1 = {**envelope("markdown", 501, markdown, [120]), "imageResources": [], "content": "local", "appendId": identity(550)}
    md2 = {**envelope("markdown", 502, markdown, [120]), "imageResources": [], "content": "remote"}
    def item(value, kind, owner=None):
        return {"id": identity(value), "kind": kind, "title": "𠮷" * 200, "ownerId": owner, "folderId": None, "position": 0, "tags": [], "read": False, "metadata": {}}
    catalog = {"kind": "library", "id": library, "version": identity(110), "items": [item(2, "pdf"), item(5, "markdown", document)], "folders": [], "links": [], "deletions": []}
    deletion = {"id": identity(351), "itemIds": [document, markdown], "observed": [{"targetId": document, "heads": [identity(100)]}, {"targetId": markdown, "heads": [identity(120)]}], "active": True}
    deleted = {**envelope("library", 301, library, [110]), "changes": [{"type": "put-deletion", "deletion": deletion}]}
    restored = deepcopy(deleted); restored["id"] = identity(302); restored["parents"] = [identity(301)]; restored["changes"][0]["deletion"]["active"] = False
    invalid = []
    for label, edit in [("empty-text-box", a), ("degenerate-line", a), ("duplicate-object", a), ("stale-page", a)]:
        edit = deepcopy(edit)
        if label == "empty-text-box":
            edit["changes"][0]["annotation"]["geometry"] = {"kind": "text", "widthPt": 0, "heightPt": 20, "text": "hello", "fontSizePt": 12, "fontFamily": "sans-serif"}
        elif label == "degenerate-line":
            edit["changes"][0]["annotation"]["geometry"] = {"kind": "line", "start": {"x": 0, "y": 0}, "end": {"x": 0, "y": 0}}
        elif label == "duplicate-object":
            edit["changes"].append(deepcopy(edit["changes"][0]))
        else:
            edit["expected"]["backgroundRevision"] = identity(999)
        invalid.append({"name": label, "root": root, "batch": edit})
    too_long = {**envelope("library", 303, library, [110]), "changes": [{"type": "put-item", "item": deepcopy(catalog["items"][0])}]}
    too_long["changes"][0]["item"]["title"] += "𠮷"
    invalid.append({"name": "unicode-title-limit", "root": catalog, "batch": too_long})
    whitespace = deepcopy(too_long); whitespace["changes"][0]["item"]["title"] = "\u0085"
    invalid.append({"name": "python-whitespace-title", "root": catalog, "batch": whitespace})
    ownership_root = deepcopy(catalog)
    ownership_root["folders"] = [{"id": identity(8100), "title": "Before", "parentId": None, "position": 0},
                                 {"id": identity(8101), "title": "After", "parentId": None, "position": 1}]
    ownership_root["items"][0]["folderId"] = identity(8100)
    attachment = {**item(8102, "attachment", document), "resourceId": identity(8103)}
    ownership_root["items"].append(attachment)
    for kind, child in [("markdown", ownership_root["items"][1]), ("attachment", attachment)]:
        bad_child = {**deepcopy(child), "folderId": identity(8100)}
        bad = {**envelope("library", 8110 if kind == "markdown" else 8111, library, [110]),
               "changes": [{"type": "put-item", "item": bad_child}]}
        invalid.append({"name": f"owned-{kind}-folder", "root": ownership_root, "batch": bad})
    bad_deleted = deepcopy(invalid[-2]["batch"])
    bad_deleted["id"] = identity(8112)
    bad_deleted["changes"].append({"type": "put-deletion", "deletion": {"id": identity(8113), "itemIds": [markdown],
                                "observed": [{"targetId": markdown, "heads": [identity(120)]}], "active": True}})
    invalid.append({"name": "deleted-owned-folder", "root": ownership_root, "batch": bad_deleted})
    owner_move = {**envelope("library", 8120, library, [110]),
                  "changes": [{"type": "put-item", "item": {**deepcopy(ownership_root["items"][0]), "folderId": identity(8101)}}]}
    note_detach = {**envelope("library", 8121, library, [8120]),
                   "changes": [{"type": "put-item", "item": {**deepcopy(ownership_root["items"][1]), "ownerId": None, "folderId": identity(8101), "position": 1}}]}
    underflow = deepcopy(a); underflow["changes"][0]["annotation"]["geometry"]["widthPt"] = 1e-300
    underflow["changes"][0]["annotation"]["transform"]["scaleX"] = 1e-300
    invalid.append({"name": "transformed-size-underflow", "root": root, "batch": underflow})
    overflow = deepcopy(a); overflow["changes"][0]["annotation"]["geometry"]["widthPt"] = 1e308
    overflow["changes"][0]["annotation"]["transform"]["scaleX"] = 4
    invalid.append({"name": "transformed-size-overflow", "root": root, "batch": overflow})
    source = Path(__file__).resolve().parents[1] / "tests/fixtures/shared-coordinate-pages.pdf"
    source.write_bytes(coordinate_pdf())
    with pymupdf.open(source) as pdf:
        pdf_pages = [{"widthPt": p.rect.width, "heightPt": p.rect.height} for p in pdf]
    resource = {"id": identity(700), "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "mediaType": "application/pdf",
                "byteLength": source.stat().st_size, "pdfPages": pdf_pages}
    publications = []
    for number, kind in [(710, "pdf"), (720, "notebook"), (730, "markdown"), (740, "attachment")]:
        created = item(number, kind, document if kind == "attachment" else None)
        created["title"] = kind + " created atomically"
        if kind in {"pdf", "attachment"}:
            created["resourceId"] = resource["id"]
        publication = {"libraryBatch": {**envelope("library", number + 1, library, [110]), "changes": [{"type": "put-item", "item": created}]}}
        if kind == "markdown":
            publication["content"] = {"kind": "markdown", "imageResources": [], "id": created["id"], "version": identity(number + 2), "content": "initial content", "appendIds": []}
        elif kind in {"pdf", "notebook"}:
            initial = page(number + 3)
            initial.update({field: identity(number + 2) for field in ["backgroundRevision", "lifecycleVersion", "annotationVersion"]})
            if kind == "pdf":
                initial.update(pdf_pages[0])
                initial["background"] = {"kind": "pdf", "resourceId": resource["id"], "sourceRevision": resource["sha256"], "pdfPage": 1}
            publication["content"] = {"kind": "document", "id": created["id"], "version": identity(number + 2), "pages": [initial], "deletedPages": []}
            if kind == "notebook":
                publication["libraryBatch"]["changes"].append({"type": "add-link", "link": {"pdfId": document, "noteId": created["id"]}})
        publications.append({"name": kind, "value": publication})
    invalid_publications = []
    def invalid_publication(name, index, change):
        value = deepcopy(publications[index]["value"])
        change(value)
        invalid_publications.append({"name": name, "value": value})
    invalid_publication("missing-content", 2, lambda value: value.pop("content"))
    invalid_publication("wrong-content-id", 2, lambda value: value["content"].update(id=identity(999)))
    invalid_publication("extra-item", 2, lambda value: value["libraryBatch"]["changes"].append({"type": "put-item", "item": item(999, "markdown")}))
    invalid_publication("missing-pdf-resource", 0, lambda value: value["libraryBatch"]["changes"][0]["item"].pop("resourceId"))
    invalid_publication("attachment-has-content", 3, lambda value: value.update(content=deepcopy(md)))
    initial_publication = publications[0]["value"]
    initial_batch = initial_publication["libraryBatch"]
    checkpoint = {"version": 1, "libraryId": library,
                  "roots": sorted([root, md, catalog, initial_publication["content"]], key=lambda value: value["id"]),
                  "edits": sorted([{"batch": a}, {"batch": b2}, {"batch": initial_batch, "publication": initial_publication,
                                     "history": {"operationId": initial_batch["id"], "beforeVersion": initial_batch["parents"][0],
                                                 "afterVersion": initial_batch["id"], "undoRequested": False}}], key=lambda value: value["batch"]["id"])}
    dataset_manifest = {"version": 1, "id": identity(9950), "scope": {"accountId": "fixture", "libraryId": library, "epoch": "dataset"},
                        "checkpointSha256": checkpoint_hash(checkpoint), "resources": [resource]}
    content_hashes = [{"value": value, "sha256": edit_content_hash(value)} for value in [None, False, True, 0, -0.0, 1.0, 1e-7, 1e21,
                      5e-324, 1.7976931348623157e308, {"😀": "𠮷", "\ue000": "e\u0301", "a": "é"}, ["", "a", "a\u0000b", {}, []]]]
    def pdf_page(number, physical):
        value = page(number)
        value.update(pdf_pages[physical - 1])
        value.update({key: identity(910) for key in ["backgroundRevision", "lifecycleVersion", "annotationVersion"]})
        value["background"] = {"kind": "pdf", "resourceId": resource["id"], "sourceRevision": resource["sha256"], "pdfPage": physical}
        return value
    primary, parallel = [pdf_page(901 + i, i + 1) for i in range(3)], [pdf_page(904 + i, i + 4) for i in range(2)]
    def binding(original, translated):
        return {"original": {"pageId": original["id"], "backgroundRevision": original["backgroundRevision"]},
                "candidates": [{"pageId": translated["id"], "backgroundRevision": translated["backgroundRevision"]}]}
    translation_root = {"kind": "document", "id": identity(900), "version": identity(910), "pages": primary, "deletedPages": [],
                        "translation": {"revision": identity(910), "pages": parallel, "bindings": [binding(primary[0], parallel[0]), binding(primary[2], parallel[1])]}}
    translated_ink = {**envelope("page", 920, identity(900), [910]),
                      "expected": {"pageId": parallel[0]["id"], **{key: parallel[0][key] for key in ["backgroundRevision", "lifecycleVersion", "annotationVersion"]}},
                      "changes": [{"type": "create", "annotation": ink}]}
    replacement = pdf_page(906, 4)
    replacement["backgroundRevision"] = identity(930)
    translation_update = {**envelope("document", 930, identity(900), [920]), "changes": [{"type": "translation", "expectedRevision": identity(910),
                          "translation": {"pages": [replacement, parallel[1]], "bindings": [binding(primary[0], replacement), binding(primary[2], parallel[1])]}}]}
    request = {"batch": a, "history": {"operationId": a["id"], "beforeVersion": root["version"], "afterVersion": a["id"], "undoRequested": False}}
    inverse = {"batch": {**envelope("page", 9910, document, [201]), "expected": {**expected, "annotationVersion": a["id"]},
                         "changes": [{"type": "delete", "id": ink["id"]}]},
               "history": {"operationId": identity(9910), "beforeVersion": a["id"], "afterVersion": identity(9910), "undoRequested": False,
                           "action": {"kind": "undo", "operationId": a["id"]}}}
    redo = {"batch": {**envelope("page", 9911, document, [9910]), "expected": {**expected, "annotationVersion": identity(9910)},
                      "changes": [{"type": "create", "annotation": ink}, {"type": "order", "ids": [ink["id"]]}]},
            "history": {"operationId": identity(9911), "beforeVersion": identity(9910), "afterVersion": identity(9911), "undoRequested": False,
                        "action": {"kind": "redo", "operationId": a["id"]}}}
    intents = [{"id": identity(9900 + index), "intent": {"request": deepcopy(request), "dispatched": index > 0, "undoRequested": index > 1,
                **({"inverse": inverse} if index == 3 else {})}} for index in range(4)]
    publication_plan = {"manifest": dataset_manifest, "checkpoint": checkpoint, "checkpointObjectId": identity(9951)}
    next_manifest = {**deepcopy(dataset_manifest), "id": identity(9953), "scope": {**dataset_manifest["scope"], "epoch": "dataset-next"}}
    rotation_plan = {"manifest": next_manifest, "checkpoint": checkpoint, "checkpointObjectId": identity(9954)}
    def control_records(plan, run_id, first_id, source, epochs):
        return [{"version": 1, "id": identity(first_id + index), "identity": {"accountId": "fixture", "libraryId": library}, "epochs": epochs,
                 "active": plan["manifest"] if phase == "activated" else source,
                 "transition": {"id": identity(run_id), "mode": "publish", "source": source, "publication": plan, "phase": phase}}
                for index, phase in enumerate(["prepared", "published", "activated", "rolled-back"])]
    control_fixture = {"initial": control_records(publication_plan, 9952, 9960, None, ["dataset"]),
                       "rotation": control_records(rotation_plan, 9955, 9970, dataset_manifest, ["dataset", "dataset-next"])}
    sticky = {"kind": "sticky", "id": identity(410), "text": "追記\n😀", "quote": "引用文", "anchor": {"x": 30, "y": 45},
              "color": None, "metadata": {"label": "重要", "createdAt": "2024-02-29T12:34:56Z"}}
    highlight = {"kind": "highlight", "id": identity(411), "text": "コメント", "quote": "選択した文章", "anchor": {"x": 15, "y": 35},
                 "backgroundRevision": root["pages"][0]["backgroundRevision"], "range": {"kind": "indexed", "start": 0, "end": 7},
                 "color": "#facc15", "quads": [[{"x": 20, "y": 30}, {"x": 120, "y": 30}, {"x": 120, "y": 50}, {"x": 20, "y": 50}]],
                 "metadata": {"label": "分類😀", "createdAt": "2026-10-25T12:34:56.123456Z"}}
    annotations = {"valid": [sticky, {**deepcopy(sticky), "color": "#123456", "metadata": {"label": "", "createdAt": None}},
                             highlight, {**deepcopy(highlight), "range": {"kind": "unindexed"}}], "invalid": []}
    def invalid_annotation(name, annotation, change):
        value = deepcopy(annotation)
        change(value)
        annotations["invalid"].append({"name": name, "annotation": value})
    for value in ["1900-02-29T00:00:00Z", "2025-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "0000-01-01T00:00:00Z",
                  "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-00T00:00:00Z", "2026-10-25T24:00:00Z",
                  "2026-10-25T12:60:00Z", "2026-10-25T12:34:60Z", "2026-10-25T12:34:56Z\n", "2026-10-25 12:34:56",
                  "2026-10-25T12:34:56+00:00", "2026-10-25T12:34:56.1234567Z"]:
        invalid_annotation("timestamp:" + repr(value), sticky, lambda annotation, time=value: annotation["metadata"].update(createdAt=time))
    invalid_annotation("metadata-label-limit", sticky, lambda annotation: annotation["metadata"].update(label="😀" * 41))
    invalid_annotation("metadata-missing", sticky, lambda annotation: annotation.pop("metadata"))
    invalid_annotation("highlight-reversed-range", highlight, lambda annotation: annotation["range"].update(start=8))
    invalid_annotation("unindexed-does-not-have-fabricated-offsets", highlight, lambda annotation: annotation["range"].update(kind="unindexed"))
    invalid_annotation("highlight-stale-background", highlight, lambda annotation: annotation.update(backgroundRevision=identity(999)))
    invalid_annotation("highlight-degenerate-quad", highlight, lambda annotation: annotation.update(quads=[[{"x": 0, "y": 0}] * 4]))
    invalid_annotation("highlight-old-flat-range", highlight, lambda annotation: (annotation.pop("range"), annotation.update(start=0, end=7)))
    invalid_annotation("annotation-id-trailing-newline", sticky, lambda annotation: annotation.update(id=annotation["id"] + "\n"))
    invalid_annotation("highlight-color-trailing-newline", highlight, lambda annotation: annotation.update(color=annotation["color"] + "\n"))
    invalid_annotation("highlight-background-id-trailing-newline", highlight, lambda annotation: annotation.update(backgroundRevision=annotation["backgroundRevision"] + "\n"))
    import base64
    backup_inputs = [(key, value.encode("utf-8")) for key, value in [([".notebook-change.json"], '{"pending":true}'),
                     (["drafts", "a"], "未送信"), (["drafts", "😀"], "broken\u0000draft"), (["drafts", "\ue000"], ""),
                     (["library.sqlite3-wal"], "raw WAL bytes"), (["papers", "古い", "original.pdf"], "%PDF-synthetic")]]
    backup_entries = sorted([{"key": key, "sha256": hashlib.sha256(value).hexdigest(), "byteLength": len(value)} for key, value in backup_inputs], key=lambda entry: entry["key"])
    backup_manifest = {"version": 1, "id": identity(9980), "source": {"kind": "desktop-library", "id": "frozen-fixture"},
                       "entries": backup_entries, "containers": [["drafts"], ["empty"], ["papers"], ["papers", "古い"]]}
    backup_manifest["inventorySha256"] = edit_content_hash({key: backup_manifest[key] for key in ("source", "entries", "containers")})
    backup_fixture = {"plan": {"manifest": backup_manifest, "observationSha256": edit_content_hash(["fixture-observation-v1", 1])},
                      "bodies": [{"sha256": hashlib.sha256(value).hexdigest(), "dataBase64": base64.b64encode(value).decode()} for _, value in backup_inputs]}
    image_bytes = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=")
    image_metadata = {"id": identity(800), "sha256": hashlib.sha256(image_bytes).hexdigest(), "mediaType": "image/png", "byteLength": len(image_bytes)}
    image_binding = {"resourceId": image_metadata["id"], "sha256": image_metadata["sha256"]}
    image_batch = {**envelope("markdown", 801, markdown, [120]), "content": "![image](papeer://resource/" + image_metadata["id"] + "?sha256=" + image_metadata["sha256"] + ")", "imageResources": [image_binding]}
    image_fixture = {"bytesBase64": base64.b64encode(image_bytes).decode("ascii"), "metadata": image_metadata,
                     "batch": image_batch, "remove": {**envelope("markdown", 802, markdown, [801]), "content": "image removed", "imageResources": []},
                     "mediaTypes": [{"value": value, "valid": valid} for value, valid in [
                         ("image/png", True), ("image/jpeg", True), ("image/webp", True), ("image/svg+xml", True), ("IMAGE/PNG", True),
                         ("image/*", False), ("image/", False), ("image/png; charset=utf-8", False), ("text/html", False), ("image/png\n", False), ("image/K", False)]]}
    path = Path(__file__).resolve().parents[1] / "tests/fixtures/shared-edits.json"
    path.write_text(json.dumps({"libraryId": library, "document": root, "markdown": md, "library": catalog,
                                "batches": [a, a2, b, b2, c, resolution, resolution2, md1, md2, deleted, restored], "invalid": invalid,
                                "ownership": {"root": ownership_root, "move": owner_move, "detach": note_detach},
                                "resource": {"file": source.name, "metadata": resource}, "publications": publications, "markdownImages": image_fixture,
                                "invalidPublications": invalid_publications, "checkpoint": checkpoint,
                                "translation": {"root": translation_root, "batches": [translated_ink, translation_update]}, "intents": intents,
                                "editRecords": [request, inverse, redo], "datasetManifest": dataset_manifest,
                                "contentHashes": content_hashes, "datasetControls": control_fixture, "annotations": annotations,
                                "legacyBackup": backup_fixture,
                                "legacyMigrationInputs": migration_input_fixture(backup_fixture),
                                "legacyMigrationHolds": [{"valid": True, "value": {"version": 1, "runId": identity(9981)}},
                                    {"valid": False, "value": {"version": True, "runId": identity(9981)}},
                                    {"valid": False, "value": {"version": 1, "runId": identity(9981) + "\n"}},
                                    {"valid": False, "value": {"version": 1}},
                                    {"valid": False, "value": {"version": 2, "runId": identity(9981)}},
                                    {"valid": False, "value": {"version": 1, "runId": identity(9981), "autoRelease": True}},
                                    {"valid": False, "value": None}]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    build_legacy_drive_fixture()


def build_legacy_drive_fixture():
    """Raw source catalog shared by native HTTP and browser migration acceptance; no real Drive I/O."""
    import base64
    root = Path(__file__).resolve().parents[1]
    folder, library = "legacy-folder", "legacy-manifest"
    objects = {}

    def add(identity, name, data=None, *, parents=None, properties=None, checksum=True):
        metadata = {"id": identity, "name": name, "mimeType": "application/octet-stream" if data is not None else "application/vnd.google-apps.folder",
                    "version": "9007199254740993", "parents": parents if parents is not None else [folder], "properties": properties or {}, "trashed": False}
        if data is not None:
            metadata["size"] = str(len(data))
            if checksum:
                metadata["sha256Checksum"] = hashlib.sha256(data).hexdigest()
        objects[identity] = {"metadata": metadata, "dataBase64": base64.b64encode(data).decode() if data is not None else None}
        return {"id": identity, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "mime": "application/octet-stream"} if data is not None else None

    add(folder, "Papeer Library", parents=[])
    add("empty-folder", "empty")
    add("nested-folder", "nested")
    add("nested-file", "previous.md", "以前の本文😀".encode(), parents=["nested-folder"])
    pdf = add("pdf-blob", "blob-pdf", (root / "tests/fixtures/sample.pdf").read_bytes())
    data = add("data-blob", "blob-data", b'{"papers":[],"web_annotation_ops":[{"id":"already-applied","operation":"keep raw ledger"}]}')
    external = add("external-blob", "moved-blob", bytes(range(256)), parents=["another-folder"], checksum=False)
    add("old-blob", "old orphan blob", b"previous revision")
    add("ink-operation", "ink-removed.json", b'{"action":"remove","target":"previously-imported"}', properties={"papeer": "ink-v1", "library": library})
    add("note-operation", "note-malformed.json", b'{bad JSON: preserve before parsing', parents=[], properties={"papeer": "notes-v1", "library": library})
    add("note-blob", "note-blob-tagged.json", b'{"content":"tagged old note"}', parents=[], properties={"papeer": "note-blob-v1", "library": library})
    note_body = add("moved-note-body", "moved-note.json", b'{"content":"referenced note outside folder"}', parents=["another-folder"], checksum=False)
    assert note_body is not None
    note_ref = {key: note_body[key] for key in ("id", "sha256", "size")}
    add("referenced-note-operation", "note-referenced.json", json.dumps({"version": 1, "blob": note_ref}).encode(), parents=[], properties={"papeer": "notes-v1", "library": library})
    add("unrelated-operation", "other-library.json", b'{}', parents=[], properties={"papeer": "ink-v1", "library": "other-library"})
    manifest = {"version": 1, "folder_id": folder, "revision": "source-revision", "updated_at": "2026-10-25T00:00:00Z", "items": [], "attachments": [],
                "files": {"papers/source/original.pdf": pdf, "library-data.json": data, "moved.bin": external}}
    add(library, "papeer-library.json", json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode(), properties={"papeer": "library-v1"})
    value = {"identity": {"accountId": "permission-fixture", "libraryId": library}, "objects": objects, "excluded": ["unrelated-operation"]}
    (root / "tests/fixtures/shared-legacy-drive.json").write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def migration_input_fixture(backup):
    from papeer.core.migrations.legacy_backup import inventory_hash
    peer, other, run = identity(9982), identity(9983), identity(9984)
    plan = deepcopy(backup["plan"])
    record = {"catalog": {"version": 1, "runId": run, "identity": {"accountId": "fixture", "libraryId": identity(1)},
                          "peers": [{"id": peer, "sources": [deepcopy(plan["manifest"]["source"])]}]},
              "inputs": [{"peerId": peer, "plan": plan}]}
    cases = [{"name": "valid", "valid": True, "value": deepcopy(record)}]
    for name in ("missing-input", "duplicate-input", "wrong-peer", "wrong-source", "run-id-as-backup", "bad-hash", "duplicate-peer", "empty-peer", "unknown-field", "boolean-version"):
        bad = deepcopy(record)
        if name == "missing-input":
            bad["inputs"] = []
        elif name == "duplicate-input":
            bad["inputs"].append(deepcopy(bad["inputs"][0]))
        elif name == "wrong-peer":
            bad["inputs"][0]["peerId"] = other
        elif name == "wrong-source":
            bad["catalog"]["peers"][0]["sources"][0]["id"] = "uncovered"
        elif name == "run-id-as-backup":
            bad["inputs"][0]["plan"]["manifest"]["id"] = run
        elif name == "bad-hash":
            bad["inputs"][0]["plan"]["manifest"]["inventorySha256"] = "0" * 64
        elif name == "duplicate-peer":
            bad["catalog"]["peers"].append(deepcopy(bad["catalog"]["peers"][0]))
        elif name == "empty-peer":
            bad["catalog"]["peers"][0]["sources"] = []
        elif name == "unknown-field":
            bad["freezeComplete"] = True
        elif name == "boolean-version":
            bad["catalog"]["version"] = True
        cases.append({"name": name, "valid": False, "value": bad})
    shared = deepcopy(record)
    shared["inputs"][0]["plan"]["manifest"]["source"] = {"kind": "drive", "id": "shared-source"}
    shared_plan = shared["inputs"][0]["plan"]
    shared_plan["manifest"]["inventorySha256"] = inventory_hash(shared_plan["manifest"])
    shared["catalog"]["peers"][0]["sources"] = [deepcopy(shared_plan["manifest"]["source"])]
    shared["catalog"]["peers"].append({"id": other, "sources": deepcopy(shared["catalog"]["peers"][0]["sources"])})
    second = deepcopy(shared["inputs"][0])
    second["peerId"], second["plan"]["manifest"]["id"] = other, identity(9985)
    shared["inputs"].append(second)
    cases.append({"name": "shared-drive", "valid": True, "value": deepcopy(shared)})
    second["plan"]["manifest"]["entries"] = []
    second["plan"]["manifest"]["inventorySha256"] = inventory_hash(second["plan"]["manifest"])
    cases.append({"name": "shared-drive-disagrees", "valid": False, "value": shared})
    return cases


if __name__ == "__main__":
    main()
