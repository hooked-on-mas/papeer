"""The text of HTML documents as the library search and the chat read it (papeer/core/html_text.py)."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import unicodedata

import pytest

from papeer.core import html_text
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library

SAMPLE_PDF = Path(__file__).parent / "fixtures" / "sample.pdf"


@pytest.fixture(autouse=True)
def fresh_cache():
    html_text.clear_cache()
    yield
    html_text.clear_cache()


# --- Extraction ---

def test_head_script_style_template_noscript_and_comments_are_not_text():
    source = ("<!doctype html><html><head><meta charset=utf-8><title>隠しタイトル</title>"
              "<style>.secret{color:red}</style><script>var hidden = 'スクリプト秘密';</script></head>"
              "<body><!-- コメント秘密 --><p>見える本文</p><template><p>テンプレート秘密</p></template>"
              "<noscript>noscript秘密</noscript><script type='module'>import 'x'; // モジュール秘密</script>"
              "<style media='print'>p{display:none}</style><p>最後</p></body></html>")
    assert html_text.extract(source) == "見える本文\n\n最後"


def test_elements_hidden_by_attribute_or_inline_style_are_not_text_and_what_follows_is():
    source = ("<p>表示1</p><div hidden><p>属性</p><span>入れ子</span></div><p>表示2</p>"
              "<span aria-hidden=\"true\">aria隠し</span><span aria-hidden=\"false\">ariaあり</span>"
              "<div style=\"color:red; display : none !important\">スタイル隠し</div>"
              "<p style='VISIBILITY: hidden'>可視性隠し</p><p style='color:red'>色だけ</p>"
              "<img hidden src=x><p>表示3</p><p hidden>閉じない隠し<p>次の段落</p>")
    text = html_text.extract(source)
    for shown in ("表示1", "表示2", "表示3", "ariaあり", "色だけ", "次の段落"):
        assert shown in text
    for hidden in ("属性", "入れ子", "aria隠し", "スタイル隠し", "可視性隠し", "閉じない隠し"):
        assert hidden not in text


def test_entities_are_decoded_and_spacing_of_blocks_is_kept():
    source = ("<h1>見出し &amp; Tom&nbsp;&amp;&nbsp;Jerry</h1><p>1 &lt; 2 &#x65e5;&#26412;</p>"
              "<ul><li>一つ目<li>二つ目</ul><table><tr><th>列A</th><th>列B</th></tr>"
              "<tr><td>a1<td>b1</tr></table><p>行<br>替え</p><pre>  x = 1\n  y = 2</pre>")
    text = html_text.extract(source)
    assert text.splitlines()[0] == "見出し & Tom & Jerry"
    assert "1 < 2 日本" in text
    assert "\n一つ目\n二つ目\n" in text
    assert "列A 列B\na1 b1" in text
    assert "行\n替え" in text
    assert text.endswith("x = 1\ny = 2")
    assert "&amp;" not in text and "&nbsp;" not in text


def test_invalid_and_unbalanced_markup_gives_the_text_it_has():
    for source in ("<div><p>閉じない <b>強調</i></div></span>後ろ", "<<<>>> <a href=\"x<p>壊れた属性</p>",
                   "<p>a</p></p></p></div></div>b", "<table><td>セル<tr><td>次", "", "<script>未完了のスクリプト",
                   "<p hidden>隠し" * 200 + "<p>見える", "\x00<\x00p>制御文字\x00</p>"):
        assert isinstance(html_text.extract(source), str)
    assert "後ろ" in html_text.extract("<div><p>閉じない <b>強調</i></div></span>後ろ")
    assert html_text.extract("<p hidden>隠し" * 200 + "<p>見える") == "見える"
    assert html_text.extract("<script>未完了のスクリプト") == ""


def test_the_text_of_one_document_is_bounded():
    text = html_text.extract("<p>" + "あ" * (html_text.MAX_TEXT * 2) + "</p>")
    assert 0 < len(text) <= html_text.MAX_TEXT


def test_pieces_of_a_document_stay_whole_lines_where_they_can():
    text = "\n".join(f"行{n} " + "あ" * 40 for n in range(100))
    pieces = html_text.split(text, 500)
    assert all(len(piece) <= 500 for piece in pieces)
    assert "\n".join(pieces) == text
    assert html_text.split("x" * 1200, 500) == ["x" * 500, "x" * 500, "x" * 200]
    assert html_text.split("   \n\n  ") == []


def test_terms_of_a_question_and_the_label_of_a_link():
    terms = html_text.question_terms("追従誤差は何ですか Adaptive-controller x")
    assert "adaptive-controller" in terms and "追従誤差は何ですか" in terms
    assert {"追従", "誤差"} <= set(terms) and "です" not in terms and "x" not in terms
    assert html_text.score("追従誤差。追従誤差", ["追従"]) == 2 * 2 > html_text.score("追従", ["追従"])
    label = html_text.markdown_label("[x](javascript:alert(1)) <b>*_`$ ![i](u)</b> #|~\\")
    assert not set(label) & set("[]()<>*_`$!#|~\\")
    assert len(html_text.markdown_label("あ" * 500)) == 80


# --- The files' text ---

def library_with_document(tmp_path, content):
    lib = Library(tmp_path / "library")
    owner, _ = lib.import_pdf(SAMPLE_PDF)
    row = lib.add_attachment(owner, "html", "資料", content)
    return lib, owner, row["id"], PaperFiles(lib.folder(owner)).attachment(row["id"], "html")


def test_the_text_follows_the_file_whatever_its_size_and_time_and_a_missing_file_is_none(tmp_path):
    lib, owner, identity, path = library_with_document(tmp_path, "<p>最初の本文</p>")
    assert html_text.file_text(lib, owner, identity) == "最初の本文"
    stat = path.stat()
    # Same size, same modification time: only the bytes differ (a restore may leave exactly this).
    path.write_text("<p>全く別物だ</p>", "utf-8")
    assert path.stat().st_size == stat.st_size
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert html_text.file_text(lib, owner, identity) == "全く別物だ"
    path.unlink()
    assert html_text.file_text(lib, owner, identity) is None
    path.write_text("<p>戻した本文</p>", "utf-8")
    assert html_text.file_text(lib, owner, identity) == "戻した本文"


def test_a_file_that_is_not_utf8_is_still_read_and_the_text_is_bounded_not_the_file(tmp_path, monkeypatch):
    lib, owner, identity, path = library_with_document(tmp_path, "<p>x</p>")
    path.write_bytes(b"\xef\xbb\xbf<p>\x82\xa0\xe3\x81\x82 BOM</p>")
    assert "BOM" in html_text.file_text(lib, owner, identity)
    monkeypatch.setattr(html_text, "MAX_TEXT", 40)
    path.write_text("<p>" + "a" * 100 + "</p><p>後ろ</p>", "utf-8")
    assert html_text.file_text(lib, owner, identity) == "a" * 40


# --- Embedded images and a file larger than any read limit ---

def image(size, quote='"'):
    return f"<img alt='図' src={quote}data:image/png;base64," + "A" * size + quote


def readable(text):
    assert "base64" not in text and "AAAA" not in text and "data:image" not in text and "<img" not in text, text[:200]


def test_the_text_after_an_embedded_image_of_more_than_eight_megabytes_is_the_documents_text(tmp_path):
    source = ("<!doctype html><body><h1>見出し</h1>" + image(8 * 1024 * 1024 + 10)
              + "><p>SEARCH_AFTER_LARGE_EMBEDDED_IMAGE</p></body>")
    assert len(source) > 8 * 1024 * 1024
    assert html_text.extract(source) == "見出し\n\nSEARCH_AFTER_LARGE_EMBEDDED_IMAGE"
    lib, owner, identity, path = library_with_document(tmp_path, source)
    assert path.stat().st_size > 8 * 1024 * 1024
    assert html_text.file_text(lib, owner, identity) == "見出し\n\nSEARCH_AFTER_LARGE_EMBEDDED_IMAGE"


def test_images_in_every_kind_of_attribute_and_quote_are_not_text_and_the_rest_is_kept(tmp_path):
    big = 64 * 1024 * 3
    source = ("<p>一</p>" + image(big) + ">" + image(big, "'") + ">"
              + f"<picture><source srcset='data:image/webp;base64,{'B' * big} 2x'><img src=x></picture>"
              + f"<a href=\"data:text/html;base64,{'C' * big}\">リンク文字</a>"
              + f"<div style=\"background:url(data:image/png;base64,{'D' * big})\">背景の上の文字</div>"
              + f"<object data=\"data:application/pdf;base64,{'E' * big}\">代替</object>"
              + f"<svg><image href='data:image/png;base64,{'F' * big}'/></svg><p>二</p>")
    lib, owner, identity, _ = library_with_document(tmp_path, source)
    text = html_text.file_text(lib, owner, identity)
    readable(text)
    assert not set("BCDEF") & set(text)
    assert text.split() == ["一", "リンク文字", "背景の上の文字", "二"]


def test_hidden_markup_and_a_long_value_in_one_tag_keep_their_meaning(tmp_path):
    big = "A" * (64 * 1024 * 2)
    source = (f"<p style=\"display:none;background:url(data:image/png;base64,{big})\">隠れた文字</p>"
              f"<p style=\"color:red\" title=\"{big}\" data-x='{big}'>見える文字</p>"
              f"<div hidden title='{big}'><p>隠れた段落</p></div><p aria-hidden=\"true\" data-y=\"{big}\">隠れ</p><p>最後</p>")
    lib, owner, identity, _ = library_with_document(tmp_path, source)
    assert html_text.file_text(lib, owner, identity).split() == ["見える文字", "最後"]


def test_a_tag_that_never_ends_is_not_text_wherever_the_file_ends(tmp_path):
    big = "A" * 300_000
    tails = (f"<img src=\"data:image/png;base64,{big}", f"<img src='data:image/png;base64,{big}'", f"<img src=data:image/png;{big}",
             f"<div title=\"秘密{big}", "<!-- 閉じないコメント秘密", "<!doctype html", "<p", "<a href=\"x")
    for number, tail in enumerate(tails):
        lib, owner, identity, path = library_with_document(tmp_path / f"case{number}", "")
        path.write_text(f"<p>前の本文</p>{tail}", "utf-8")
        text = html_text.file_text(lib, owner, identity)
        assert text == "前の本文", (tail[:30], text[:100])


def test_changing_only_what_follows_the_first_eight_megabytes_changes_the_text(tmp_path):
    head = "<!doctype html><body>" + image(9 * 1024 * 1024) + ">"
    lib, owner, identity, path = library_with_document(tmp_path, head + "<p>甲乙の末尾の語</p></body>")
    first = html_text.file_text(lib, owner, identity)
    assert first == "甲乙の末尾の語"
    key = (str(lib.root), identity)
    old_digest = html_text._cache[key][0]
    stat = path.stat()
    path.write_text(head + "<p>丙丁の末尾の語</p></body>", "utf-8")
    assert path.stat().st_size == stat.st_size
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert html_text.file_text(lib, owner, identity) == "丙丁の末尾の語"
    assert html_text._cache[key][0] != old_digest
    assert html_text.file_text(lib, owner, identity) == "丙丁の末尾の語"  # And it is cached for what it is now.
    assert len(html_text._cache) == 1


# --- The quote of an attribute value, however far from its `=` and however the pieces cut ---

SPACING = {"seventeen spaces": " " * 17, "many spaces": " " * 300, "tabs": "\t" * 40, "line breaks": "\n" * 40,
           "all kinds": " \t\r\n\f" * 60, "one space": " ", "none": ""}
# What an SVG data URI looks like: markup, with `>` of its own, inside the value (and no quote of the same kind).
SVG_VALUE = "data:image/svg+xml;utf8,<svg xmlns=http://www.w3.org/2000/svg><path d=M0,0h1v1z /></svg>"


@pytest.mark.parametrize("quote", ['"', "'"])
@pytest.mark.parametrize("spacing", list(SPACING.values()), ids=list(SPACING))
def test_quoted_values_with_markup_and_arbitrary_whitespace_keep_the_following_body(spacing, quote):
    value = "A" * 150 + ">" + "B" * 150 + SVG_VALUE + "C" * 50 + ">"
    source = f"<p>前</p><img alt=図 src={spacing}{quote}{value}{quote}><p>後ろの本文</p>"
    assert html_text.extract(source) == "前\n\n後ろの本文"


@pytest.mark.parametrize("spacing", [" " * 17, "\n" * 17, "\t \n" * 17, " \t\r\n" * (1024 * 1024 + 7)],
                         ids=["spaces", "line breaks", "mixed", "spanning several pieces"])
def test_a_big_value_with_markup_in_it_after_spaces_keeps_the_text_that_follows(tmp_path, spacing):
    value = "A" * (5 * 1024 * 1024) + ">" + "B" * (4 * 1024 * 1024)
    head = f"<!doctype html><body><h1>見出し</h1><img alt='図' src={spacing}\"{value}\">"
    expected = "見出し\n\nACTUAL_AFTER_LARGE_IMAGE"
    assert html_text.extract(head + "<p>ACTUAL_AFTER_LARGE_IMAGE</p></body>") == expected
    lib, owner, identity, path = library_with_document(tmp_path, head + "<p>ACTUAL_AFTER_LARGE_IMAGE</p></body>")
    assert html_text.file_text(lib, owner, identity) == expected
    key = (str(lib.root), identity)
    assert html_text._cache[key][0] == hashlib.sha256(path.read_bytes()).hexdigest()  # The whole file is hashed.
    stat = path.stat()
    path.write_bytes((head + "<p>CHANGE_AFTER_LARGE_IMAGE</p></body>").encode("utf-8"))  # Only what follows the image changes.
    assert path.stat().st_size == stat.st_size
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert html_text.file_text(lib, owner, identity) == "見出し\n\nCHANGE_AFTER_LARGE_IMAGE"
    assert html_text._cache[key][0] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert len(html_text._cache) == 1


def test_values_with_markup_in_every_kind_of_attribute_are_not_text_and_what_follows_is(tmp_path):
    big = 64 * 1024 * 3
    gap = " " * 40 + "\n" + "\t" * 20

    def value(letter):
        return letter * big + ">" + letter * big

    source = ("<p>一</p>"
              + f"<img alt = '図'  src ={gap}\"data:image/png;base64,{value('A')}\">"
              + f"<picture><source srcset ={gap}'data:image/webp;base64,{value('B')} 2x'><img src=x></picture>"
              + f"<a href{gap}={gap}\"data:text/html;base64,{value('C')}\">リンク文字</a>"
              + f"<div style ={gap}\"background:url(data:image/png;base64,{value('D')})\">背景の上の文字</div>"
              + f"<svg><image href ={gap}'data:image/png;base64,{value('E')}'/></svg><p>二</p>")
    lib, owner, identity, _ = library_with_document(tmp_path, source)
    text = html_text.file_text(lib, owner, identity)
    readable(text)
    assert not set("ABCDE") & set(text)
    assert text.split() == ["一", "リンク文字", "背景の上の文字", "二"]
    assert html_text.extract(source) == text


def test_small_attributes_with_a_greater_than_sign_keep_the_body_and_hidden_things_stay_hidden():
    source = ("<style>.a > .b { content: \"x>y\" }</style><script>if (a<b && c = \"z>\") { d = 'e'; }</script>"
              "<a title=\"a>b\" href='c>d'>リンク</a><p data-x = \"1 > 0\" class=k>本文</p>"
              "<div hidden title=\"p>q\">隠し1</div><div style=\"display:none\" data-t = '>'>隠し2</div>"
              "<p aria-hidden=true>隠し3</p><p title = '>' >最後</p>")
    assert html_text.extract(source) == "リンク\n\n本文\n\n最後"



def test_many_blank_elements_do_not_pile_up_parts():
    reader = html_text._Reader()
    reader.feed("<b> </b>" * 10_000 + "<p>本文")
    assert len(reader.parts) < 20


def test_the_cache_is_bounded_and_documents_come_back_after_being_dropped(tmp_path, monkeypatch):
    lib, owner, first, _ = library_with_document(tmp_path, "<p>一</p>")
    others = [lib.add_attachment(owner, "html", f"資料{n}", f"<p>本文{n}</p>")["id"] for n in range(4)]
    monkeypatch.setattr(html_text, "CACHE_ENTRIES", 2)
    for identity in [first, *others]:
        html_text.file_text(lib, owner, identity)
    assert len(html_text._cache) <= 2
    assert html_text.file_text(lib, owner, first) == "一"
    monkeypatch.setattr(html_text, "CACHE_ENTRIES", 512)
    monkeypatch.setattr(html_text, "CACHE_CHARS", 3)
    html_text.clear_cache()
    for identity in others:
        html_text.file_text(lib, owner, identity)
    assert html_text._cached_chars <= 3 + len("本文0")


def test_sources_are_the_documents_of_listed_items_with_text_only(tmp_path):
    lib, owner, identity, path = library_with_document(tmp_path, "<p>本文</p>")
    empty = lib.add_attachment(owner, "html", "空", "<script>1</script>")["id"]
    gone = lib.add_attachment(owner, "html", "消えた", "<p>消える</p>")["id"]
    PaperFiles(lib.folder(owner)).attachment(gone, "html").unlink()
    memo = lib.add_attachment(owner, "md", "メモ", "メモ本文")["id"]
    found = html_text.sources(lib)
    assert [(item.attachment_id, item.title, item.text, item.owner_id) for item in found] == [(identity, "資料", "本文", owner)]
    assert {empty, gone, memo}.isdisjoint(item.attachment_id for item in found)
    assert html_text.sources(lib, {"0" * 32}) == []
    assert unicodedata.is_normalized("NFC", found[0].title)


@pytest.mark.parametrize("markup", [
    "<script>const x=\"<div title='\";</script>",
    "<style>x::before {content:\"<div title='\";}</style>",
    "<!-- <div title=' -->",
])
def test_tags_inside_raw_text_or_comments_do_not_hide_following_readable_body(markup):
    assert html_text.extract(markup + "<p>VISIBLE_AFTER_HIDDEN</p>") == "VISIBLE_AFTER_HIDDEN"
