"""Parse one-based PDF page ranges without expanding unchecked ranges."""
import re
import unicodedata


def parse_page_selection(value: str, page_count: int) -> set[int]:
    value = unicodedata.normalize("NFKC", value).translate(str.maketrans({
        "、": ",", "～": "-", "~": "-", "–": "-", "—": "-", "−": "-"}))
    if not value.strip():
        raise ValueError("翻訳するページを入力してください。例: 1, 3-5, 8")
    pages = set()
    for part in value.split(","):
        match = re.fullmatch(r"\s*([0-9]+)\s*(?:-\s*([0-9]+)\s*)?", part)
        if not match:
            raise ValueError("ページ番号と範囲をカンマで区切ってください。例: 1, 3-5, 8")
        first, last = int(match[1]), int(match[2] or match[1])
        if not 1 <= first <= last <= page_count:
            raise ValueError(f"1～{page_count}ページの範囲を、小さい番号から指定してください。")
        pages.update(range(first, last + 1))
    return pages
