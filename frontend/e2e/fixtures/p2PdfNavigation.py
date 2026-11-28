"""Author a real PDF consumed only through ordinary UI import, without app state seeding."""
import sys
import pymupdf

pdf = pymupdf.open()
for _ in range(2):
    pdf.new_page(width=595, height=842)
for number in range(2):
    page = pdf[number]
    page.insert_text((50, 70), f'P2 navigation page {number + 1}', fontsize=16)
    page.insert_text((50, 170), '反復検索 upper anchor', fontname='japan', fontsize=16)
    page.insert_text((50, 490), '反復検索 lower anchor', fontname='japan', fontsize=16)
    if number == 0:
        page.insert_link({'kind': pymupdf.LINK_GOTO, 'from': pymupdf.Rect(45, 90, 300, 120), 'page': 1, 'to': pymupdf.Point(50, 300)})
        page.insert_link({'kind': pymupdf.LINK_URI, 'from': pymupdf.Rect(45, 550, 300, 580), 'uri': 'https://example.org/p2-reference'})
        page.insert_link({'kind': pymupdf.LINK_URI, 'from': pymupdf.Rect(45, 600, 300, 630), 'uri': 'javascript:alert(1)'})
pdf.set_toc([[1, 'P2 first page', 1], [1, 'P2 second page', 2]])
pdf.save(sys.argv[1])
pdf.close()
