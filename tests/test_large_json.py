"""Large JSON files: translation-cache.json holds each translation once and is written less often,
document.json is parsed once while it stays the same, and the reader and search read it once."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import threading
import time

import pymupdf as fitz
import pytest

from papeer.core import search, shared_json
from papeer.core.config import Settings
from papeer.core.fileio import atomic_write_json
from papeer.core.paths import PaperFiles
from papeer.core.reading_state import reading_state, translation_text
from papeer.core.reading_tools import translation_paragraphs
import papeer.core.service as service_module
from papeer.core.service import PaperService, stored_translations
from papeer.core.storage import Library
import papeer.core.translation_review as translation_review
from papeer.core.terminology import apply_glossary, effective_glossary
from papeer.core import prompts
from papeer.layout.math_layout import LAYOUT_VERSION
from papeer.layout.reading_flow import unit_pages
from papeer.pdf.pdf_engine import translation_units
from papeer.providers import Cancelled
import papeer.translation.translation as translation_module
from papeer.translation.translation import RetryState, TranslationKey, page_fingerprint
from _frozen_documents import SharedDocumentModified
from test_workflow import FakeProvider


@pytest.fixture(autouse=True)
def _forget_shared_files():
    shared_json.clear()
    yield
    shared_json.clear()


def make_paper(tmp_path: Path, pages: list[list[str]]) -> tuple[Library, str]:
    """A paper whose pages hold the given paragraphs, far enough apart to be blocks of their own."""
    source = tmp_path / "source.pdf"
    with fitz.open() as pdf:
        for paragraphs in pages:
            page = pdf.new_page()
            for index, text in enumerate(paragraphs):
                page.insert_text((40, 70 + 250 * index), text, fontsize=12)
        pdf.save(source)
    library = Library(tmp_path / "library")
    identity, _ = library.import_pdf(source)
    return library, identity


def read_saved(path: Path) -> dict | None:
    """The JSON at `path` as saved now, or None while another thread replaces it: Windows refuses to
    open a file that os.replace is putting in place (PermissionError), so a waiting loop tries again."""
    try:
        return json.loads(path.read_text("utf-8"))
    except OSError:
        return None


def read_cache(library: Library, identity: str) -> dict:
    return json.loads(PaperFiles(library.folder(identity)).translation_cache.read_text("utf-8"))


def current_units(library: Library, identity: str) -> list[dict]:
    units = translation_units(library.document(identity))
    apply_glossary(units, effective_glossary(library, identity))
    return units


def earlier_version_reuses(cache: dict, key: TranslationKey, units: list[dict]) -> dict[str, str]:
    """The translations the translate() of earlier versions (which wrote every translation at the top
    too) takes from a cache: the top when the key matches, then each page of the key with its source."""
    done = dict(cache.get("translations", {})) if key.matches_cache(cache) else {}
    for number in {page for unit in units for page in unit_pages(unit)}:
        page_units = [u for u in units if number in unit_pages(u)]
        entry = cache.get("completed_pages", {}).get(str(number), {})
        if (key.matches_page(entry) and entry.get("source") == page_fingerprint(page_units)
                and all(u["id"] in entry.get("translations", {}) for u in page_units)):
            done.update(entry["translations"])
    return done


class StopAtRecovery(FakeProvider):
    """Answers the first request without `dropped`, and is stopped while the recovery of it is sent."""

    def __init__(self, dropped: str):
        super().__init__()
        self.dropped = dropped

    def generate(self, instruction, data, schema=None):
        payload = json.loads(data)
        if "blocks" not in payload:
            raise Cancelled("stopped")
        answer = json.loads(super().generate(instruction, data, schema))
        answer["translations"] = [item for item in answer["translations"] if item["id"] != self.dropped]
        return json.dumps(answer, ensure_ascii=False)


def test_each_translation_is_written_once_and_earlier_versions_read_the_cache_alike(tmp_path):
    library, identity = make_paper(tmp_path, [["The first paragraph of page one.", "The second paragraph of page one."],
                                              ["The only paragraph of page two."]])
    units = current_units(library, identity)
    first, second = [u["id"] for u in units if u["page"] == 1]
    with pytest.raises(Cancelled):
        PaperService(library, StopAtRecovery(second), threading.Event()).translate(identity, {1})
    cache = read_cache(library, identity)
    # Page 1 is unfinished: the translation of its first paragraph is kept at the top.
    assert set(cache["translations"]) == {first} and cache["completed_pages"] == {}
    key = TranslationKey.current(FakeProvider().settings, prompts.load("translation"), units)
    assert earlier_version_reuses(cache, key, units) == cache["translations"]

    provider = FakeProvider()
    PaperService(library, provider, threading.Event()).translate(identity)
    cache = read_cache(library, identity)
    # Completed pages hold their translations; nothing is repeated at the top.
    assert cache["translations"] == {}
    assert {number: set(entry["translations"]) for number, entry in cache["completed_pages"].items()} == \
        {str(page): {u["id"] for u in units if u["page"] == page} for page in (1, 2)}
    assert set(stored_translations(cache)) == {u["id"] for u in units}
    # Earlier versions of Papeer (which read the top first) find every translation all the same.
    assert earlier_version_reuses(cache, key, units) == stored_translations(cache)
    # The glossary in effect is written once, not with every page.
    assert json.loads(cache["glossary"]) == effective_glossary(library, identity)
    assert all("glossary" not in entry for entry in cache["completed_pages"].values())
    # Written without indentation.
    assert "\n" not in PaperFiles(library.folder(identity)).translation_cache.read_text("utf-8")


def test_a_cache_holding_every_translation_at_the_top_resumes_without_the_model(tmp_path):
    library, identity = make_paper(tmp_path, [["Original content on page one."], ["Original content on page two."]])
    PaperService(library, FakeProvider(), threading.Event()).translate(identity)
    path = PaperFiles(library.folder(identity)).translation_cache
    cache = read_cache(library, identity)
    translations = stored_translations(cache)
    # As versions before this one wrote it: every translation at the top and with its page, indented.
    cache["translations"] = dict(translations)
    path.write_text(json.dumps(cache, ensure_ascii=False, indent=2), "utf-8")
    provider = FakeProvider()
    report = PaperService(library, provider, threading.Event()).translate(identity)
    assert provider.calls == 0 and report["already_translated_pages"] == [1, 2]
    rewritten = read_cache(library, identity)
    assert rewritten["translations"] == {} and stored_translations(rewritten) == translations


class Snapshots:
    """Copies of translation-cache.json each time a page's PDF is made, and a count of its writes."""

    def __init__(self, monkeypatch, cache_path: Path):
        self.pages: dict[int, dict] = {}
        self.writes = 0
        build, write = service_module.build_translated_pdf, service_module.atomic_write_json

        def building(source, document, translations, output, page_numbers=None, **options):
            if page_numbers is not None and len(page_numbers) == 1:
                self.pages[next(iter(page_numbers))] = json.loads(cache_path.read_text("utf-8"))
            return build(source, document, translations, output, page_numbers=page_numbers, **options)

        def writing(path, value, **options):
            if Path(path) == cache_path:
                self.writes += 1
            return write(path, value, **options)

        monkeypatch.setattr(service_module, "build_translated_pdf", building)
        monkeypatch.setattr(service_module, "atomic_write_json", writing)


