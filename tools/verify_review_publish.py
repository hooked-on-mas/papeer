"""Verify published and untouched pages against the review and pre-publish backup."""
import argparse
import hashlib
import json
from pathlib import Path
import pypdfium2 as pdfium
from paperdesk.pdf_engine import save_json


def verify(papers, review):
    receipts=json.loads((review/'applied.json').read_text('utf-8'))
    manifest=json.loads((review/'manifest.json').read_text('utf-8'))
    checks=[]
    for receipt in receipts:
        identity=receipt['paper'];folder=papers/identity;backup=Path(receipt['backup'])
        selected=set(receipt['pages'])
        expected_hash=next(r['source_sha256'] for r in manifest['results'] if r['id']==identity)
        assert hashlib.sha256((folder/'original.pdf').read_bytes()).hexdigest()==expected_hash
        preview_path=backup/'translation-preview.json'
        preview=json.loads(preview_path.read_text('utf-8')) if preview_path.exists() else None
        opened={}
        def pixels(path,index):
            key=str(path)
            if key not in opened:opened[key]=pdfium.PdfDocument(key)
            page=opened[key][index]
            bitmap=page.render(scale=1)
            im=bitmap.to_pil()
            result=im.size,im.tobytes()
            bitmap.close();page.close()
            return result
        try:
            new=pdfium.PdfDocument(str(folder/'translated.pdf'))
            count=len(new);new.close()
            for number in range(1,count+1):
                if number in selected:
                    expected,index=review/f'{identity[:4]}-p{number}.pdf',0
                elif preview and not preview['complete']:
                    if number in preview['pages']:
                        expected,index=folder/'translation-pages'/preview['run_id']/f'page-{number}.pdf',0
                    else:
                        expected,index=folder/'original.pdf',number-1
                else:
                    expected,index=backup/'translated.pdf',number-1
                    if not expected.exists():expected=folder/'original.pdf'
                assert pixels(folder/'translated.pdf',number-1)==pixels(expected,index), f'{identity} page {number} changed'
            checks.append(dict(id=identity,replaced=sorted(selected),untouched_pages_checked=count-len(selected),
                               source_unchanged=True,pixel_engine='PDFium',all_pixels_equal=True))
        finally:
            for doc in opened.values():doc.close()
    save_json(review/'publish-verification.json',checks)
    return checks


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--papers',required=True,type=Path)
    parser.add_argument('--review',required=True,type=Path)
    args=parser.parse_args()
    print(verify(args.papers,args.review))
