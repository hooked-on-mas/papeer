"""Asian prose must stay translatable while adjacent equations retain their glyphs."""
import json
import threading
from unittest.mock import Mock

import pytest
import pymupdf as fitz

from papeer.layout.math_layout import (
    _math_ranges, _text_size, annotate_math_fonts, formula_only_block, layout_blocks,
)
from papeer.pdf.pdf_engine import extract_pdf, translation_units
from papeer.translation.translation import _locked_request
from papeer.layout.ocr_pages import garbled_block


@pytest.mark.parametrize(('font', 'prose'), [
    ('korea', '굴착 작업의 위치와 깊이를 선택하여 목표 지형을 평탄화한다.'),
    ('china-s', '土石方调配是一个动态系统，需要根据施工条件调整方案。'),
    ('japan', '掘削位置と深さを選び、目標の地形になるまで作業を繰り返す。'),
])
def test_native_asian_prose_font_is_not_inferred_to_be_mathematical(tmp_path, font, prose):
    path = tmp_path / 'asian-prose.pdf'
    with fitz.open() as pdf:
        page = pdf.new_page()
        for y in (60, 90, 120):
            page.insert_text((40, y), prose, fontname=font, fontsize=10)
        page.insert_text((70, 170), 'x = 1', fontname='tiit', fontsize=11)
        items = page.get_text('rawdict')['blocks']
        annotate_math_fonts(items)
        spans = [s for item in items for line in item.get('lines', []) for s in line['spans']]
        assert not any(s['math_font'] for s in spans
                       if any(c['c'].isalpha() and c['c'] in prose for c in s['chars']))
        pdf.save(path)
    document = extract_pdf(path)
    units = translation_units(document)
    assert sum(u['text'].replace('\n', '').count(prose) for u in units) == 3
    assert not any(b['kind'] == 'formula' and any(c in b['text'] for c in prose if c.isalpha())
                   for b in document['blocks'])
    assert any(b['kind'] == 'formula' and 'x = 1' in b['text'] for b in document['blocks'])


@pytest.mark.parametrize('text', [
    '상태는 (높이가 x = 1 이면) 갱신된다.',
    '条件为（高度 x = 1 时）更新状态。',
    '状態は（高さが x = 1 の場合）更新する。',
])
@pytest.mark.parametrize('font_math', [False, True])
def test_inline_math_never_swallows_asian_prose_or_parentheses(text, font_math):
    chars = [dict(c=c, font='Symbol' if font_math else 'Subset', flags=2 if font_math else 0,
                  size=10, math_font=font_math) for c in text]
    assert [text[a:b] for a, b in _math_ranges(chars)] == ['x = 1']


def test_korean_sentence_and_display_equation_in_one_item_stay_separate():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 80), '상태는 다음 식으로 정의한다.', fontname='korea', fontsize=10)
        page.insert_text((70, 105), 'x = 1', fontname='tiit', fontsize=11)
        lines = [line for item in page.get_text('rawdict')['blocks'] for line in item['lines']]
        annotate_math_fonts([{'lines': lines}])
        blocks = layout_blocks({'lines': lines}, 1, 1)
    assert [b['kind'] for b in blocks] == ['text', 'formula']
    assert blocks[0]['formulas'] == []


@pytest.mark.parametrize('prose', ['상태를 갱신한다', '选择掘削位置', '掘削位置を選ぶ'])
def test_legacy_math_tokens_do_not_make_asian_prose_formula_only(prose):
    block = dict(text=prose, translation_text='[[PD_MATH_p1b1_0]] ' + prose,
                 formulas=[dict(token='[[PD_MATH_p1b1_0]]')])
    assert not formula_only_block(block)


def test_large_operator_does_not_make_chinese_prose_look_like_a_subscript():
    chars = [dict(c=c, size=10, math_font=False) for c in '目标地形的高度误差']
    chars.append(dict(c='∑', size=24, math_font=True))
    assert _text_size(chars) == 10


def test_formula_recovery_still_translates_korean_prose():
    provider = Mock()
    parts = [dict(kind='text', text='상태는 '), dict(kind='math', index=0),
             dict(kind='text', text=' 에서 갱신된다.')]
    fragments, _ = _locked_request(provider, {}, parts, threading.Event())
    assert [f['text'] for f in fragments] == ['상태는 ', ' 에서 갱신된다.']
    assert json.loads(provider.generate.call_args.args[1])['texts'] == fragments


def test_hwp_private_use_equation_does_not_hide_adjacent_korean_prose():
    text = '보상은 \ue011\ue047\ue067\ue011\ue0f7\ue0f8\ue0e9\ue0f4로 정의된다.'
    chars = [dict(c=c, font='ABCDEF+HyhwpEQ' if 0xE000 <= ord(c) <= 0xF8FF else 'Batang',
                  flags=0, size=10, math_font=0xE000 <= ord(c) <= 0xF8FF) for c in text]
    ranges = _math_ranges(chars)
    assert [text[a:b] for a, b in ranges] == ['\ue011\ue047\ue067\ue011\ue0f7\ue0f8\ue0e9\ue0f4']
    a, b = ranges[0]
    block = dict(kind='text', text=text, translation_text=text[:a] + '[[PD_MATH_p1b1_0]]' + text[b:])
    assert not garbled_block(block)


def test_unidentified_private_use_font_still_requires_ocr():
    text = '\ue011\ue047\ue067\ue011\ue0f7\ue0f8\ue0e9\ue0f4'
    assert garbled_block(dict(kind='text', text=text))
