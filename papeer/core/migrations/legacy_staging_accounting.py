"""Independent checks and the residual-reason accounting of the Native legacy staging (work B7-f, DESIGN-r161-b7-staging.md 6 and 8).

Pure: no sidecar, no route, no startup path, no file is read or written here (the one function that opens a database,
`collection_facts`, opens the verified working copy read only). The staging writer (`sidecar/migrations/staging.py`) hands in what it
counted ITSELF from the verified copy and the backup (the `facts`) and what the TypeScript converter produced or what was read back out
of the staging (the `model`). Nothing here trusts the converter: every number a converter reports is compared with a number counted
from the rows.

  check_conversion(model, facts)  -> {'verification': [codes], 'provenance': [codes]}     (closed codes; no content, no path)
  account(...)                    -> which reasons that block a whole-Library conversion are RESOLVED (every element they were raised
                                     for is covered by a converted and verified target) and which stay RESIDUAL

A reason is resolved only on evidence. Anything this module cannot positively cover stays residual: an element with no coverage rule, a
count that does not match, a reason the converter itself keeps alive (`notConverted[].residual`, the plan's `residualReasons`), a
Notebook's own `incomplete` codes. `resolved` and `residual` are disjoint by construction.
"""
from __future__ import annotations

from collections import Counter
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3

from papeer.core.collection_paths import normalize_collection_name
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_model import all_document_pages, assert_snapshot
from papeer.core.edits.datasets import snapshot_resources

PLAN_SCOPE = 'native-legacy-staging-plan-v1'
PLAN_ROW_SCOPE = 'native-legacy-staging-plan-row-v1'
REPORT_SCOPE = 'native-legacy-staging-v1'
SOURCE_KIND = {'pdf': 'pdf-original', 'image': 'markdown-image'}
# The B6 reasons B7 can resolve, one by one (DESIGN 6.2). Every other B6 reason stays residual.
CONVERTIBLE = ('pdf-document-not-converted', 'pdf-annotation-not-converted', 'markdown-not-converted', 'folder-not-converted',
               'item-link-not-converted')
WITHHELD = frozenset({'pdf-annotation-web-ops-present', 'pdf-annotation-unmapped', 'pdf-annotation-unreadable',
                      'pdf-annotation-conversion-failed'})
CONTENT_KINDS = {'pdf-document': 'pdf', 'notebook-document': 'notebook', 'markdown-document': 'markdown'}
UNIT_KINDS = {'document': 'document', 'markdown': 'markdown', 'library': 'library'}
TOLERANCE = .001


# ----- IDs ---------------------------------------------------------------------------------------------------
def stable_id(library_id: str, kind: str, source) -> str:
    """frontend/src/migrations/stableId.ts `migrationStableId`, written out with edit_content_hash (DESIGN 3.4: only resources need it here)."""
    digest = list(edit_content_hash(['paper-desk-migration-v1', library_id, kind, list(source)])[:32])
    digest[12] = '8'
    digest[16] = '89ab'[int(digest[16], 16) & 3]
    text = ''.join(digest)
    return '-'.join([text[:8], text[8:12], text[12:16], text[16:20], text[20:]])


def ids_hash(ids) -> str:
    """The hash of an old-to-new ID table (every kind, resources included): the entries as `[kind, source, targetId]`, an entry that
    appears twice counted once, in the order of their canonical JSON. The plan row carries it, so that the table that was written is
    compared with the same value in the first run and in every later one (REVIEW-r161-b7f medium 1)."""
    entries = {json.dumps([entry['kind'], list(entry['source']), entry['targetId']], ensure_ascii=False, separators=(',', ':')) for entry in ids}
    return edit_content_hash(sorted(entries))


def resource_source(kind: str, key, sha256: str) -> list[str]:
    """The stable-ID source of a resource: [sourceKind, ...backup key, entry sha256] (legacyStagingInput.ts `resourceSource`)."""
    return [SOURCE_KIND[kind], *key, sha256]


def resource_id(library_id: str, kind: str, key, sha256: str) -> str:
    return stable_id(library_id, 'resource', resource_source(kind, key, sha256))


