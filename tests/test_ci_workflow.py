"""The CI workflow (.github/workflows/ci.yml): what it checks, where, and that it stays pinned and read-only."""
from __future__ import annotations

from pathlib import Path
import re

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"
# Pull requests from a branch of this repository use the push's result; a manual run is not a pull request.
NOT_OUR_PULL_REQUEST = ("github.event_name != 'pull_request' || "
                        "github.event.pull_request.head.repo.full_name != github.repository")


def _load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def _runs(job: dict) -> list[str]:
    return [step["run"] for step in job["steps"] if "run" in step]


def _platforms(job: dict, macos: bool) -> list[str]:
    """The runners of a job whose matrix is chosen by the manual run's `macos` input."""
    expression = job["strategy"]["matrix"]["os"]
    match = re.fullmatch(r"\$\{\{ fromJSON\(inputs\.macos && '(\[.*?\])' \|\| '(\[.*?\])'\) }}", expression)
    assert match, expression
    return yaml.safe_load(match[1] if macos else match[2])


def test_ci_runs_on_every_push_and_pull_request_and_by_hand_with_a_read_only_token():
    workflow = _load("ci.yml")
    # PyYAML reads the bare key `on` as True.
    assert set(workflow[True]) == {"push", "pull_request", "workflow_dispatch"}
    inputs = workflow[True]["workflow_dispatch"]["inputs"]
    # macOS minutes count ten times on a private repository: never unless asked for.
    assert inputs["macos"]["type"] == "boolean" and inputs["macos"]["default"] is False
    assert inputs["sidecar"]["type"] == "boolean"
    assert inputs["licenses"]["type"] == "boolean" and inputs["licenses"]["default"] is False
    assert workflow["permissions"] == {"contents": "read"}
    # Every commit on main keeps its result; a newer push to another branch cancels the older run, and a
    # run by hand is in a group of its own (a push does not cancel it, nor it a push's run).
    assert workflow["concurrency"] == {
        "group": "ci-${{ github.ref == 'refs/heads/main' && github.sha || github.ref }}-${{ github.event_name }}",
        "cancel-in-progress": True}
    jobs = workflow["jobs"]
    assert set(jobs) == {"python", "frontend", "rust", "sidecar", "licenses"}
    for job in jobs.values():
        assert "permissions" not in job
        checkout = next(step for step in job["steps"] if step.get("uses", "").startswith("actions/checkout@"))
        assert checkout["with"]["persist-credentials"] is False
    for name in ("python", "frontend", "rust"):
        assert jobs[name]["if"] == NOT_OUR_PULL_REQUEST


def test_ci_checks_windows_and_linux_on_every_push_and_macos_only_by_hand():
    jobs = _load("ci.yml")["jobs"]
    for name in ("python", "rust"):
        assert _platforms(jobs[name], macos=False) == ["windows-latest", "ubuntu-22.04"]
        assert _platforms(jobs[name], macos=True) == ["windows-latest", "ubuntu-22.04", "macos-latest"]
        assert jobs[name]["runs-on"] == "${{ matrix.os }}" and jobs[name]["strategy"]["fail-fast"] is False
    # Nothing in the frontend's checks depends on the platform.
    assert jobs["frontend"]["runs-on"] == "windows-latest"
    # The sidecar builds only run by hand: both Macs (Apple Silicon and Intel) when macOS is asked for.
    sidecar = jobs["sidecar"]
    assert sidecar["if"] == "github.event_name == 'workflow_dispatch' && inputs.sidecar"
    assert _platforms(sidecar, macos=False) == ["windows-latest", "ubuntu-22.04"]
    assert _platforms(sidecar, macos=True) == ["windows-latest", "ubuntu-22.04", "macos-latest", "macos-15-intel"]