def test_answers_are_written_with_the_next_record_and_a_crash_before_it_sends_them_again(tmp_path, monkeypatch):
    library, identity = make_paper(tmp_path, [[f"Original content on page {n}."] for n in (1, 2, 3)])
    units = current_units(library, identity)
    path = PaperFiles(library.folder(identity)).translation_cache
    snapshots = Snapshots(monkeypatch, path)
    PaperService(library, FakeProvider(), threading.Event()).translate(identity)
    # The start, the record of each of the 3 batches before it goes out, and the end: the answers
    # themselves (3 more writes before) ride on the next record.
    assert snapshots.writes == 5
    page_one = next(u["id"] for u in units if u["page"] == 1)
    page_two = next(u["id"] for u in units if u["page"] == 2)
    # While page 2 was made, its answer was not written yet but page 1's was (with page 2's record).
    assert page_one in stored_translations(snapshots.pages[2]) and page_two not in stored_translations(snapshots.pages[2])
    crashed = snapshots.pages[2]
    # Page 2's request is on record as sent without an answer: after a crash there, resuming sends it
    # again as a first request, spending no retry.
    assert crashed["retry_state"]["unanswered"] == {page_two: 1}
    path.write_text(json.dumps(crashed, ensure_ascii=False), "utf-8")
    sent = []

    class Recording(FakeProvider):
        def generate(inner, instruction, data, schema=None):
            sent.append(json.loads(data))
            return super().generate(instruction, data, schema)

    PaperService(library, Recording(), threading.Event()).translate(identity)
    assert [[u["id"] for u in payload["blocks"]] for payload in sent] == [[page_two], [units[2]["id"]]]
    state = RetryState.from_cache(read_cache(library, identity)["retry_state"])
    assert state.retry_calls == 0 and state.unanswered == {} and state.attempts[page_two] == 1


