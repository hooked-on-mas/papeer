"""Manually check public OAuth requirements and CORS without real credentials or inference.

Run: uv run python tools/probe_chatgpt_browser.py
This is a live diagnostic, not an offline CI test. Response bodies, cookies, authorization
URLs and tokens are never written. A preflight or an invalid-code response cannot establish
that a valid browser OAuth grant is supported.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import secrets
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen
import uuid

ORIGIN = "https://hooked-on-mas.github.io"
DOCS = "https://developers.openai.com/siwc/"
TOKEN = "https://auth.openai.com/api/accounts/oauth/token"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe(label: str, url: str, method: str, headers: dict[str, str], data: bytes | None = None) -> dict:
    opener = build_opener(NoRedirect())
    try:
        response = opener.open(Request(url, method=method, headers=headers, data=data), timeout=20)
    except HTTPError as error:
        response = error
    except (URLError, TimeoutError, OSError) as error:
        return {"check": label, "network_error": type(error).__name__}
    with response:
        result = {"check": label, "http_status": response.status}
        for key in ("Access-Control-Allow-Origin", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers"):
            result[key] = response.headers.get(key)
        # Only classify the known bot challenge. Never retain an OAuth response or redirect query.
        body = response.read(262144)
        result["bot_challenge"] = b"Just a moment..." in body
        location = response.headers.get("Location")
        if location:
            parsed = urlparse(location)
            result["redirect_host"] = parsed.hostname
            result["redirect_path"] = parsed.path
        return result


def requirements() -> list[dict]:
    checks = (
        ("token-sharing-open-source/sign-in", (
            ("loopback_callback_required", "Use an HTTP loopback callback on `127.0.0.1`"),
            ("only_callback_port_may_vary", "only the port may vary"),
        )),
        ("token-sharing-open-source/profiles-and-sessions", (
            ("tokens_outside_browser_storage", "Keep tokens out of browser storage"),
        )),
        ("website", (
            ("website_guide_identity_only", "This guide covers identity scopes"),
            ("website_backend_required", "A backend that can hold short-lived transaction state"),
        )),
    )
    results = []
    for path, phrases in checks:
        url = DOCS + path
        try:
            with urlopen(url + ".md", timeout=20) as response:
                body = response.read()
            content = " ".join(body.decode("utf-8").split())
            results.append({"source": url, "sha256": hashlib.sha256(body).hexdigest(),
                            "statements_present": {name: phrase in content for name, phrase in phrases}})
        except (URLError, TimeoutError, OSError, UnicodeError) as error:
            results.append({"source": url, "network_error": type(error).__name__})
    return results


def authorization_entry(callback: str) -> str:
    verifier = secrets.token_urlsafe(48)
    values = {
        "client_id": "dynamic_agent_client", "agent_name_hint": "Papeer",
        "ext_agent_host_id": "urn:uuid:" + str(uuid.uuid4()), "response_type": "code",
        "redirect_uri": callback,
        "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        "resource": "https://api.openai.com/v1", "state": secrets.token_urlsafe(32),
        "nonce": secrets.token_urlsafe(32), "code_challenge_method": "S256",
        "code_challenge": base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode(),
    }
    return "https://auth.openai.com/api/accounts/authorize?" + urlencode(values)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--authorization-entry", action="store_true", help="Also compare anonymous authorization entrypoints.")
    parser.add_argument("--output", type=Path, default=Path("output/chatgpt-browser-probe.json"))
    args = parser.parse_args()
    network = [
        probe("token-preflight", TOKEN, "OPTIONS", {
            "Origin": ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type",
        }),
        probe("responses-preflight", "https://api.openai.com/v1/responses", "OPTIONS", {
            "Origin": ORIGIN, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        }),
        probe("token-deliberately-invalid-code", TOKEN, "POST", {
            "Origin": ORIGIN, "Content-Type": "application/x-www-form-urlencoded",
        }, urlencode({
            "grant_type": "authorization_code", "client_id": "papeer_browser_probe_invalid_client",
            "code": "deliberately_invalid_probe_code", "code_verifier": "p" * 64,
            "redirect_uri": ORIGIN + "/papeer/auth/callback", "resource": "https://api.openai.com/v1",
        }).encode()),
    ]
    if args.authorization_entry:
        for name, callback in (("pages-https", ORIGIN + "/papeer/auth/callback"),
                               ("documented-loopback", "http://127.0.0.1:1455/auth/callback")):
            network.append(probe(name, authorization_entry(callback), "GET", {"User-Agent": "Mozilla/5.0"}))
    report = {"checked_at_utc": datetime.now(timezone.utc).isoformat(), "origin": ORIGIN,
              "uses_real_credentials": False, "performs_inference": False,
              "documentation": requirements(), "network": network,
              "scope": "Public contract and anonymous HTTP observations; no completed OAuth grant or iPad device test."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