def test_pages_cannot_deploy_without_the_web_browser_regressions():
    pages = _load("pages.yml")
    assert set(pages["jobs"]["deploy"]["needs"]) == {"build", "browser-tests"}
    assert pages["jobs"]["browser-tests"]["uses"] == "./.github/workflows/web-tests.yml"
    web = _load("web-tests.yml")
    assert "workflow_call" in web[True]
    assert web[True]["push"]["branches-ignore"] == ["main"]  # main is run once by Pages.
    assert web["permissions"] == {"contents": "read"}
    browser = web["jobs"]["browser"]
    assert browser["runs-on"] == "windows-latest"
    assert not browser.get("continue-on-error")
    for step in browser["steps"]:
        assert not step.get("continue-on-error")
        if "uses" in step:
            assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", step["uses"])
    runs = _runs(browser)
    assert "node frontend/node_modules/playwright-core/cli.js install webkit" in runs
    regression = next(command for command in runs if "pnpm --dir frontend test:web" in command)
    assert "exit $result" in regression and "$result = $LASTEXITCODE" in regression
    for command in ["uv sync --locked", "pnpm --dir frontend typecheck", "pnpm --dir frontend lint",
                    "pnpm --dir frontend test", "pnpm --dir frontend build:web"]:
        assert runs.index(command) < runs.index(regression)
    # Changes to the gate or to PC export/import must also run the release gate on main.
    for path in ["frontend/**", ".github/workflows/web-tests.yml", "papeer/**", "sidecar/schemas/ink.py", "uv.lock"]:
        assert path in pages[True]["push"]["paths"] and path in web[True]["pull_request"]["paths"]


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
    # The OCR tests run on CI: the language data is downloaded when the cache has none, and a failed
    # download fails them (tests/conftest.py tessdata) instead of skipping them unnoticed.
    pytest_step = next(step for step in jobs["python"]["steps"] if step.get("run") == "uv run pytest -q")
    assert pytest_step["env"]["PAPEER_TEST_DOWNLOAD_TESSDATA"] == "1"
    cache = next(step for step in jobs["python"]["steps"]
                 if step.get("with", {}).get("path") == ".pytest_cache/d/papeer-tessdata")
    assert jobs["python"]["steps"].index(cache) < jobs["python"]["steps"].index(pytest_step)
    assert _runs(jobs["frontend"]) == ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm lint", "pnpm test",
                                       "pnpm build", "pnpm build:web"]
    rust = jobs["rust"]
    runs = _runs(rust)
    assert runs[1:] == ["cargo fmt --check", "cargo clippy --release --all-targets -- -D warnings",
                        "cargo test --release"]
    # What Tauri needs on Linux, installed on the Linux runner only.
    linux = rust["steps"][[step.get("run") for step in rust["steps"]].index(runs[0])]
    assert linux["if"] == "runner.os == 'Linux'" and "libwebkit2gtk-4.1-dev" in linux["run"]
    # Without the onedir sidecar folder (made by `just build-sidecar`), tauri-build fails on bundle.resources;
    # `just clippy`, `just e2e` and `just dev-frontend` drop it the same way.
    assert rust["env"]["TAURI_CONFIG"] == '{"bundle":{"resources":[]}}'
    justfile = (ROOT / "justfile").read_text("utf-8")
    assert justfile.count("[env('TAURI_CONFIG', '" + rust["env"]["TAURI_CONFIG"] + "')]") == 3


def test_the_sidecar_is_built_as_the_release_builds_it_then_started_as_the_app_starts_it():
    sidecar = _load("ci.yml")["jobs"]["sidecar"]
    runs = _runs(sidecar)
    assert runs.index("uv sync --locked --all-groups") < runs.index("just build-sidecar")
    assert runs[-1] == "cargo test --release sidecar -- --ignored"
    assert "TAURI_CONFIG" not in sidecar.get("env", {})  # The built sidecar folder is there.


def test_the_license_inventories_of_linux_and_macos_are_made_on_them_by_hand():
    licenses = _load("ci.yml")["jobs"]["licenses"]
    assert licenses["if"] == "github.event_name == 'workflow_dispatch' && inputs.licenses"
    # Windows' inventory is made on a Windows PC (just licenses); the others only on their own runners.
    assert _platforms(licenses, macos=False) == ["ubuntu-22.04"]
    assert _platforms(licenses, macos=True) == ["ubuntu-22.04", "macos-latest", "macos-15-intel"]
    runs = _runs(licenses)
    # Everything the inventory reads offline is installed first.
    for command in ("uv sync --locked --all-groups", "pnpm --dir frontend install --frozen-lockfile",
                    "cargo fetch --locked --manifest-path frontend/src-tauri/Cargo.toml"):
        assert runs.index(command) < runs.index("uv run python tools/license_inventory.py")
    upload = next(step for step in licenses["steps"] if step.get("uses", "").startswith("actions/upload-artifact@"))
    assert upload["with"]["path"] == "docs/dependency-license-inventory.*.json"


def test_the_justfile_sets_variables_the_same_way_in_every_shell():
    # PowerShell on Windows, sh elsewhere: no `$env:NAME = ...;` (PowerShell) nor `NAME=... cmd` (sh).
    justfile = (ROOT / "justfile").read_text("utf-8")
    assert "$env:" not in justfile
    assert "[env('PAPEER_TOKEN', 'dev_token')]" in justfile
    # tools/stop_stale_dev.ps1 only on Windows.
    recipes = re.findall(r"^((?:\[[^\n]*\]\n)*)stop-stale-dev args:", justfile, re.M)
    assert sorted("[windows]" in attributes for attributes in recipes) == [False, True]