def test_with_no_batch_waiting_a_finished_batch_is_written_at_once(tmp_path):
    library, identity = make_paper(tmp_path, [["Original content on page 1."], ["Original content on page 2."]])
    path = PaperFiles(library.folder(identity)).translation_cache
    page_one = next(u["id"] for u in current_units(library, identity) if u["page"] == 1)

    class Waiting(FakeProvider):
        """Page 2 is answered only once page 1's translation is on disk, not held back to the end."""

        def __init__(self):
            super().__init__()
            self.settings = Settings(translation_concurrency=2)
            self.lock = threading.Lock()

        def generate(inner, instruction, data, schema=None):
            if "page 2" in json.loads(data)["blocks"][0]["text"]:
                deadline = time.monotonic() + 5
                while page_one not in stored_translations(read_saved(path) or {}):
                    if time.monotonic() > deadline:
                        raise RuntimeError("page 1 was not saved while page 2 was in flight")
                    time.sleep(0.01)
            with inner.lock:
                return super().generate(instruction, data, schema)

    report = PaperService(library, Waiting(), threading.Event()).translate(identity)
    assert report["translated_pages"] == [1, 2]


def test_an_answer_is_never_saved_as_answered_without_its_translations(tmp_path, monkeypatch):
    """In parallel, page 2's save lands while page 1's answer is being checked: page 1 must still be on
    record as sent without an answer, so that a crash there sends it again instead of spending a retry."""
    library, identity = make_paper(tmp_path, [["Original content on page 1."], ["Original content on page 2."]])
    path = PaperFiles(library.folder(identity)).translation_cache
    units = current_units(library, identity)
    page_one, page_two = ({u["id"] for u in units if u["page"] == page} for page in (1, 2))
    snapshot = {}
    check = translation_module._valid_items

    def slow_check(answer, fresh):
        if fresh[0]["page"] == 1:
            deadline = time.monotonic() + 5
            while not page_two <= set(stored_translations(saved := read_saved(path) or {})):
                assert time.monotonic() < deadline, "page 2 was not saved while page 1 was checked"
                time.sleep(0.01)
            snapshot.update(saved)
        return check(answer, fresh)

    monkeypatch.setattr(translation_module, "_valid_items", slow_check)

    class Parallel(FakeProvider):
        def __init__(self):
            super().__init__()
            self.settings = Settings(translation_concurrency=2)
            self.lock = threading.Lock()

        def generate(inner, instruction, data, schema=None):
            with inner.lock:
                return super().generate(instruction, data, schema)

    PaperService(library, Parallel(), threading.Event()).translate(identity)
    assert not page_one & set(stored_translations(snapshot))
    assert snapshot["retry_state"]["unanswered"] == dict.fromkeys(page_one, 1)
    # A crash at that moment: resuming sends page 1 again as a first request, spending no retry.
    monkeypatch.setattr(translation_module, "_valid_items", check)
    path.write_text(json.dumps(snapshot, ensure_ascii=False), "utf-8")
    sent = []

    class Recording(FakeProvider):
        def generate(inner, instruction, data, schema=None):
            sent.append(json.loads(data))
            return super().generate(instruction, data, schema)

    PaperService(library, Recording(), threading.Event()).translate(identity)
    assert [{u["id"] for u in payload["blocks"]} for payload in sent] == [page_one]
    assert read_cache(library, identity)["retry_state"]["retry_calls"] == 0