# ----- facts ---------------------------------------------------------------------------------------------------
def collection_facts(db_path: Path) -> dict:
    """The `collections` rows of the verified copy (read only): how many there are and how many name no folder (a blank name)."""
    with closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        names = [row[0] for row in db.execute('SELECT name FROM collections')]
    return {'rows': len(names), 'blank': sum(1 for name in names if not (isinstance(name, str) and normalize_collection_name(name)))}


def make_facts(manifest: dict, report: dict, rows: dict, *, entries, collections: dict, extractions: dict) -> dict:
    """What the writer counted itself. `rows` are the B7-d rows, `entries` the Library backup manifest's entries, `extractions` the
    verified Notebook extractions (for the annotation fingerprints)."""
    library = next((source for source in report['sources'] if source['kind'] == 'desktop-library'), None)
    web = _object(library, 'web_annotation_ops')
    notebook_marks = {}
    for paper_id, value in extractions.items():
        marks = Counter()
        for page in value['annotations']:
            marks.update(edit_content_hash(stroke) for stroke in page['ink'])
            marks.update(edit_content_hash(record) for record in page['bookmarks'])
        notebook_marks[paper_id] = marks
    return {
        'libraryId': manifest['libraryId'], 'manifestSha256': manifest['manifestSha256'], 'manifest': manifest, 'report': report,
        'library': library, 'rows': rows, 'items': {item['id']: item for item in rows['items']},
        'pdfs': {pdf['id']: pdf for pdf in rows['pdfs']}, 'markdown': {note['id']: note for note in rows['markdown']},
        'notebooks': {note['id']: note for note in rows['notebooks']}, 'folders': {folder['path']: folder for folder in rows['folders']},
        'manifestNotebooks': {item['sourceDocumentId']: item for item in manifest['notebooks']},
        'entries': {tuple(entry['key']): entry for entry in entries}, 'collections': collections,
        'webOps': 0 if web is None else (web['rows'] or {}).get('total'), 'notebookMarks': notebook_marks}


def _object(source: dict | None, name: str) -> dict | None:
    sqlite_part = (source or {}).get('sqlite')
    return next((item for item in (sqlite_part or {}).get('objects', []) if item['type'] == 'table' and item['name'] == name), None)


# ----- the model ---------------------------------------------------------------------------------------------------
def _close(a: float, b: float) -> bool:
    return abs(a - b) <= TOLERANCE


class _Failures:
    def __init__(self):
        self.verification, self.provenance = set(), set()

    def v(self, code: str) -> None:
        self.verification.add(code)

    def p(self, code: str) -> None:
        self.provenance.add(code)


def _document_ids(payload: dict) -> tuple[list[str], list[str]]:
    pages = [page['id'] for page in all_document_pages(payload)]
    annotations = [annotation['id'] for page in all_document_pages(payload) for annotation in page['annotations']]
    return pages, annotations


