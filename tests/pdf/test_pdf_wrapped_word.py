"""A translated word ending must not be restored as if it were a plot label."""
import pymupdf as fitz

from papeer.pdf.pdf_engine import build_translated_pdf


def test_wrapped_heading_tail_is_translated_but_isolated_symbol_stays_original(tmp_path):
    source = tmp_path / 'wrapped.pdf'
    blocks = []
    with fitz.open() as pdf:
        page = pdf.new_page(width=400, height=300)
        for identity, x, y, text in [('head', 40, 80, '3.1 Scenario Descrip-'),
                                     ('tail', 80, 99, 'tion'), ('symbol', 40, 170, 'XY')]:
            page.insert_text((x, y), text, fontsize=14)
            width = fitz.get_text_length(text, fontsize=14)
            blocks.append(dict(id=identity, page=1, kind='text', text=text, translation_text=text,
                               font_size=14, bbox=[x, y - 15, x + width, y + 4], formulas=[]))
        pdf.save(source)
    document = dict(title='Wrapped heading', page_count=1, blocks=blocks,
                    pages=[dict(number=1, width=400, height=300)])
    output = tmp_path / 'translated.pdf'
    report = build_translated_pdf(source, document, dict(head='3.1 シナリオの', tail='説明', symbol='変数'), output)
    assert 'tail' not in report['preserved_label_blocks']
    assert 'symbol' in report['preserved_label_blocks']
    with fitz.open(output) as pdf:
        text = pdf[0].get_text()
        assert '説明' in text
        assert 'tion' not in text
        assert 'XY' in text
