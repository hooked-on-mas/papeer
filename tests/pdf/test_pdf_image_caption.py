"""Native caption boxes can overlap the blank edge of their raster diagram."""
import pymupdf as fitz

from papeer.pdf.pdf_engine import build_translated_pdf


def test_caption_already_clipped_below_figure_does_not_require_image_wrapping(tmp_path):
    source, target = tmp_path/'source.pdf', tmp_path/'translated.pdf'
    image = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 80, 40), False)
    image.clear_with(180)
    caption = 'Figure 7. Allocation plan for a production quarter.'
    with fitz.open() as pdf:
        page = pdf.new_page(width=600, height=800)
        page.draw_rect(page.rect, color=None, fill=(1, 1, 1))
        page.insert_image(fitz.Rect(75, 60, 515, 225), pixmap=image, keep_proportion=False)
        page.insert_text((150, 230), caption, fontsize=10)
        line = page.get_text('dict')['blocks'][-1]['lines'][0]
        pdf.save(source)
    document = dict(title='Allocation plan', page_count=1, pages=[dict(number=1, height=800)], blocks=[
        dict(id='figure', page=1, kind='figure', bbox=[75, 60, 515, 225], text='', font_size=10, formulas=[]),
        dict(id='caption', page=1, kind='text', bbox=list(line['bbox']), text=caption,
             translation_text=caption, font_size=10, formulas=[], regions=[list(line['bbox'])]),
    ])
    report = build_translated_pdf(source, document, {'caption':'図7．四半期のショベル配置計画。'}, target)
    assert report['overflow_blocks'] == 0
    assert not report['readability_warnings']
    with fitz.open(source) as before, fitz.open(target) as after:
        assert '四半期' in after[0].get_text()
        region = fitz.Rect(80, 70, 500, 210)
        assert before[0].get_pixmap(clip=region).samples == after[0].get_pixmap(clip=region).samples