def check_conversion(model: dict, facts: dict) -> dict:
    """Every check of DESIGN 8.1 and 8.2 that does not need the staging database. `model` is the plan (before anything is written) or
    what was read back out of the staging (after): units, ids, provenance, resources, notConverted, coverage. Returns closed codes."""
    bad = _Failures()
    library_id = facts['libraryId']
    # ---- IDs ---------------------------------------------------------------------------------------------------------------------
    by_source: dict[tuple, str] = {}
    by_target: dict[str, tuple] = {}
    for entry in model['ids']:
        key = (entry['kind'], tuple(entry['source']))
        if by_source.get(key, entry['targetId']) != entry['targetId'] or by_target.get(entry['targetId'], key) != key:
            bad.v('ids-table')
        by_source[key], by_target[entry['targetId']] = entry['targetId'], key
    content_of = {target: (CONTENT_KINDS[kind], source[0]) for (kind, source), target in by_source.items()
                  if kind in CONTENT_KINDS and len(source) == 1}
    folder_path = {target: source[0] for (kind, source), target in by_source.items() if kind == 'library-folder' and len(source) == 1}
    folder_id = {path: target for target, path in folder_path.items()}

    # ---- units -------------------------------------------------------------------------------------------------------------------
    units = model['units']
    if [unit.get('seq', index) for index, unit in enumerate(units)] != list(range(len(units))):
        bad.v('units')
    libraries = [unit for unit in units if unit['unitKind'] == 'library']
    if len(libraries) != 1 or libraries[0]['targetId'] != library_id or libraries[0]['payload'].get('kind') != 'library':
        bad.v('units')
        return _done(bad)
    library = libraries[0]['payload']
    staged: dict[str, dict] = {}
    for unit in units:
        payload = unit['payload']
        try:
            assert_snapshot(payload)
        except (ValueError, TypeError, KeyError):
            bad.v('snapshot-invalid')
            return _done(bad)
        if payload.get('id') != unit['targetId'] or payload.get('kind') != UNIT_KINDS.get(unit['unitKind']):
            bad.v('units')
        if unit['unitKind'] == 'library':
            continue
        origin = content_of.get(unit['targetId'])
        if (origin is None or origin[1] not in facts['items'] or facts['items'][origin[1]]['kind'] != origin[0]
                or (origin[0] == 'markdown') != (unit['unitKind'] == 'markdown') or origin[1] in staged):
            bad.v('id-set')
            continue
        staged[origin[1]] = payload

    # ---- which sources were converted (the converter's coverage must agree with what is staged) -------------------------------------
    convertible = {paper_id for paper_id, item in facts['items'].items() if item['kind'] in ('pdf', 'markdown', 'notebook')}
    claimed = {}
    for entry in model['coverage']:
        paper_id = entry['sourceKey'][1] if len(entry['sourceKey']) == 2 else None
        if paper_id in claimed or paper_id not in convertible or facts['items'][paper_id]['kind'] != entry['kind']:
            bad.v('id-set')
            continue
        claimed[paper_id] = entry
    notes = {}
    for entry in model['notConverted']:
        notes.setdefault(tuple(entry['sourceKey']), []).append(entry)
    if set(claimed) != convertible or {paper_id for paper_id, entry in claimed.items() if entry['status'] == 'converted'} != set(staged):
        bad.v('id-set')
    for paper_id, entry in claimed.items():
        if entry['status'] == 'converted':
            continue
        reasons = [note for note in notes.get(('papers', paper_id), []) if note['kind'] in ('pdf', 'markdown', 'notebook', 'item')]
        if entry['status'] == 'blocked' and (entry['reason'] is None or not any(note['reason'] == entry['reason'] for note in reasons)):
            bad.v('id-set')
        if entry['status'] == 'not-in-library' and not any(note['kind'] == 'item' for note in reasons):
            bad.v('id-set')

    # ---- resources -----------------------------------------------------------------------------------------------------------------
    resources = {entry['id']: entry for entry in model['resources']}
    if len(resources) != len(model['resources']):
        bad.v('resources')
    referenced = set()
    for payload in (unit['payload'] for unit in units):
        referenced |= snapshot_resources(payload)
    if referenced != set(resources):
        bad.v('resources')
    resource_key: dict[str, tuple] = {}
    for rid, meta in resources.items():
        source = by_target.get(rid)
        if source is None or source[0] != 'resource' or len(source[1]) < 3 or source[1][-1] != meta['sha256'] or source[1][0] not in SOURCE_KIND.values():
            bad.v('resources')
            continue
        kind = 'pdf' if source[1][0] == SOURCE_KIND['pdf'] else 'image'
        key = tuple(source[1][1:-1])
        resource_key[rid] = key
        entry = facts['entries'].get(key)
        if (entry is None or entry['sha256'] != meta['sha256'] or entry['byteLength'] != meta['byteLength']
                or resource_id(library_id, kind, key, meta['sha256']) != rid
                or meta['mediaType'] != ('application/pdf' if kind == 'pdf' else 'image/png')):
            bad.v('resources')

    # ---- the Library --------------------------------------------------------------------------------------------------------------
    _check_library(library, staged, content_of, folder_path, folder_id, notes, facts, bad)

    # ---- every converted source ---------------------------------------------------------------------------------------------------
    withheld = {}
    for entry in model['notConverted']:
        if entry['kind'] == 'pdf-annotation' and entry['reason'] in WITHHELD and len(entry['sourceKey']) == 2:
            withheld[entry['sourceKey'][1]] = entry['reason']
    for paper_id, payload in staged.items():
        kind = facts['items'][paper_id]['kind']
        if kind == 'pdf':
            _check_pdf(paper_id, payload, resources, withheld.get(paper_id), notes, facts, bad)
        elif kind == 'notebook':
            _check_notebook(paper_id, payload, by_source, facts, bad)
        else:
            _check_markdown(paper_id, payload, resources, resource_key, facts, bad)

    _check_provenance(model, units, library, staged, resources, resource_key, content_of, folder_path, withheld, facts, bad)
    return _done(bad)


