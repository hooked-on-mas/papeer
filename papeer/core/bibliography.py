"""Conservative bibliographic extraction and shared paper labels.

Everything here reads the PDF itself (its metadata and first page); nothing is looked up online.
"""
import re
import xml.etree.ElementTree as ET

_DC = "{http://purl.org/dc/elements/1.1/}"
_RDF = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}"

# A DOI as printed ("doi:10.1234/abc", "https://doi.org/10.1234/abc"): from "10." to the next space.
# The punctuation of the sentence around it is removed afterwards (clean_doi).
_DOI = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>{}]+)")
# arXiv identifiers only after "arXiv:" or in an arxiv.org link, so that numbers such as 2101.00001 in
# the text are not taken for one: the new form (YYMM.NNNNN) and the old (subject-class/YYMMNNN).
_ARXIV_ID = r"(\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?"
_ARXIV = re.compile(r"(?:\barXiv\s*:\s*|arxiv\.org/(?:abs|pdf)/)" + _ARXIV_ID, re.I)
# The stamp arXiv prints down the side of the paper's own first page: "arXiv:2101.00001v2 [cs.LG] 4 Jan 2021"
# (the old form without the subject class). With its date, so that a citation such as "arXiv:1706.03762 [5]"
# or "arXiv: 1706.03762 [cs.CL], 2017" in the text is not taken for it.
_ARXIV_STAMP = re.compile(r"\barXiv\s*:\s*" + _ARXIV_ID + r"\s*(?:\[[^\]\n]{1,40}\]\s*)?\d{1,2}\s+[A-Z][a-z]{2}\s+(?:19|20)\d{2}\b",
                          re.I)
# Where else the paper's own identifier is: a link to arxiv.org, or arXiv's DOI for it (10.48550/arXiv.…).
_ARXIV_LINK = re.compile(r"(?:arxiv\.org/(?:abs|pdf)/|\b10\.48550/arxiv\.)" + _ARXIV_ID, re.I)
# Lines at the top of the first page where "arXiv:…" names the paper itself (under the title), not a citation.
_ARXIV_HEAD_LINES = 5
_ARXIV_DOI = re.compile(r"10\.48550/arxiv\.(.+)", re.I)
# Where a paper says it appeared, at the start of a line: "Published as a conference paper at ICLR 2021",
# "Accepted to/at/in/for ...", "Accepted for publication in ...", "To appear in ...", "Published in ...".
_VENUE_NOTE = re.compile(
    r"(?im)^[ \t]*(?:published\s+as\s+a\s+(?:conference|workshop|journal)\s+paper\s+(?:at|in)"
    r"|(?:accepted|to\s+appear|published)(?:\s+for\s+publication)?\s+(?:at|in|to|for)"
    r"|appeared\s+in|presented\s+at)[ \t]*[:：]?[ \t]*(?:the\s+)?([^\n]{2,160})$")
# A line naming the journal or the proceedings, as printed in a page header or footer.
_VENUE_LINE = re.compile(r"^(?:(?i:(?:the\s+)?proceedings\s+of)\b"
                         r"|(?:[A-Z][\w&.-]*\s+){0,4}(?i:journal|transactions|letters|annals|review)"
                         r"(?:\s+(?i:of|on|in)\b|(?=\s+\d)))")
# What follows the venue's name on such a line: volume, issue, pages ("120, 123456"), a series and its
# volume after a comma ("PMLR 139"), a year before a comma ("2020, Vol. 48"), and after a comma the date.
_VENUE_TAIL = re.compile(
    r"(?:(?:,\s*|\s+)\(?\s*(?:vol(?:ume)?\.?\s*:?\s*\d|no\.?\s*:?\s*\d|pp\.?\s*\d|pages?\s*\d|\d{1,4}\s*\((?:18|19|20)\d{2}\)"
    r"|\((?:18|19|20)\d{2}\))"
    r"|\s+\d{1,4}\s*,\s*[A-Za-z]?\d+|,\s*(?-i:[A-Z]{2,}[A-Z&/ ]*)\s+\d+\b|\s+(?:18|19|20)\d{2}(?=\s*[,;(])"
    r"|,\s*(?:(?:january|february|march|april|may|june|july|august|september|october|november|december)\b"
    r"|(?:18|19|20)\d{2}\b)).*$", re.I)
