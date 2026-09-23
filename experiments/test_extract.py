
import json
import pymupdf as fitz
from pathlib import Path

folder = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures' / 'sample-paper'
with open(folder / 'document.json', 'r', encoding='utf-8') as f:
    document = json.load(f)

media_dir = folder / 'media'
media_dir.mkdir(exist_ok=True)
blocks_by_page = {}
for b in document.get('blocks', []):
    if b.get('kind') in {'figure', 'table'}:
        blocks_by_page.setdefault(b['page'], []).append(b)

if blocks_by_page:
    with fitz.open(folder / 'original.pdf') as pdf:
        for page_num, blocks in blocks_by_page.items():
            if 1 <= page_num <= len(pdf):
                page = pdf[page_num - 1]
                for b in blocks:
                    rect = fitz.Rect(b['bbox'])
                    pix = page.get_pixmap(clip=rect, dpi=150)
                    image_path = media_dir / f'{b['id']}.png'
                    pix.save(str(image_path))
                    print('Saved', image_path)