def _done(bad: _Failures) -> dict:
    return {'verification': sorted(bad.verification), 'provenance': sorted(bad.provenance)}


def _check_library(library, staged, content_of, folder_path, folder_id, notes, facts, bad) -> None:
    rows = facts['rows']
    item_ids = {item['id'] for item in library['items']}
    unit_ids = {payload['id'] for payload in staged.values()}
    if item_ids != unit_ids or len(item_ids) != len(library['items']):
        bad.v('library')
    kept = {}                                                             # paper id -> library item id
    for item in library['items']:
        origin = content_of.get(item['id'])
        if origin is None or origin[1] not in facts['items']:
            bad.v('library')
            continue
        paper_id = origin[1]
        row = facts['items'][paper_id]
        kept[paper_id] = item['id']
        parent = row['columns']['parent_id']
        path = row['collectionPath']
        try:
            tags = json.loads(row['columns']['tags']) if isinstance(row['columns']['tags'], str) else None
        except ValueError:
            tags = None
        if (item['kind'] != row['kind'] or item['title'] != row['columns']['title'] or item['tags'] != tags or item['read'] is not False
                or item['metadata'] != {} or ('resourceId' in item) != (row['kind'] == 'pdf')
                or (row['kind'] == 'pdf' and item.get('resourceId') != staged[paper_id]['pages'][0]['background'].get('resourceId'))):
            bad.v('library')
        if parent is None:
            if item['ownerId'] is not None or item['folderId'] != (folder_id.get(path) if path else None) or (path and path not in folder_id):
                bad.v('library')
        elif item['folderId'] is not None or content_of.get(item['ownerId'], (None, None))[1] != parent:
            bad.v('library')
    # folders: a staged folder is a row folder with its parent; the others are exactly the ones reported as not converted
    paths = set()
    for folder in library['folders']:
        path = folder_path.get(folder['id'])
        row = facts['folders'].get(path)
        if row is None or path in paths or folder['title'] != row['parts'][-1]:
            bad.v('library')
            continue
        paths.add(path)
        if folder['parentId'] != (None if row['parent'] is None else folder_id.get(row['parent'])):
            bad.v('library')
    missing = set(facts['folders']) - paths
    reported = {entry['sourceKey'][1] for key, group in notes.items() if key[:1] == ('folder',) for entry in group if entry['kind'] == 'folder'}
    if missing != reported or any(row['parent'] is not None and row['parent'] not in paths for path, row in facts['folders'].items() if path in paths):
        bad.v('library')
    # positions are ordinals made here (DESIGN 7.3 item 3): each group is exactly 0..n-1
    groups: dict[tuple, list[int]] = {}
    for item in library['items']:
        groups.setdefault(('item', item['ownerId'], item['folderId']), []).append(item['position'])
    for folder in library['folders']:
        groups.setdefault(('folder', folder['parentId']), []).append(folder['position'])
    if any(sorted(values) != list(range(len(values))) for values in groups.values()):
        bad.v('library')
    # links: exactly the resolved row links whose two ends were staged and are not owned
    expected = set()
    for link in rows['links']:
        if (link['status'] == 'resolved' and link['pdfId'] in kept and link['noteId'] in kept
                and facts['items'][link['pdfId']]['columns']['parent_id'] is None and facts['items'][link['noteId']]['columns']['parent_id'] is None):
            expected.add((kept[link['pdfId']], kept[link['noteId']]))
    if {(link['pdfId'], link['noteId']) for link in library['links']} != expected or len(library['links']) != len(expected):
        bad.v('library')
    if library['deletions']:
        bad.v('library')


