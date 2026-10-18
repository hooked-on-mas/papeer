"""Write the sidecar's API schema to frontend/openapi.json, which the frontend's types are made from.

  uv run python tools/export_openapi.py          # write frontend/openapi.json
  uv run python tools/export_openapi.py --check  # only compare (exit 1 if the file differs from the sidecar's)

`just gen-api` runs this, then openapi-typescript turns the file into frontend/src/api/schema.d.ts
(README「API の型」). The sidecar never serves its schema (openapi_url=None, so it is not open without
the token), so it is taken from app.openapi() directly: the routes' models, and the events of /ws/events.
tests/test_openapi_schema.py checks that both files match the sidecar.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    # `python tools/export_openapi.py` puts only tools/ on the path.
    sys.path.append(str(ROOT))

OPENAPI_JSON = ROOT / "frontend" / "openapi.json"


def openapi_text() -> str:
    """The schema as the file holds it: two-space indents, non-ASCII escaped, a final newline."""
    from sidecar.app import app

    return json.dumps(app.openapi(), indent=2) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="compare only; exit 1 if frontend/openapi.json differs")
    args = parser.parse_args(argv)
    text = openapi_text()
    current = OPENAPI_JSON.read_bytes().decode("utf-8") if OPENAPI_JSON.is_file() else None
    if args.check:
        if current != text:
            print("frontend/openapi.json が sidecar の API と一致しません。`just gen-api` で作り直してください。",
                  file=sys.stderr)
            return 1
        return 0
    if current != text:
        # Bytes, so the file keeps LF line endings on Windows too.
        OPENAPI_JSON.write_bytes(text.encode("utf-8"))
        shown = OPENAPI_JSON.relative_to(ROOT).as_posix() if OPENAPI_JSON.is_relative_to(ROOT) else OPENAPI_JSON
        print(f"{shown} を書き出しました。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
