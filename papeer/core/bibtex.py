"""BibTeX entries for papers in the library, from what the library stores (nothing is looked up online)."""
from __future__ import annotations

from pathlib import Path
import re
import unicodedata

from papeer.core.bibliography import clean_arxiv_id, clean_doi
from papeer.core.destinations import inside_library
from papeer.core.fileio import atomic_write_text

# Words skipped when a citation key takes the first word of the title.
_STOP_WORDS = {"a", "an", "and", "are", "as", "at", "by", "for", "from", "in", "into", "is", "of", "on", "or",
               "the", "to", "toward", "towards", "via", "with"}
# LaTeX's special characters in a field's text. Braces become commands, not \{ and \}: BibTeX and biber
# count those as braces too, so an unbalanced one would still end the field early or run into the next
# entry ("Unbalanced { brace").
_ESCAPES = {"\\": r"\textbackslash{}", "{": r"\textbraceleft{}", "}": r"\textbraceright{}", "&": r"\&", "%": r"\%",
            "$": r"\$", "#": r"\#", "_": r"\_", "^": r"\textasciicircum{}", "~": r"\textasciitilde{}"}
_ESCAPE = re.compile("|".join(map(re.escape, _ESCAPES)))
# How a venue tells the kind of publication: proceedings of a meeting (by name, or an acronym with the
# year of the meeting: "ICLR 2021", "NeurIPS '20"), or else a journal.
_PROCEEDINGS = re.compile(r"(?i:\b(?:proceedings|proc\.|conference|conf\.|workshop|symposium|meeting|congress)\b)"
                          r"|^[A-Z][A-Za-z]*[A-Z][A-Za-z]*[ -]?'?(?:\d{2}|\d{4})$")
# Several authors typed in the author field ("A; B", "A、B", "A & B", "A and B") become BibTeX's "A and B".
_AUTHOR_SEPARATOR = re.compile(r"\s*(?:;|、|，|&|\band\b)\s*")
# "Smith et al." or "山田ほか": the authors after the first are not known, written "and others".
_ET_AL = re.compile(r"\s*,?\s*(?:(?i:\bet\s*al\b)\.?.*|(?:ほか|他)\s*)$")
# Jr., Sr., II, III, IV after a name ("John Smith Jr.", "Smith, Jr., John"), left out of the name.
_NAME_SUFFIX = re.compile(r"\s*,?\s+(?:(?i:jr|sr)\.?|II|III|IV)(?=\s|,|$)")

MAX_BIB_BYTES = 20 * 1024 * 1024


def _plain(value: object) -> str:
    """A field's value on one line."""
    return " ".join(str(value or "").split())


def escape(value: str) -> str:
    """Text for a BibTeX field in braces, with LaTeX's special characters escaped. Unicode (accents,
    Japanese) is kept as it is: the file is UTF-8, as biber and upBibTeX read it."""
    return _ESCAPE.sub(lambda match: _ESCAPES[match[0]], _plain(value))


def _ascii_words(value: str) -> list[str]:
    """The ASCII letters and digits of `value`, by word: accents are dropped (Müller → muller), and
    words in other scripts (Japanese) leave nothing."""
    folded = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower()
    return [word for word in (re.sub(r"[^a-z0-9]", "", part) for part in re.split(r"[\s/-]+", folded)) if word]


def _author_names(value: str) -> tuple[list[str], bool]:
    """The names in an author field, without Jr./Sr./II…, and whether it ends with "et al." (more authors)."""
    value = _plain(value)
    more = bool(_ET_AL.search(value))
    names = [_NAME_SUFFIX.sub("", name).strip(" ,") for name in _AUTHOR_SEPARATOR.split(_ET_AL.sub("", value))]
    names = [name for name in names if name]
    # "and others" typed as the last name is BibTeX's own spelling of the same.
    if names and names[-1].lower() == "others":
        names, more = names[:-1], True
    return names, more


def _surname(author: str) -> str:
    """The first author's family name: before the comma of "Smith, Jane", else the last word."""
    names, _more = _author_names(author)
    first = names[0] if names else ""
    if "," in first:
        return first.split(",")[0]
    words = first.split()
    return words[-1] if words else ""