def _check_pdf(paper_id, document, resources, withheld, notes, facts, bad) -> None:
    pdf, item = facts['pdfs'][paper_id], facts['items'][paper_id]
    file, counts = pdf['file'], pdf['counts']
    pages = document['pages']
    if (file is None or pdf['fileMatchesRow'] is not True or item['columns']['sha256'] != file['sha256'] or document['deletedPages']
            or not (len(pages) == pdf['pagesColumn'] == counts['pageRows']) or not counts['pageNumbersContiguous']
            or pdf['pageNumbers'] != list(range(1, len(pages) + 1))):
        bad.v('pdf-document')
        return
    resource = resources.get(pages[0]['background'].get('resourceId'))
    if (resource is None or resource['mediaType'] != 'application/pdf' or resource['sha256'] != file['sha256']
            or resource['byteLength'] != file['byteLength'] or len(resource.get('pdfPages') or []) != len(pages)):
        bad.v('pdf-document')
        return
    for number, page in enumerate(pages, 1):
        size = resource['pdfPages'][number - 1]
        if (page['background'] != {'kind': 'pdf', 'resourceId': pages[0]['background']['resourceId'], 'sourceRevision': file['sha256'], 'pdfPage': number}
                or not _close(page['widthPt'], size['widthPt']) or not _close(page['heightPt'], size['heightPt'])):
            bad.v('pdf-geometry')
    ink = {row['page']: row for row in pdf['inkRows'] if row['side'] == 'original'}
    marks = [row for row in pdf['bookmarkRows'] if row['side'] == 'original']
    found = {'ink': Counter(), 'sticky': Counter(), 'highlight': Counter()}
    for number, page in enumerate(pages, 1):
        for annotation in page['annotations']:
            if annotation['kind'] not in found:
                bad.v('pdf-annotations')
                continue
            found[annotation['kind']][number] += 1
    total = sum(sum(counter.values()) for counter in found.values())
    in_range = all(type(row['page']) is int and 1 <= row['page'] <= len(pages) for row in (*ink.values(), *marks))
    if withheld is not None:
        if total:
            bad.v('pdf-annotations')
    else:
        # converted: every original row is in range and readable, nothing needs a Web filter, and every count agrees page by page
        if (not in_range or counts['bookmarks']['other']['original'] or any(row['strokes'] is None for row in ink.values())
                or facts['webOps'] is None or (facts['webOps'] > 0 and ink)):
            bad.v('pdf-annotations')
        for number in range(1, len(pages) + 1):
            if (found['ink'][number] != ((ink.get(number) or {}).get('strokeCount') or 0)
                    or found['sticky'][number] != sum(1 for row in marks if row['page'] == number and row['kind'] == 'note')
                    or found['highlight'][number] != sum(1 for row in marks if row['page'] == number and row['kind'] == 'highlight')):
                bad.v('pdf-annotations')
        if (sum(found['ink'].values()) != counts['strokes']['original'] or sum(found['sticky'].values()) != counts['bookmarks']['note']['original']
                or sum(found['highlight'].values()) != counts['bookmarks']['highlight']['original']):
            bad.v('pdf-annotations')
    translated = counts['ink']['other'] + sum(counts['bookmarks'][kind]['other'] for kind in ('note', 'highlight', 'other'))
    reported = sum(entry['count'] for entry in notes.get(('papers', paper_id), []) if entry['reason'] == 'pdf-annotation-translated-side')
    if translated != reported:
        bad.v('pdf-annotations')


def _check_notebook(paper_id, document, by_source, facts, bad) -> None:
    table = facts['notebooks'][paper_id]
    # the page order is the notebook's own (`pageIds` of the manifest), each page under the stable ID of its source page
    order = [by_source.get(('notebook-page', (paper_id, source_page))) for source_page in facts['manifestNotebooks'][paper_id]['pageIds']]
    if [page['id'] for page in document['pages']] != order:
        bad.v('notebook')
    found = Counter(annotation['kind'] for page in document['pages'] for annotation in page['annotations'])
    if (document['deletedPages'] or len(document['pages']) != table['pageRows'] or table['ink']['other'] or table['strokes']['other']
            or any(table['bookmarks'][kind]['other'] for kind in ('note', 'highlight', 'other')) or table['bookmarks']['other']['original']
            or found['ink'] != table['strokes']['original'] or found['sticky'] != table['bookmarks']['note']['original']
            or found['highlight'] != table['bookmarks']['highlight']['original'] or sum(found.values()) != sum(found[kind] for kind in ('ink', 'sticky', 'highlight'))
            or (facts['webOps'] != 0 and table['ink']['original'])):
        bad.v('notebook')