def test_the_shared_document_cannot_be_changed_in_place_in_tests(tmp_path):
    library, identity = make_paper(tmp_path, [["Original content on page one."]])
    document = library.document(identity)
    with pytest.raises(SharedDocumentModified):
        document["blocks"][0]["text"] = "changed"
    with pytest.raises(SharedDocumentModified):
        document["pages"].append({})
    # Copies can be changed; a shallow copy keeps what is inside read-only.
    changed = copy.deepcopy(document)
    changed["blocks"][0]["text"] = "changed"
    shallow = dict(document, title="changed")
    with pytest.raises(SharedDocumentModified):
        shallow["blocks"].pop()
    assert json.loads(json.dumps(document)) == document and document["blocks"][0]["text"] != "changed"


def test_document_is_parsed_once_until_the_file_is_replaced(tmp_path):
    library, identity = make_paper(tmp_path, [["Original content on page one."]])
    path = PaperFiles(library.folder(identity)).document_json
    first = library.document(identity)
    assert library.document(identity) is first
    # Written without indentation when imported.
    assert "\n" not in path.read_text("utf-8")
    changed = dict(copy.deepcopy(first), title="X" * len(first["title"]))
    before = os.stat(path)
    atomic_write_json(path, changed, indent=None)
    # The same size and modification time: the new file id still tells the replacement apart.
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert os.stat(path).st_size == before.st_size
    assert library.document(identity)["title"] == changed["title"]


def test_a_document_of_an_older_layout_is_extracted_again_written_compactly_and_kept(tmp_path):
    library, identity = make_paper(tmp_path, [["Original content on page one."]])
    path = PaperFiles(library.folder(identity)).document_json
    older = dict(library.document(identity), layout_version=LAYOUT_VERSION - 1, title="Kept title")
    path.write_text(json.dumps(older, indent=2), "utf-8")
    refreshed = library.document(identity)
    assert refreshed["layout_version"] == LAYOUT_VERSION and refreshed["title"] == "Kept title"
    assert "\n" not in path.read_text("utf-8")
    assert library.document(identity) is refreshed


def test_shared_files_are_bounded_by_count_and_size(tmp_path, monkeypatch):
    paths = []
    for index in range(3):
        paths.append(tmp_path / f"{index}.json")
        atomic_write_json(paths[-1], {"value": "x" * 100 * (index + 1)})
    monkeypatch.setattr(shared_json, "MAX_ENTRIES", 2)
    values = [shared_json.read_shared_json(path) for path in paths]
    assert shared_json.read_shared_json(paths[2]) is values[2] and shared_json.read_shared_json(paths[1]) is values[1]
    assert shared_json.read_shared_json(paths[0]) is not values[0]
    # A file larger than the size limit by itself is read and returned, never kept (nor what it would evict).
    monkeypatch.setattr(shared_json, "MAX_BYTES", paths[2].stat().st_size - 1)
    large = shared_json.read_shared_json(paths[2])
    assert large == values[2] and shared_json.read_shared_json(paths[2]) is not large
    assert shared_json.read_shared_json(paths[1]) is values[1]