def citation_key(paper: dict) -> str:
    """First author's family name, year and first word of the title, in ASCII (smith2020deep).

    A part without ASCII letters (a Japanese name or title) is left out; with none of them, "paper".
    """
    surname = "".join(_ascii_words(_surname(_plain(paper.get("first_author")))))
    year = _plain(paper.get("publication_year"))
    year = year if re.fullmatch(r"\d{4}", year) else ""
    word = next((w for w in _ascii_words(_plain(paper.get("title"))) if w not in _STOP_WORDS and not w.isdigit()), "")
    key = f"{surname}{year}{word}"[:60]
    return key if surname or word else f"paper{year}"


def citation_keys(papers: list[dict]) -> list[str]:
    """A key for each paper, in order (oldest first). Of papers that would share a key, the first keeps it
    and the later ones get -a, -b, -c… after it. A key itself has only a–z and 0–9, so the hyphen keeps
    these apart from every other paper's key: adding a paper changes no key given before it."""
    keys = [citation_key(paper) for paper in papers]
    counts: dict[str, int] = {}
    result = []
    for key in keys:
        index = counts.get(key, 0)
        counts[key] = index + 1
        result.append(key if not index else f"{key}-{_suffix(index - 1)}")
    return result


def _suffix(index: int) -> str:
    """a, b, …, z, aa, ab, …"""
    letters = ""
    index += 1
    while index:
        index, rest = divmod(index - 1, 26)
        letters = chr(ord("a") + rest) + letters
    return letters


def _authors(value: str) -> str:
    names, more = _author_names(value)
    return " and ".join([*map(escape, names), *(["others"] if more and names else [])])


def entry(paper: dict, key: str) -> str:
    """One entry: @inproceedings for a venue that is a conference or workshop, @article for another venue,
    and @misc for a paper without one (with its arXiv identifier as eprint when known)."""
    title = _plain(paper.get("title")) or _plain(paper.get("original_name"))
    venue = _plain(paper.get("venue"))
    doi = clean_doi(_plain(paper.get("doi")))
    arxiv = clean_arxiv_id(_plain(paper.get("arxiv_id")))
    year = _plain(paper.get("publication_year"))
    if venue:
        kind, venue_field = ("inproceedings", "booktitle") if _PROCEEDINGS.search(venue) else ("article", "journal")
    else:
        kind, venue_field = "misc", ""
    # The title in double braces keeps its capitals (and a Japanese title as it is) in every style.
    fields = [("title", "{" + escape(title) + "}")]
    authors = _authors(_plain(paper.get("first_author")))
    if authors:
        fields.append(("author", authors))
    if venue_field:
        fields.append((venue_field, escape(venue)))
    if re.fullmatch(r"\d{4}", year):
        fields.append(("year", year))
    # Identifiers are copied as they are, not escaped: this file is meant for biblatex, which reads doi and
    # eprint verbatim (a "_" or "%" in a DOI stays as it is). Classic BibTeX styles that print the doi
    # field as plain text would need \_ there instead. Both were checked to hold no space or brace.
    if doi:
        fields.append(("doi", doi))
    if arxiv:
        fields += [("eprint", arxiv), ("archiveprefix", "arXiv")]
    body = ",\n".join(f"  {name} = {{{value}}}" for name, value in fields)
    return f"@{kind}{{{key},\n{body}\n}}\n"


def bibtex(papers: list[dict]) -> str:
    """Entries for `papers`, in order, separated by a blank line."""
    return "\n".join(entry(paper, key) for paper, key in zip(papers, citation_keys(papers)))


def export_bibtex(path: Path, papers: list[dict], library_root: Path) -> int:
    """Write `papers` to the .bib file `path`, outside the library; returns how many were written."""
    if not papers:
        raise ValueError("書き出す論文がありません。")
    if inside_library(path, library_root):
        raise ValueError("ライブラリの外に保存先を選んでください。")
    if path.suffix.lower() != ".bib":
        raise ValueError("保存先には .bib ファイルを指定してください。")
    content = bibtex(papers)
    if len(content.encode("utf-8")) > MAX_BIB_BYTES:
        raise ValueError("BibTeX ファイルが大きすぎます。フォルダーを分けて書き出してください。")
    try:
        atomic_write_text(path, content)
    except OSError as error:
        raise ValueError(f"保存できませんでした: {error}") from error
    return len(papers)
