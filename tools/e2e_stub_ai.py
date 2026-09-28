"""The stand-in AI for the end-to-end tests (frontend/e2e, `just e2e`).

An OpenAI-compatible server on 127.0.0.1 that answers like the one in tools/smoke_sidecar.py
(stub_answer), so the tests translate through the real sidecar without calling a real AI and
without anything leaving the PC. It also answers the glossary draft (用語抽出) with a few words
of the source, and has two routes for the tests themselves:

- POST /_e2e/delay {"seconds": 1.5}: wait that long before each chat answer (to catch a job while it runs)
- GET /_e2e/requests: how many chat requests came in, by kind ({"translation": 3, "glossary": 1, "other": 0})

Run with `python tools/e2e_stub_ai.py`; it prints "PORT <n>" once it listens on a free port.
"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sys
import threading
import time
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))

from tools.smoke_sidecar import stub_answer  # noqa: E402

# papeer.core.reading_tools sends {"source": ..., "existing_terms": [...]} for the glossary draft.
GLOSSARY_MARKER = '"existing_terms"'
GLOSSARY_TERMS = 6


def glossary_answer(data: str) -> str:
    """A glossary draft of the first long words of the source, each with a made-up translation."""
    source = str(json.loads(data).get("source", ""))
    words: list[str] = []
    for word in re.findall(r"[A-Za-z][A-Za-z-]{6,}", source):
        if word.lower() not in {w.lower() for w in words}:
            words.append(word)
        if len(words) >= GLOSSARY_TERMS:
            break
    return json.dumps({"terms": [{"source": w, "target": f"訳語{i + 1}"} for i, w in enumerate(words)]},
                      ensure_ascii=False)


def answer(messages: list[dict[str, Any]]) -> tuple[str, str]:
    """(kind, content) for a chat request: kind is "glossary", "translation" or "other"."""
    instruction, data = str(messages[0]["content"]), str(messages[-1]["content"])
    if GLOSSARY_MARKER in data:
        return "glossary", glossary_answer(data)
    kind = "translation" if '"blocks"' in data or '"texts"' in data else "other"
    return kind, stub_answer(instruction, data)


class StubState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.delay = 0.0
        self.counts = {"translation": 0, "glossary": 0, "other": 0}


def make_handler(state: StubState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def _send_json(self, value: Any, status: int = 200) -> None:
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler's naming)
            if self.path.endswith("/models"):
                self._send_json({"data": [{"id": "papeer-e2e-stub"}]})
            elif self.path == "/_e2e/requests":
                with state.lock:
                    self._send_json(dict(state.counts))
            else:
                self.send_error(404)

        def do_POST(self) -> None:  # noqa: N802
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            if self.path == "/_e2e/delay":
                with state.lock:
                    state.delay = max(0.0, float(json.loads(body or b"{}").get("seconds", 0)))
                self._send_json({"delay": state.delay})
                return
            if not self.path.endswith("/chat/completions"):
                self.send_error(404)
                return
            try:
                kind, content = answer(json.loads(body)["messages"])
            except (ValueError, KeyError, IndexError, TypeError) as exc:
                self.send_error(400, str(exc))
                return
            with state.lock:
                state.counts[kind] += 1
                delay = state.delay
            time.sleep(delay)
            try:
                self._send_json({"choices": [{"message": {"role": "assistant", "content": content},
                                              "finish_reason": "stop"}],
                                 "usage": {"prompt_tokens": 1, "completion_tokens": 1}})
            except OSError:
                pass  # The sidecar gave up on the request (a cancelled job): nothing to answer.

        def log_message(self, format: str, *args: Any) -> None:
            pass

    return Handler


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(StubState()))
    print(f"PORT {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
