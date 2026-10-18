"""The API schema the frontend's types are made from (`just gen-api`): frontend/openapi.json is what the
sidecar's app.openapi() says, and frontend/src/api/schema.d.ts what openapi-typescript makes of that file."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import pytest

from tools import export_openapi

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SCHEMA_TS = FRONTEND / "src/api/schema.d.ts"
GENERATOR = FRONTEND / "node_modules/openapi-typescript/bin/cli.js"
# How package.json's gen-api script runs the generator; the options in between are passed on as they are.
SCRIPT_START, SCRIPT_END = "openapi-typescript openapi.json", "-o src/api/schema.d.ts"


def test_committed_openapi_json_is_the_sidecars_schema():
    committed = export_openapi.OPENAPI_JSON.read_bytes().decode("utf-8")
    assert committed == export_openapi.openapi_text(), "`just gen-api` で frontend/openapi.json を作り直してください。"
    assert export_openapi.main(["--check"]) == 0


def test_export_writes_the_file_it_checks(tmp_path, monkeypatch):
    target = tmp_path / "openapi.json"
    monkeypatch.setattr(export_openapi, "OPENAPI_JSON", target)
    assert export_openapi.main(["--check"]) == 1  # Missing.
    assert export_openapi.main([]) == 0
    assert target.read_bytes() == export_openapi.openapi_text().encode("utf-8")
    assert b"\r\n" not in target.read_bytes()
    assert export_openapi.main(["--check"]) == 0
    target.write_text("{}", "utf-8")
    assert export_openapi.main(["--check"]) == 1


def test_the_schema_names_the_models_the_frontend_types_come_from():
    schemas = json.loads(export_openapi.openapi_text())["components"]["schemas"]
    for name in ("PaperRow", "Paper", "ReadingState", "TranslationReport", "TranslationPreview", "OcrPage", "StickyNote",
                 "LibraryStickyNote", "Article", "ChatMessage", "JobStarted", "JobInfo", "ServerEvent", "UsageLimits",
                 "ProviderOption", "ProviderSpecModel", "SettingsResponse", "SettingsModel"):
        assert name in schemas, name
    # A translation report keeps keys the model does not name; the frontend types say so.
    assert schemas["TranslationReport"]["additionalProperties"] is True
    assert "required" not in schemas["TranslationReport"]


def _generator_arguments() -> list[str]:
    script = json.loads((FRONTEND / "package.json").read_text("utf-8"))["scripts"]["gen-api"]
    assert script.startswith(SCRIPT_START) and script.endswith(SCRIPT_END), script
    return ["openapi.json", *script[len(SCRIPT_START):-len(SCRIPT_END)].split()]


def test_committed_schema_types_are_made_from_openapi_json(tmp_path):
    arguments = _generator_arguments()
    node = shutil.which("node")
    if node is None or not GENERATOR.is_file():
        pytest.skip("Node.js か frontend の依存（pnpm install）がないため schema.d.ts を作り直して比べられません。")
    output = tmp_path / "schema.d.ts"
    subprocess.run([node, str(GENERATOR), *arguments, "-o", str(output)], cwd=FRONTEND, check=True,
                   capture_output=True, timeout=120)
    assert SCHEMA_TS.read_bytes() == output.read_bytes(), "`just gen-api` で schema.d.ts を作り直してください。"