# What a venue note names when it gives no name ("Accepted to the main conference").
_NO_VENUE = re.compile(r"(?:main\s+|this\s+)?(?:conference|workshop|journal|symposium|track|proceedings)(?:\s+track)?", re.I)
_DOI_PREFIX = re.compile(r"^(?:doi\s*[:：]\s*|https?://(?:dx\.)?doi\.org/)", re.I)
_SMALL_WORDS = {"a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"}
_ACRONYMS = {"IEEE", "ACM", "SIAM", "IET", "IFAC", "AAAI", "IJCAI", "USENIX", "SPIE", "ASME", "AIAA", "PLOS", "PNAS", "IOP"}


def first_author(value: str) -> str:
    value = re.split(r"\s*(?:;|\band\b|&|、|\n)\s*", value.strip(), maxsplit=1)[0]
    # Preserve the common surname, given-name notation.
    parts = value.split(",")
    if len(parts) > 2 or (len(parts) == 2 and len(parts[0].split()) > 1):
        value = parts[0]
    return " ".join(value.split())


def clean_doi(value: str) -> str:
    """A DOI without "doi:" or the resolver's address before it and the sentence's punctuation after it; "" if none."""
    value = _DOI_PREFIX.sub("", value.strip())
    match = _DOI.match(value)
    if not match:
        return ""
    doi = match[1]
    while doi:
        last = doi[-1]
        # A DOI may contain brackets (10.1016/0021-9991(81)90145-5): only an unmatched closing one goes.
        if last in ".,;:'" or (last in ")]" and doi.count(last) > doi.count("(" if last == ")" else "[")):
            doi = doi[:-1]
        else:
            break
    return doi if _DOI.fullmatch(doi) else ""


def typed_doi(value: str) -> str:
    """A DOI the user typed or pasted, bare ("" for none); ValueError when clean_doi would cut it short.

    Unlike a DOI read from the text, whose end is a guess, a typed one must be whole: a space, <>, {} or
    a quote inside it (old SICI DOIs have <>) would leave part of it out, so it is refused, not saved.
    """
    bare = _DOI_PREFIX.sub("", value.strip())
    if not bare:
        return ""
    doi = clean_doi(bare)
    if not doi:
        raise ValueError("DOIは「10.」で始まる形式（例：10.1000/xyz123）で入力してください。")
    if not bare.startswith(doi) or bare[len(doi):].strip(".,;:)]'\""):
        raise ValueError("DOIに空白・<>・{}・引用符が含まれているため保存できません。DOIだけを入力してください。")
    return doi


def clean_arxiv_id(value: str) -> str:
    """An arXiv identifier (2101.00001, hep-th/9901001) from itself, "arXiv:…", an arxiv.org link or its DOI; "" if none."""
    value = value.strip()
    doi = _ARXIV_DOI.fullmatch(clean_doi(value))
    if doi:
        value = doi[1]
    match = re.fullmatch(r"(?:arxiv\s*:\s*|https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/)?" + _ARXIV_ID + r"(?:\.pdf)?",
                         value, re.I)
    return match[1] if match else ""


def _title_case(value: str) -> str:
    """Title case for a venue printed in capitals (IEEE TRANSACTIONS ON AUTOMATIC CONTROL)."""
    return " ".join(word if word in _ACRONYMS else word.lower() if index and word.lower() in _SMALL_WORDS
                    else word.capitalize() for index, word in enumerate(value.split()))


def clean_venue(value: str) -> str:
    """A journal or proceedings name on one line, in title case if printed in capitals."""
    value = " ".join(value.split()).strip(" ,.;:-–—")
    if value.upper() == value and sum(c.isalpha() for c in value) > 8:
        value = _title_case(value)
    return value[:300]


def _venue(text: str) -> str:
    match = _VENUE_NOTE.search(text)
    if match:
        # "Published in: IEEE Access ( Volume: 8 )": the name, without the volume or the date after it.
        venue = clean_venue(_VENUE_TAIL.sub("", re.split(r"[.;](?:\s|$)", match[1])[0]))
        if venue and not _NO_VENUE.fullmatch(venue):
            return venue
    for line in text.splitlines()[:80]:
        line = " ".join(line.split())
        # Only a line that goes on with a volume, pages or a date, as a header or footer does; not a
        # sentence that happens to start "Letters of…" or "Proceedings of the workshop were…".
        tail = _VENUE_TAIL.search(line)
        if len(line) <= 160 and tail and tail.start() > 0 and _VENUE_LINE.match(line):
            venue = clean_venue(line[:tail.start()])
            # A name, in title case: every word but "of", "the"… starts with a capital (or a digit, "38th").
            if len(venue) >= 8 and all(not word[0].islower() or word.lower() in _SMALL_WORDS for word in venue.split()):
                return venue
    return ""


