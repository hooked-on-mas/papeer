"""Real file-only inputs for ordinary PDF navigation failure/cancellation tests."""
import sys
from pathlib import Path
import pymupdf

directory = Path(sys.argv[1])
empty = pymupdf.open()
page = empty.new_page(width=595, height=842)
page.insert_text((40, 70), 'No outline document searchable text', fontsize=16)
empty.save(directory / 'no-outline.pdf')
empty.close()

document = pymupdf.open()
for index in range(32):
    page = document.new_page(width=595, height=842)
    page.insert_text((40, 45), f'OldNeedle navigation page {index + 1}', fontsize=12)
    if index in (0, 31):
        page.insert_text((40, 90), 'LatestNeedle final query anchor', fontsize=12)
    # A real text-heavy document gives cancellation an actual worker workload.
    for line in range(50):
        page.insert_text((40, 130 + line * 12), f'{index:02d}/{line:02d} ' + 'Real searchable PDF asynchronous content ' * 2, fontsize=6)
document.set_toc([[1, 'Navigation first', 1], [1, 'Navigation last', 32]])
document.save(directory / 'navigation-failures.pdf', deflate=True)
document.close()
