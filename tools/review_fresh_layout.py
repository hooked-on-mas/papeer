"""Fresh random-page visual review: never read saved translations or caches."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import random
import threading
import pymupdf as fitz
from papeer.core.config import Settings, data_directory
from papeer.pdf.pdf_engine import extract_pdf, translation_units, batches, build_translated_pdf, bilingual_pdf
from papeer.core.fileio import atomic_write_json
from papeer.providers import create_provider
from papeer.translation.translation import translate_batch, RetryState
from papeer.translation.translation_context import contextual_units
from papeer.layout.reading_flow import unit_pages, expand_pages


def review(papers: Path, output: Path, seed: int, count: int, cases: list[str], settings: Settings | None = None):
    papers, output = papers.resolve(), output.resolve()
    if output == papers or papers in output.parents or output in papers.parents:
        raise ValueError('Output must be separate from the paper library.')
    output.mkdir(parents=True, exist_ok=False)
    if settings is None:
        settings = Settings.load(data_directory())
    cancel = threading.Event()
    provider = create_provider(settings, cancel)
    sources = {}
    candidates = []
    for source in sorted(papers.glob('*/original.pdf')):
        sources[source.parent.name] = source
        with fitz.open(source) as pdf:
            candidates.extend((source.parent.name, p) for p in range(1, len(pdf) + 1))
    selected = []
    if cases:
        for case in cases:
            prefix, page = case.split(':')
            matches = [key for key in sources if key.startswith(prefix)]
            if len(matches) != 1 or (matches[0], int(page)) not in candidates:
                raise ValueError(f'Unknown or ambiguous page: {case}')
            selected.append((matches[0], int(page)))
    else:
        selected = random.Random(seed).sample(candidates, min(count, len(candidates)))
    manifest = dict(seed=seed, started=datetime.now(timezone.utc).isoformat(), complete=False,
                    fresh_translation=True, provider=settings.provider, model=settings.model,
                    base_url=settings.base_url, reasoning_effort=settings.reasoning_effort,
                    selected=selected, results=[])
    atomic_write_json(output/'manifest.json', manifest)
    requested = list(selected)
    manifest['requested'] = requested
    manifest['selected'] = []
    for identity in dict.fromkeys(identity for identity, _ in requested):
        source = sources[identity]
        print(f'{identity[:4]}: extract original.pdf', flush=True)
        document = extract_pdf(source)
        all_units = contextual_units(document, translation_units(document))
        numbers = expand_pages(all_units, {n for key,n in requested if key == identity})
        manifest['selected'].extend((identity,n) for n in sorted(numbers))
        atomic_write_json(output/'manifest.json', manifest)
        units = [u for u in all_units if unit_pages(u) & numbers]
        print(f'{identity[:4]}: fresh translation pages {sorted(numbers)}, {len(units)} units', flush=True)
        done = {}
        state = RetryState()
        def save():
            atomic_write_json(output/(identity[:4]+'-run.json'), dict(translations=done, retry_state=state.to_cache()))
        def accept(values):
            done.update(values)
            save()
        for chunk in batches(units):
            translate_batch(provider, chunk, cancel, lambda m: print(m, flush=True), accept, state, save)
        missing = [u['id'] for u in units if u['id'] not in done]
        if missing:
            raise RuntimeError(f'Incomplete fresh translation: {missing}')
        for number in sorted(numbers):
            label = f'{identity[:4]}-p{number}'
            page_units = [u for u in units if number in unit_pages(u)]
            values = {u['id']: done[u['id']] for u in page_units}
            atomic_write_json(output/(label+'-translation.json'), dict(translations=values, retry_state=state.to_cache()))
            grouped = {}
            for u in page_units: grouped.setdefault(u['block'], []).append(done[u['id']])
            translated = {k:'\n'.join(v) for k,v in grouped.items()}
            atomic_write_json(output/(label+'-document.json'), document)
            report = build_translated_pdf(source, document, translated, output/(label+'.pdf'), page_numbers={number})
            with fitz.open(source) as original:
                with fitz.open() as single:
                    single.insert_pdf(original, from_page=number-1, to_page=number-1)
                    single.save(output/(label+'-source.pdf'))
                original[number-1].get_pixmap(matrix=fitz.Matrix(1.8,1.8)).save(output/(label+'-source.png'))
            with fitz.open(output/(label+'.pdf')) as pdf:
                pdf[0].get_pixmap(matrix=fitz.Matrix(1.8,1.8)).save(output/(label+'.png'))
            bilingual_pdf(output/(label+'-source.pdf'), output/(label+'.pdf'), output/(label+'-comparison.pdf'))
            manifest['results'].append(dict(id=identity, page=number, source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                pdf_sha256=hashlib.sha256((output/(label+'.pdf')).read_bytes()).hexdigest(), report=report))
            atomic_write_json(output/'manifest.json', manifest)
            print(f'{label}: complete; warnings={report["readability_warnings"]}', flush=True)
    manifest['complete'] = True
    atomic_write_json(output/'manifest.json', manifest)
    return manifest

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--papers', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seed', type=int, default=20260916)
    parser.add_argument('--count', type=int, default=3)
    parser.add_argument('--case', action='append', default=[])
    args = parser.parse_args()
    review(args.papers, args.output, args.seed, args.count, args.case)