def _check_markdown(paper_id, snapshot, resources, resource_key, facts, bad) -> None:
    note = facts['markdown'][paper_id]
    if note['state'] != 'present' or note['mirror'] != 'match' or note['content'] is None or snapshot['appendIds']:
        bad.v('markdown')
        return
    restored = snapshot['content']
    for image in snapshot['imageResources']:
        meta, key = resources.get(image['resourceId']), resource_key.get(image['resourceId'])
        if (meta is None or key is None or meta['sha256'] != image['sha256'] or meta['mediaType'] != 'image/png'
                or key[:3] != ('papers', paper_id, 'media') or len(key) != 4):
            bad.v('markdown')
            return
        restored = restored.replace(f"papeer://resource/{image['resourceId']}?sha256={image['sha256']}", 'media/' + key[3])
    encoded = restored.encode('utf-8', 'surrogatepass')
    if hashlib.sha256(encoded).hexdigest() != note['contentSha256'] or len(encoded) != note['contentBytes'] or restored != note['content']:
        bad.v('markdown')


def _check_provenance(model, units, library, staged, resources, resource_key, content_of, folder_path, withheld, facts, bad) -> None:
    library_id = facts['libraryId']
    expected: dict[tuple, dict] = {}
    expected[('library', library_id)] = {}
    for unit in units:
        if unit['unitKind'] == 'library':
            continue
        payload = unit['payload']
        expected[('markdown' if unit['unitKind'] == 'markdown' else 'document', payload['id'])] = {}
        if unit['unitKind'] == 'document':
            pages, annotations = _document_ids(payload)
            expected.update({('page', page): {} for page in pages})
            expected.update({('annotation', annotation): {} for annotation in annotations})
    for item in library['items']:
        expected[('library-item', item['id'])] = {}
    for folder in library['folders']:
        expected[('folder', folder['id'])] = {}
    for link in library['links']:
        expected[('link', json.dumps([link['pdfId'], link['noteId']], separators=(',', ':')))] = {}
    for rid in resources:
        expected[('resource', rid)] = {}
    rows = {}
    for row in model['provenance']:
        key = (row['targetKind'], row['targetId'])
        if key in rows:
            bad.p('provenance-duplicate')
        rows[key] = row
    if set(rows) != set(expected):
        bad.p('provenance-targets')
    entries = facts['entries']

    def file_sha(row, *key):
        entry = entries.get(tuple(row['sourceKey']))
        return row['sourceKind'] == 'file' and entry is not None and entry['sha256'] == row['sourceSha256'] and tuple(row['sourceKey']) == key

    derived = []
    documents = {unit['targetId']: unit for unit in units if unit['unitKind'] == 'document'}
    page_of = {}                                                         # page id -> (document id, page number)
    for unit_id, unit in documents.items():
        for number, page_id in enumerate(_document_ids(unit['payload'])[0], 1):
            page_of[page_id] = (unit_id, number)
    for (kind, target), row in rows.items():
        try:
            if kind == 'resource':
                ok = file_sha(row, *resource_key[target])
            elif kind == 'document':
                paper_id = content_of[target][1]
                name = 'original.pdf' if content_of[target][0] == 'pdf' else 'notebook.json'
                ok = file_sha(row, 'papers', paper_id, name)
            elif kind == 'page':
                unit_id, number = page_of[target]
                origin, paper_id = content_of[unit_id]
                if origin == 'notebook':
                    ok = file_sha(row, 'papers', paper_id, 'notebook.json')
                else:
                    reported = facts['pdfs'][paper_id]['annotationPages'].get(str(number))
                    if row['sourceKind'] == 'rows':
                        ok = (paper_id not in withheld and reported is not None and row['sourceKey'] == ['rows', paper_id, 'original', str(number)]
                              and row['sourceSha256'] == reported['sourceSha256'])
                    else:
                        ok = file_sha(row, 'papers', paper_id, 'original.pdf') and (paper_id in withheld or reported is None)
            elif kind == 'markdown':
                paper_id = content_of[target][1]
                ok = (row['sourceKind'] == 'row' and row['sourceKey'] == ['note_state', paper_id]
                      and row['sourceSha256'] == facts['markdown'][paper_id]['sourceSha256'])
            elif kind == 'library-item':
                paper_id = content_of[target][1]
                ok = (row['sourceKind'] == 'row' and row['sourceKey'] == ['papers', paper_id] and row['sourceSha256'] == facts['items'][paper_id]['sourceSha256'])
                derived.append(f"{kind}|{target}|{row['sourceSha256']}")
            elif kind == 'folder':
                path = folder_path[target]
                ok = (row['sourceKind'] == 'rows' and row['sourceKey'] == ['folder', path] and row['sourceSha256'] == facts['folders'][path]['sourceSha256'])
                derived.append(f"{kind}|{target}|{row['sourceSha256']}")
            elif kind == 'link':
                pdf, note = json.loads(target)
                ends = {content_of[pdf][1], content_of[note][1]}
                match = next(link for link in facts['rows']['links'] if {link['a'], link['b']} == ends)
                ok = (row['sourceKind'] == 'row' and row['sourceKey'] == ['item_links', match['a'], match['b']] and row['sourceSha256'] == match['sourceSha256'])
                derived.append(f"{kind}|{target}|{row['sourceSha256']}")
            elif kind in ('library', 'annotation'):
                ok = True                                                   # checked below (the derived hash of the Library, the fingerprints of the annotations)
            else:
                ok = False
        except (KeyError, StopIteration, ValueError, TypeError, IndexError):
            ok = False
        if not ok:
            bad.p('provenance-source-' + kind)
    if ('library', library_id) in rows:
        row = rows[('library', library_id)]
        if row['sourceKind'] != 'derived' or row['sourceKey'] != ['library'] or row['sourceSha256'] != edit_content_hash(sorted(derived)):
            bad.p('provenance-source-library')
    # annotations: the fingerprint of each is the hash of the very stroke / bookmark record the rows hold
    for unit in units:
        if unit['unitKind'] != 'document':
            continue
        paper_id, kind = content_of[unit['targetId']][1], content_of[unit['targetId']][0]
        _, annotations = _document_ids(unit['payload'])
        found = Counter(rows[('annotation', annotation)]['sourceSha256'] for annotation in annotations if ('annotation', annotation) in rows)
        if kind == 'notebook':
            want = facts['notebookMarks'].get(paper_id)
        elif paper_id in withheld:
            want = Counter()
        else:
            pdf = facts['pdfs'][paper_id]
            want = Counter(edit_content_hash(stroke) for row in pdf['inkRows'] if row['side'] == 'original' for stroke in (row.get('strokes') or []))
            want.update(edit_content_hash(row['record']) for row in pdf['bookmarkRows'] if row['side'] == 'original')
        if want is None or found != want or any(rows[('annotation', annotation)]['sourceKind'] != 'row'
                                                 for annotation in annotations if ('annotation', annotation) in rows):
            bad.p('provenance-source-annotation')


