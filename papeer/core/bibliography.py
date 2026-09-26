"""Conservative bibliographic extraction and shared paper labels."""
import re
import xml.etree.ElementTree as ET


def first_author(value: str) -> str:
    value = re.split(r"\s*(?:;|\band\b|&|、|\n)\s*", value.strip(), maxsplit=1)[0]
    # Preserve the common surname, given-name notation.
    parts = value.split(",")
    if len(parts) > 2 or (len(parts) == 2 and len(parts[0].split()) > 1):
        value = parts[0]
    return " ".join(value.split())


def extract_bibliography(document) -> dict:
    author = (document.metadata or {}).get("author", "") or ""
    year = ""
    try:
        root = ET.fromstring(document.get_xml_metadata() or "<root/>")
        creators = root.findall(".//{http://purl.org/dc/elements/1.1/}creator//{http://www.w3.org/1999/02/22-rdf-syntax-ns#}li")
        if creators:
            author = creators[0].text or author
        for date in root.findall(".//{http://purl.org/dc/elements/1.1/}date//{http://www.w3.org/1999/02/22-rdf-syntax-ns#}li"):
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
    return {"first_author": first_author(author), "publication_year": year}


def paper_display_name(paper: dict) -> str:
    author = (paper.get("first_author") or "").strip()
    year = (paper.get("publication_year") or "").strip()
    prefix = " ".join(part for part in (author, f"({year})" if year else "") if part)
    title = paper.get("title") or paper.get("original_name") or ""
    return f"{prefix} {title}" if prefix else title
