"""Translate explicit sample pages in a snapshot using the configured provider.

This integration check never writes to the live library. A snapshot contains
samples.json (id/pages entries) and one original.pdf per id directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import threading

from papeer.core.config import Settings, data_directory
from papeer.pdf.pdf_engine import batches, build_translated_pdf, extract_pdf, translation_units
from papeer.core.fileio import atomic_write_json
from papeer.providers import create_provider
from papeer.translation.translation import RetryState, translate_batch
from papeer.translation.translation_context import contextual_units
from papeer.layout.reading_flow import unit_pages, expand_pages


def run(snapshot: Path, output: Path):
    samples = json.loads((snapshot / "samples.json").read_text("utf-8"))
    output.mkdir(parents=True, exist_ok=True)
    cancel = threading.Event()
    settings = Settings.load(data_directory())
    provider = create_provider(settings, cancel)
    reports = {}
    for sample in samples:
        identity, selected = sample["id"], set(sample["pages"])
        folder = snapshot / identity
        print(f"EXTRACT {identity[:4]} pages {sorted(selected)}", flush=True)
        document_path = folder / "fresh-document.json"
        document = json.loads(document_path.read_text("utf-8")) if document_path.exists() else extract_pdf(folder / "original.pdf")
        atomic_write_json(document_path, document)
        all_units = contextual_units(document, translation_units(document))
        selected = expand_pages(all_units, selected)
        units = [u for u in all_units if unit_pages(u) & selected]
        fingerprint = hashlib.sha256(json.dumps(units, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        cache_path = folder / "sample-translations.json"
        cache = json.loads(cache_path.read_text("utf-8")) if cache_path.exists() else {}
        if cache and cache.get("fingerprint") != fingerprint:
            raise ValueError("Sample input changed; use a new snapshot to preserve the existing retry journal.")
        done = cache.get("translations", {})
        state = RetryState.from_cache(cache.get("retry_state"))

        def save():
            atomic_write_json(cache_path, {"fingerprint": fingerprint, "translations": done, "retry_state": state.to_cache()})

        def accept(values):
            done.update(values)
            save()

        try:
            chunks = list(batches([u for u in units if u["id"] not in done], limit=12000))
            for index, chunk in enumerate(chunks, 1):
                print(f"TRANSLATE {identity[:4]} batch {index}/{len(chunks)} ({len(chunk)} units)", flush=True)
                translate_batch(provider, chunk, cancel, lambda message: print(message, flush=True), accept, state, save)
            missing = [u["id"] for u in units if u["id"] not in done]
            if missing:
                raise ValueError(f"Missing sample translations: {missing}")
            grouped = {}
            for unit in units:
                grouped.setdefault(unit["block"], []).append(done[unit["id"]])
            report = build_translated_pdf(folder / "original.pdf", document,
                {key: "\n".join(parts) for key, parts in grouped.items()}, output / f"{identity}.pdf", page_numbers=selected)
            report.update(title=document["title"], source_pages=sorted(selected), model=settings.model,
                          translated_units=len(units), error=None)
            reports[identity] = report
            print(f"DONE {identity[:4]} scaled={report['scaled_blocks']}", flush=True)
        except Exception as error:
            reports[identity] = {"source_pages": sorted(selected), "error": str(error)}
            print(f"FAILED {identity[:4]}: {error}", flush=True)
        atomic_write_json(output / "reports.json", reports)
    return reports


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    run(args.snapshot.resolve(), args.output.resolve())
