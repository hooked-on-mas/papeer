import json
from collections import Counter

import pytest

from papeer.layout.math_layout import MATH_TOKEN
from papeer.translation.translation import validate_translations


A, B, C = ('[[PD_MATH_case_0]]', '[[PD_MATH_case_1]]', '[[PD_MATH_case_2]]')
SOURCE = f'3.a) If {A} and {B}, then set {C};'


def test_mixed_japanese_algorithm_condition_translates_if_then_and_keeps_every_formula():
    answer = f'3.a) if {A} and {B}, then {C}と設定する；'
    result = validate_translations(json.dumps({'translations': [dict(id='case', text=answer)]}),
                                   [dict(id='case', text=SOURCE)])['case']
    assert 'if' not in result and 'then' not in result and ' and ' not in result
    assert 'かつ' in result and 'の場合、' in result and result.endswith('と設定する。')
    assert Counter(MATH_TOKEN.findall(result)) == Counter(MATH_TOKEN.findall(SOURCE))


def test_algorithm_condition_cleanup_does_not_accept_duplicate_formulas():
    answer = f'3.a) if {A} and {B}, then {C}{C}と設定する；'
    with pytest.raises(ValueError, match='数式'):
        validate_translations(json.dumps({'translations': [dict(id='case', text=answer)]}),
                              [dict(id='case', text=SOURCE)])


def test_algorithm_condition_cleanup_does_not_rewrite_unrelated_source():
    answer = f'if {A}, then {B}と設定する。'
    result = validate_translations(json.dumps({'translations': [dict(id='case', text=answer)]}),
                                   [dict(id='case', text=f'The values {A} and {B} are known.')])
    assert result['case'] == answer