# ----- the accounting ---------------------------------------------------------------------------------------------------
def account(manifest: dict, report: dict, model: dict, facts: dict, *, plan_residual) -> dict:
    """Which of the reasons that block a whole-Library conversion are resolved and which stay residual (DESIGN 6.1, 6.2).

    `resolved` = a B6 reason in CONVERTIBLE whose every element (a file, or a (table, group) of rows with its count) is covered by a
    staged and verified target, and that no converter keeps alive. `residual` = every other B6 reason, plus every reason the converter
    itself keeps alive, plus the `incomplete` codes of the staged Notebooks. The two are disjoint. An element nothing covers is NOT an
    element that does not matter: a reason with no element found, or with an element that has no coverage rule, stays residual.
    """
    blocked = set(manifest['wholeLibrary']['reasons'])
    forced = set(plan_residual) | {entry['residual'] for entry in model['notConverted']}
    staged = {entry['sourceKey'][1]: entry for entry in model['coverage'] if entry['status'] == 'converted'}
    for paper_id, entry in staged.items():
        if entry['kind'] == 'notebook':
            forced |= set(facts['manifestNotebooks'][paper_id]['incomplete'])               # B7-e REVIEW low 5
    staged_pdfs = [paper_id for paper_id, entry in staged.items() if entry['kind'] == 'pdf']
    staged_notes = [paper_id for paper_id, entry in staged.items() if entry['kind'] == 'markdown']
    withheld = {entry['sourceKey'][1] for entry in model['notConverted'] if entry['kind'] == 'pdf-annotation' and entry['reason'] in WITHHELD}
    annotated = [paper_id for paper_id in staged_pdfs if paper_id not in withheld]
    pdfs, notes, rows = facts['pdfs'], facts['markdown'], facts['rows']
    media_used = set()
    for unit in model['units']:
        if unit['unitKind'] == 'markdown':
            media_used |= {image['resourceId'] for image in unit['payload']['imageResources']}
    used_keys = {tuple(source[1:-1]) for entry in model['ids'] if entry['kind'] == 'resource' and entry['targetId'] in media_used
                 for source in [entry['source']]}
    library_unit = next(unit for unit in model['units'] if unit['unitKind'] == 'library')['payload']
    staged_folders, staged_links = len(library_unit['folders']), len(library_unit['links'])
    folders_complete = staged_folders == len(facts['folders']) and facts['collections']['blank'] == 0
    elements: list[dict] = []

    def element(reason, what, ref, count, covered):
        elements.append({'reason': reason, 'what': what, 'ref': ref, 'count': count, 'covered': covered if covered <= count else 0})

    library = next((source for source in report['sources'] if source['kind'] == 'desktop-library'), None)
    for entry in (library or {}).get('entries', []):
        reason = entry['reason']
        if reason not in CONVERTIBLE or entry['category'] == 'supported':
            continue
        key = tuple(entry['key'])
        covered = 0
        if len(key) == 3 and key[0] == 'papers' and key[2] == 'original.pdf':
            covered = int(key[1] in staged_pdfs)
        elif len(key) == 3 and key[0] == 'papers' and key[2] == 'note.md':
            covered = int(key[1] in staged_notes)
        elif len(key) == 4 and key[0] == 'papers' and key[2] == 'media' and reason == 'markdown-not-converted':
            covered = int(key[1] in staged_notes and key in used_keys)
        element(reason, 'file', '/'.join((key[0], '<id>', *key[2:])) if len(key) > 2 else '/'.join(key), 1, covered)
    for table in ((library or {}).get('sqlite') or {}).get('objects', []):
        if table['type'] != 'table':
            continue
        for group in (table['rows'] or {}).get('groups', []):
            if group['reason'] not in CONVERTIBLE or group['count'] <= 0 or group['category'] == 'supported':
                continue
            name, kind, count, covered = table['name'], group['group'], group['count'], 0
            if (name, kind) == ('papers', 'pdf'):
                covered = len(staged_pdfs)
            elif (name, kind) == ('papers', 'markdown'):
                covered = len(staged_notes)
            elif (name, kind) == ('pages', 'pdf'):
                covered = sum(pdfs[paper_id]['counts']['pageRows'] for paper_id in staged_pdfs)
            elif (name, kind) == ('pdf_ink', 'pdf'):
                covered = sum(pdfs[paper_id]['counts']['ink']['original'] for paper_id in annotated)
            elif (name, kind) == ('bookmarks', 'pdf'):
                covered = sum(sum(pdfs[paper_id]['counts']['bookmarks'][bucket]['original'] for bucket in ('note', 'highlight', 'other')) for paper_id in annotated)
            elif (name, kind) == ('note_state', 'markdown'):
                covered = len(staged_notes)
            elif name == 'collections' and kind == 'all':
                covered = count if folders_complete and facts['collections']['rows'] == count else 0
            elif name == 'item_links' and kind == 'all':
                covered = staged_links if staged_links == len([link for link in rows['links'] if link['status'] == 'resolved']) == count else 0
            element(group['reason'], 'rows', f'{name}/{kind}', count, covered)       # note_legacy, other groups: nothing covers them
    resolved = set()
    for reason in CONVERTIBLE:
        found = [item for item in elements if item['reason'] == reason]
        if reason in blocked and reason not in forced and found and all(item['covered'] == item['count'] for item in found):
            resolved.add(reason)
    residual = (blocked - resolved) | forced
    if resolved & residual or not resolved <= blocked:
        raise ValueError('staging-verification-failed')
    summary = []
    for reason in sorted(blocked | forced):
        found = [item for item in elements if item['reason'] == reason]
        summary.append({'reason': reason, 'status': 'resolved' if reason in resolved else 'residual',
                        'elements': len(found), 'covered': sum(item['covered'] for item in found), 'count': sum(item['count'] for item in found),
                        'keptAliveByConverter': reason in forced})
    return {'resolved': sorted(resolved), 'residual': sorted(residual), 'accounting': summary}