def extract_identifiers(text: str, metadata: dict | None = None, xmp: str = "") -> dict:
    """DOI, arXiv ID and venue from a paper's first page `text`, its PDF metadata and its XMP metadata.

    What the PDF states about itself (the XMP prism fields and identifier, a DOI in the subject)
    comes first; then the first DOI, the arXiv stamp and a line naming the venue on the first page.
    What is not found is "", for the user to fill in.
    """
    metadata = metadata or {}
    doi = venue = ""
    try:
        root = ET.fromstring(xmp or "<root/>")
    except ET.ParseError:
        root = ET.Element("root")
    for element in root.iter():
        # prism:doi and prism:publicationName, as elements or as attributes of rdf:Description.
        values = [(element.tag, element.text or ""), *element.attrib.items()]
        for tag, value in values:
            namespace, _, name = tag.rpartition("}")
            if "prismstandard.org" not in namespace:
                continue
            if name == "doi" and not doi:
                doi = clean_doi(value)
            elif name == "publicationName" and not venue:
                venue = clean_venue(value)
    if not doi:
        for element in root.iter(f"{_DC}identifier"):
            texts = [element.text or ""] + [item.text or "" for item in element.iter(f"{_RDF}li")]
            doi = next((found for found in map(clean_doi, texts) if found), "")
            if doi:
                break
    subject = str(metadata.get("subject") or "")
    described = f"{subject} {metadata.get('keywords') or ''}"
    if not doi:
        match = _DOI.search(described)
        doi = clean_doi(match[1]) if match else ""
        if doi and not venue:
            # Publishers write "Journal Name, 123 (2021) 109456. doi:10...." into the subject.
            match = re.match(r"\s*([^,\d\n]{3,80}?)\s*,?\s*(?:vol\.?\s*)?\d", subject, re.I)
            if match and not re.search(r"doi|https?:", match[1], re.I):
                venue = clean_venue(match[1])
    if not doi:
        match = _DOI.search(text)
        doi = clean_doi(match[1]) if match else ""
    # Not the first "arXiv:" anywhere on the page, which is as likely a paper the text cites (and would
    # give the publication year too, extract_bibliography).
    head = "\n".join(text.splitlines()[:_ARXIV_HEAD_LINES])
    match = (_ARXIV_STAMP.search(text) or _ARXIV.search(head) or _ARXIV_LINK.search(text)
             or _ARXIV.search(described))
    arxiv = match[1] if match else clean_arxiv_id(doi) if doi else ""
    return {"doi": doi, "arxiv_id": arxiv, "venue": venue or _venue(text)}


def extract_bibliography(document) -> dict:
    author = (document.metadata or {}).get("author", "") or ""
    year = ""
    xmp = document.get_xml_metadata() or ""
    try:
        root = ET.fromstring(xmp or "<root/>")
        creators = root.findall(f".//{_DC}creator//{_RDF}li")
        if creators:
            author = creators[0].text or author
        for date in root.findall(f".//{_DC}date//{_RDF}li"):
            match = re.match(r"\s*((?:18|19|20)\d{2})\b", date.text or "")
            if match:
                year = match[1]
                break
    except ET.ParseError:
        pass
    text = document[0].get_text() if document.page_count else ""
    if not author:
        match = re.search(r"(?im)^\s*(?:Authors?|著者)\s*[:：]\s*([^\n]+)", text)
        if match:
            author = match[1]
    if not year:
        # File creation/modification dates need not be publication dates.
        match = re.search(r"(?:©|Copyright|Published|出版|発行)[^\n\d]{0,60}((?:18|19|20)\d{2})\b", text, re.I)
        if match:
            year = match[1]
    identifiers = extract_identifiers(text, document.metadata, xmp)
    if not year:
        # A new-style arXiv identifier starts with the year and month it was submitted (2101.00001, from 2007).
        match = re.fullmatch(r"(\d{2})(\d{2})\.\d{4,5}", identifiers["arxiv_id"])
        if match and int(match[1]) >= 7 and 1 <= int(match[2]) <= 12:
            year = f"20{match[1]}"
    return {"first_author": first_author(author), "publication_year": year, **identifiers}


def paper_display_name(paper: dict) -> str:
    author = (paper.get("first_author") or "").strip()
    year = (paper.get("publication_year") or "").strip()
    prefix = " ".join(part for part in (author, f"({year})" if year else "") if part)
    title = paper.get("title") or paper.get("original_name") or ""
    return f"{prefix} {title}" if prefix else title
