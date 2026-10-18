"""Seeded, fresh-original feasibility sampling across multiple papers.

Inventories full documents, samples boundary groups by kind, and uses an
interior control page when no group is found. Every run retranslates from
original.pdf; neither saved extraction nor translation caches are inputs.
"""
from __future__ import annotations
import argparse
from collections import Counter
from pathlib import Path
import random

from papeer.pdf.pdf_engine import extract_pdf, translation_units
from papeer.core.fileio import atomic_write_json
from papeer.layout.reading_flow import expand_pages
from tools.review_fresh_layout import review


def select_cases(documents, seed):
    rng = random.Random(seed)
    cases, inventory = [], []
    for identity, document in sorted(documents.items()):
        chosen = []
        for kind in ('page', 'column'):
            groups = [g for g in document['continuations'] if g['boundary'] == kind]
            if groups:
                chosen.append(rng.choice(groups)['pages'][0])
        if not chosen:
            count = document['page_count']
            chosen = [rng.randrange(2, count) if count > 2 else 1]
        chosen = sorted(set(chosen))
        expanded = expand_pages(translation_units(document), chosen)
        cases.extend(f'{identity}:{number}' for number in chosen)
        inventory.append(dict(id=identity, pages=document['page_count'],
            requested=chosen, expanded=sorted(expanded),
            columns=dict(Counter(p['reading_order']['columns'] for p in document['pages'])),
            groups=document['continuations'], decisions=document['continuation_decisions']))
    return dict(seed=seed, cases=cases, inventory=inventory)


def study(papers, output, seed=20260920, count=10):
    papers, output = papers.resolve(), output.resolve()
    if output == papers or papers in output.parents or output in papers.parents:
        raise ValueError('Study output must be separate from the paper library.')
    sources = sorted(papers.glob('*/original.pdf'))
    if len(sources) < count:
        raise ValueError(f'At least {count} original PDFs are required.')
    if len(sources) > count:
        sources = sorted(random.Random(seed).sample(sources, count))
    output.mkdir(parents=True, exist_ok=False)
    documents = {}
    for source in sources:
        print(f'INVENTORY {source.parent.name}', flush=True)
        documents[source.parent.name] = extract_pdf(source)
    selection = select_cases(documents, seed)
    atomic_write_json(output/'selection.json', selection)
    return review(papers, output/'review', seed, count, selection['cases'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--papers', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seed', type=int, default=20260920)
    parser.add_argument('--count', type=int, default=10)
    args = parser.parse_args()
    study(args.papers, args.output, args.seed, args.count)
