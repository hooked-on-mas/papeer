"""Audit token conservation and render completed fresh-review artifacts."""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import pymupdf as fitz
import pypdfium2 as pdfium

from paperdesk.layout.math_layout import MATH_TOKEN, restore_formula_text
from paperdesk.pdf.pdf_engine import save_json, translation_units
from paperdesk.layout.reading_flow import materialize_flows, translation_blocks, unit_pages
from paperdesk.translation.translation import validate_translations


def audit(review, papers):
    manifest=json.loads((review/'manifest.json').read_text('utf-8'))
    grouped=defaultdict(list)
    for item in manifest['results']:
        grouped[item['id']].append(item)
    results=[]
    (review/'pdfium').mkdir(exist_ok=True)
    with fitz.open() as comparison:
        toc=[]
        for identity, entries in grouped.items():
            document=None;values={};selected={e['page'] for e in entries}
            for entry in sorted(entries,key=lambda e:e['page']):
                label=f"{identity[:4]}-p{entry['page']}"
                current=json.loads((review/(label+'-document.json')).read_text('utf-8'))
                if document is not None:
                    assert document==current, 'Different extraction within one paper'
                document=current
                done=json.loads((review/(label+'-translation.json')).read_text('utf-8'))['translations']
                units=[u for u in translation_units(document) if entry['page'] in unit_pages(u)]
                validate_translations(json.dumps(dict(translations=[dict(id=k,text=v) for k,v in done.items()])),units)
                assert all(k not in values or values[k]==v for k,v in done.items()), 'Conflicting shared translation'
                values.update(done)
                source=papers/identity/'original.pdf'
                assert hashlib.sha256(source.read_bytes()).hexdigest()==entry['source_sha256'], 'Original changed'
                path=review/(label+'.pdf')
                assert hashlib.sha256(path.read_bytes()).hexdigest()==entry['pdf_sha256'], 'Output changed'
                with pdfium.PdfDocument(str(path)) as pdf:
                    assert len(pdf)==1
                    bitmap=pdf[0].render(scale=1.5)
                    bitmap.to_pil().save(review/'pdfium'/(label+'.png'))
                    bitmap.close()
                with fitz.open(review/(label+'-comparison.pdf')) as pair:
                    toc.append([1,label,len(comparison)+1]);comparison.insert_pdf(pair)
            translations=defaultdict(list)
            for unit in translation_units(document):
                if unit['id'] in values:translations[unit['block']].append(values[unit['id']])
            translations={k:'\n'.join(v) for k,v in translations.items()}
            rendered,assigned=materialize_flows(document,translations)
            raw={b['id']:b for b in document['blocks']}
            placed={b['id']:b for b in rendered['blocks']}
            virtual={b['id']:b for b in translation_blocks(document)}
            flows=[]
            for group in document['continuations']:
                first=group['blocks'][0]
                if first not in translations:continue
                assert set(group['pages'])<=selected, 'Partial continuation group'
                joined=''.join(assigned[key] for key in group['blocks'])
                assert joined==translations[first], 'Translation lost or duplicated during distribution'
                expected=Counter(f['token'] for f in virtual[first].get('formulas',[]))
                assert Counter(MATH_TOKEN.findall(joined))==expected, 'Formula loss or duplication'
                flows.append(dict(blocks=group['blocks'],pages=group['pages'],boundary=group['boundary'],
                    source=virtual[first]['text'],
                    japanese=restore_formula_text(joined,virtual[first]),
                    formulas=sum(expected.values()),
                    segments=[dict(block=key,page=placed[key]['page'],
                        source=raw[key]['text'],japanese=restore_formula_text(assigned[key],placed[key]),
                        moved_formulas=sum(f.get('source_page',placed[key]['page'])!=placed[key]['page']
                                           for f in placed[key].get('formulas',[]))) for key in group['blocks']]))
            results.append(dict(id=identity,pages=sorted(selected),units=len(values),
                groups=flows,warnings=[w for e in entries for w in e['report']['readability_warnings']],
                source_unchanged=True,pdfium_rendered=True,token_conservation=True))
        comparison.set_toc(toc)
        comparison.save(review/'all-comparisons.pdf',garbage=4,deflate=True)
    result=dict(papers=len(results),pages=sum(len(r['pages']) for r in results),
        groups=sum(len(r['groups']) for r in results),
        joined_boundaries=sum(len(g['blocks'])-1 for r in results for g in r['groups']),
        units=sum(r['units'] for r in results),results=results)
    save_json(review/'integrity-audit.json',result)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--review',type=Path,required=True)
    parser.add_argument('--papers',type=Path,required=True)
    args=parser.parse_args()
    result=audit(args.review,args.papers)
    print({k:v for k,v in result.items() if k!='results'})
