"""The CI workflow (.github/workflows/ci.yml): what it checks, and that it stays pinned and read-only."""
from __future__ import annotations

from pathlib import Path
import re

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"


def _load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def _runs(job: dict) -> list[str]:
    return [step["run"] for step in job["steps"] if "run" in step]


def test_ci_runs_on_every_push_and_pull_request_with_a_read_only_token():
    workflow = _load("ci.yml")
    # PyYAML reads the bare key `on` as True.
    assert set(workflow[True]) == {"push", "pull_request"}
    assert workflow["permissions"] == {"contents": "read"}
    # Every commit on main keeps its result; a newer push to another branch cancels the older run.
    assert workflow["concurrency"] == {"group": "ci-${{ github.ref == 'refs/heads/main' && github.sha || github.ref }}",
                                       "cancel-in-progress": True}
    jobs = workflow["jobs"]
    assert set(jobs) == {"python", "frontend", "rust"}
    for job in jobs.values():
        assert job["runs-on"] == "windows-latest" and "permissions" not in job
        checkout = next(step for step in job["steps"] if step.get("uses", "").startswith("actions/checkout@"))
        assert checkout["with"]["persist-credentials"] is False


def test_ci_pins_actions_to_the_same_commits_as_the_release():
    release = _load("release.yml")
    pinned = {step["uses"].split("@")[0]: step["uses"]
              for job in release["jobs"].values() for step in job["steps"] if "uses" in step}
    for job in _load("ci.yml")["jobs"].values():
        for step in job["steps"]:
            if "uses" in step:
                assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", step["uses"]), step["uses"]
                assert pinned.get(step["uses"].split("@")[0], step["uses"]) == step["uses"]


def test_ci_runs_the_checks_of_just_test_and_just_lint():
    jobs = _load("ci.yml")["jobs"]
    python = _runs(jobs["python"])
    assert python[0] == "uv sync --locked"
    for command in ("uv run ruff check papeer sidecar tests tools", "uv run pyright",
                    "uv run python tools/export_openapi.py --check", "uv run python tools/license_inventory.py --check"):
        assert command in python
    # pytest comes after pnpm install, so that the schema.d.ts test (tests/test_openapi_schema.py) is not skipped.
    assert python.index("pnpm --dir frontend install --frozen-lockfile") < python.index("uv run pytest -q")
    assert _runs(jobs["frontend"]) == ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm lint", "pnpm test",
                                       "pnpm build"]
    rust = jobs["rust"]
    assert _runs(rust) == ["cargo fmt --check", "cargo clippy --release --all-targets -- -D warnings",
                           "cargo test --release"]
    # Without the sidecar exe (made by `just build-sidecar`), tauri-build fails on the externalBin entry.
    assert rust["env"]["TAURI_CONFIG"] == '{"bundle":{"externalBin":[]}}'