def test_a_read_refused_while_the_file_is_replaced_is_tried_again(tmp_path, monkeypatch):
    path = tmp_path / "document.json"
    atomic_write_json(path, {"version": 1})
    monkeypatch.setattr(shared_json, "_READ_WAIT", 0)
    read = Path.read_text
    refusals = []

    def refusing(self, *args, **kwargs):
        if len(refusals) < 2:
            refusals.append(self)
            raise PermissionError(13, "being replaced", str(self))
        return read(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", refusing)
    assert shared_json.read_shared_json(path) == {"version": 1} and len(refusals) == 2
    # Refused every time: the last error goes on.
    shared_json.clear()
    refusals.clear()

    def always_refusing(self, *args, **kwargs):
        refusals.append(self)
        raise PermissionError(13, "being replaced", str(self))

    monkeypatch.setattr(Path, "read_text", always_refusing)
    with pytest.raises(PermissionError):
        shared_json.read_shared_json(path)
    assert len(refusals) == shared_json._READ_ATTEMPTS


def test_shared_files_can_be_read_while_they_are_replaced(tmp_path):
    path = tmp_path / "document.json"
    atomic_write_json(path, {"version": 0})
    errors, seen = [], set()
    stop = threading.Event()

    def read():
        while not stop.is_set():
            try:
                seen.add(shared_json.read_shared_json(path)["version"])
            except Exception as error:  # noqa: BLE001 - any error fails the test
                errors.append(error)
                return

    readers = [threading.Thread(target=read) for _ in range(4)]
    for thread in readers:
        thread.start()
    for version in range(1, 30):
        atomic_write_json(path, {"version": version})
    time.sleep(0.05)
    stop.set()
    for thread in readers:
        thread.join()
    assert not errors
    assert shared_json.read_shared_json(path)["version"] == 29


def test_readers_leave_the_shared_document_as_it_was(tmp_path):
    library, identity = make_paper(tmp_path, [["Original content on page one."], ["Original content on page two."]])
    shared = library.document(identity)
    service = PaperService(library, FakeProvider(), threading.Event())
    service.translate(identity, {1})
    search.search_paper(library, identity, "content", "original")
    (library.folder(identity) / "translation.md").unlink()
    search.search_paper(library, identity, "適応", "translated")
    reading_state(library, identity)
    translation_text(library, identity, 1)
    translation_paragraphs(library, identity)
    service.translate(identity)
    service.article(identity)
    service.ask(identity, "追従誤差は？")
    assert library.document(identity) is shared
    assert shared == json.loads(PaperFiles(library.folder(identity)).document_json.read_text("utf-8"))


def test_reference_recognition_leaves_the_document_as_it_was(tmp_path):
    library, identity = make_paper(tmp_path, [["Original content on page one."], ["Original content on page two."]])
    # Reference recognition works on copies of the blocks (the shared document is read-only in tests).
    document = library.document(identity)
    kept = copy.deepcopy(document)
    assert translation_review.required_translation_pages(document) == [1, 2]
    assert document == kept


def test_search_of_an_unfinished_translation_divides_the_flows_once(tmp_path, monkeypatch):
    library, identity = make_paper(tmp_path, [[f"Original content on page {n}."] for n in (1, 2, 3)])
    PaperService(library, FakeProvider(), threading.Event()).translate(identity)
    (library.folder(identity) / "translation.md").unlink()
    calls = []
    original = service_module.materialize_flows
    monkeypatch.setattr(service_module, "materialize_flows", lambda *args: calls.append(1) or original(*args))
    found = search.search_paper(library, identity, "適応", "translated")
    assert [item["page"] for item in found["results"]] == [1, 2, 3]
    assert len(calls) == 1


def test_files_people_read_keep_their_indentation(tmp_path):
    path = tmp_path / "settings.json"
    atomic_write_json(path, {"provider": "codex"})
    assert path.read_text("utf-8") == '{\n  "provider": "codex"\n}'
