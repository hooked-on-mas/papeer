"""Download a public PDF without exposing local services, then use the library's importer."""
from __future__ import annotations

import http.client
import ipaddress
from pathlib import Path
import socket
import ssl
import threading
import time
import unicodedata
from urllib.parse import urljoin, urlsplit

import pymupdf as fitz

from papeer.core.web_research import public_url
from papeer.providers import check_cancel
from papeer.pdf.pdf_engine import PDF_LOCK

MAX_PDF_BYTES = 100 * 1024 * 1024


def public_addresses(host: str, port: int) -> list[str]:
    addresses = list(dict.fromkeys(str(item[4][0]) for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)))
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError("公開インターネット上のPDFだけを取り込めます。")
    return addresses


class _PinnedHTTPS(http.client.HTTPSConnection):
    """Connect to an address already checked; TLS still checks the original hostname."""
    def __init__(self, host: str, address: str, port: int):
        super().__init__(host, port, timeout=15, context=ssl.create_default_context())
        self.address = address
        self.tls_context = ssl.create_default_context()

    def connect(self) -> None:
        self.sock = socket.create_connection((self.address, self.port), self.timeout)
        self.sock = self.tls_context.wrap_socket(self.sock, server_hostname=self.host)


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, host: str, address: str, port: int):
        super().__init__(host, port, timeout=15)
        self.address = address

    def connect(self) -> None:
        self.sock = socket.create_connection((self.address, self.port), self.timeout)


def download_pdf(url: str, destination: Path, cancel: threading.Event, progress, *,
                 max_bytes: int = MAX_PDF_BYTES, timeout_seconds: float = 120) -> str:
    """Every redirect is checked too; no credentials, proxy or browser cookies are sent."""
    deadline = time.monotonic() + timeout_seconds
    for _ in range(6):
        check_cancel(cancel)
        if not public_url(url):
            raise ValueError("PDFのURLが不正です。")
        parts = urlsplit(url)
        host = (parts.hostname or "").encode("idna").decode("ascii")
        port = parts.port or (443 if parts.scheme == "https" else 80)
        addresses = public_addresses(host, port)
        connection = (_PinnedHTTPS if parts.scheme == "https" else _PinnedHTTP)(host, addresses[0], port)
        try:
            connection.request("GET", (parts.path or "/") + ("?" + parts.query if parts.query else ""),
                               headers={"User-Agent": "Papeer/ReferencePDF", "Accept": "application/pdf"})
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                target = response.getheader("Location")
                if not target:
                    raise ValueError("PDFの転送先が見つかりません。")
                url = urljoin(url, target)
                continue
            if response.status != 200:
                raise ValueError(f"PDFを取得できませんでした（HTTP {response.status}）。公開元を開くか、手元のPDFを選んでください。")
            length = response.getheader("Content-Length")
            if length and int(length) > max_bytes:
                raise ValueError(f"PDFのサイズが確認上限（{max_bytes // (1024 * 1024)}MB）を超えています。")
            size = 0
            with destination.open("wb") as stream:
                while True:
                    check_cancel(cancel)
                    if time.monotonic() > deadline:
                        raise ValueError("PDFの取得に時間がかかっています。公開元から保存して、手元のPDFを選んでください。")
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise ValueError(f"PDFのサイズが確認上限（{max_bytes // (1024 * 1024)}MB）を超えています。")
                    stream.write(chunk)
                    progress(f"PDFを取得中… {size // 1024} KB")
        finally:
            connection.close()
        validate_pdf(destination)
        return url
    raise ValueError("PDFの転送回数が多すぎます。公開元から取得してください。")


def validate_pdf(path: Path) -> None:
    if not path.is_file() or path.stat().st_size > MAX_PDF_BYTES:
        raise ValueError("PDFが存在しないか、100MBを超えています。")
    # A PDF can contain a short leading header; an HTML login page cannot be imported.
    with path.open("rb") as stream:
        if b"%PDF-" not in stream.read(1024):
            raise ValueError("取得したファイルはPDFではありません。公開元からPDFを保存し、手元のPDFを選んでください。")
    try:
        with PDF_LOCK, fitz.open(path) as document:
            if not document.is_pdf or document.needs_pass or not len(document):
                raise ValueError("空のPDFやパスワード付きPDFは取り込めません。")
    except (RuntimeError, fitz.FileDataError) as exc:
        raise ValueError("PDFを読み取れませんでした。公開元から取得し直してください。") from exc


def validate_reference_identity(path: Path, title: str, doi: str = "") -> None:
    """A downloadable PDF may still be a different paper or a whole report containing it."""
    def normalized(value: str) -> str:
        return "".join(c for c in unicodedata.normalize("NFKC", value).casefold() if c.isalnum())

    with PDF_LOCK, fitz.open(path) as document:
        # Covers sometimes precede the title page. Do not accept a citation buried later in a report.
        opening = normalized("\n".join(str(document[i].get_text()) for i in range(min(2, len(document)))))
    known_title, known_doi = normalized(title), normalized(doi)
    if ((len(known_title) >= 15 and known_title in opening)
            or (known_doi and known_doi in opening)):
        return
    raise ValueError("PDFの冒頭で、この文献のタイトル・DOIを確認できませんでした。別の資料の可能性があるため取り込み候補から外しました。")
